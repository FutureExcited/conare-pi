import { expect, test } from "bun:test";
import conare from "./conare.js";

/**
 * Structural contract test: feed our extension a mock ExtensionAPI and assert it
 * registers exactly the tools/handlers we promise, with Pi-shaped specs. This
 * pins the public surface so an accidental rename/regression is caught before
 * publish — complementing the tsc check against the real @earendil-works types.
 */
function mockPi() {
  const tools: any[] = [];
  const events: Record<string, Function> = {};
  const api = {
    registerTool: (spec: any) => tools.push(spec),
    on: (event: string, handler: Function) => { events[event] = handler; },
  };
  return { api, tools, events };
}

test("registers the full Conare MCP tool set (recall/search/save/forget)", () => {
  const { api, tools } = mockPi();
  conare(api as any);
  // Must match the MCP server's tools exactly — no `list` (it doesn't exist).
  expect(tools.map((t) => t.name).sort()).toEqual(["forget", "recall", "save", "search"]);
});

test("each tool has a Pi-shaped spec (label, description, TypeBox params, async execute)", () => {
  const { api, tools } = mockPi();
  conare(api as any);
  for (const t of tools) {
    expect(typeof t.label).toBe("string");
    expect(t.description.length).toBeGreaterThan(20);
    // TypeBox schema → an object schema with `properties`.
    expect(t.parameters.type).toBe("object");
    expect(typeof t.execute).toBe("function");
  }
});

test("tool params mirror the MCP server schemas", () => {
  const { api, tools } = mockPi();
  conare(api as any);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // recall: query + the optional author/shallow richer params.
  expect(Object.keys(byName.recall.parameters.properties).sort()).toEqual(["author", "prompt", "query", "shallow"]);
  // search: adds time-range after/before.
  expect(Object.keys(byName.search.parameters.properties).sort()).toEqual(["after", "author", "before", "prompt", "query", "shallow"]);
  expect(Object.keys(byName.save.parameters.properties)).toContain("content");
  expect(Object.keys(byName.forget.parameters.properties)).toContain("memoryId");
});

test("tools-only: registers NO automatic recall hooks (no startup/first-message stall)", () => {
  const { api, events } = mockPi();
  conare(api as any);
  // By design there is no automatic recall — no session_start, no
  // before_agent_start. Memory is reached only when the model calls a tool, so
  // nothing Conare does is ever on Pi's startup or first-message critical path.
  expect(events.session_start).toBeUndefined();
  expect(events.before_agent_start).toBeUndefined();
});

test("execute returns Pi tool-result shape + config guidance with no key (graceful)", async () => {
  // Force "no key" deterministically: clear the env var and point HOME at an
  // empty dir so the ~/.conare/config.json fallback finds nothing. The result
  // must be the guidance string wrapped in Pi's { content:[{type:'text'}] }
  // shape — no throw, no network call (so this can't hang).
  const prevBase = process.env.CONARE_HOME;
  const prevKey = process.env.CONARE_API_KEY;
  process.env.CONARE_HOME = "/conare-test-no-such-home";
  process.env.CONARE_API_KEY = "";
  try {
    const { api, tools } = mockPi();
    conare(api as any);
    const recall = tools.find((t) => t.name === "recall");
    const res = await recall.execute("id", { query: "anything" }, undefined, undefined, {});
    expect(res.content[0].type).toBe("text");
    expect(res.content[0].text).toContain("CONARE_API_KEY");
  } finally {
    if (prevBase === undefined) delete process.env.CONARE_HOME; else process.env.CONARE_HOME = prevBase;
    if (prevKey === undefined) delete process.env.CONARE_API_KEY; else process.env.CONARE_API_KEY = prevKey;
  }
});

// --- Best-practice behaviors: error-throwing + output truncation ---
// These mock global fetch so they're deterministic and never hit the network.
function withKeyAndFetch(impl: (input: any, init: any) => Promise<Response>, fn: () => Promise<void>) {
  const prevKey = process.env.CONARE_API_KEY;
  const realFetch = globalThis.fetch;
  process.env.CONARE_API_KEY = "cmem_test_key";
  globalThis.fetch = impl as typeof fetch;
  return (async () => {
    try { await fn(); }
    finally {
      globalThis.fetch = realFetch;
      if (prevKey === undefined) delete process.env.CONARE_API_KEY; else process.env.CONARE_API_KEY = prevKey;
    }
  })();
}

test("execute THROWS after retry on persistent 5xx (Pi sets isError)", async () => {
  let calls = 0;
  await withKeyAndFetch(
    async () => { calls++; return new Response("nope", { status: 500, statusText: "Internal Server Error" }); },
    async () => {
      const { api, tools } = mockPi();
      conare(api as any);
      const recall = tools.find((t) => t.name === "recall");
      await expect(recall.execute("id", { query: "x" }, undefined, undefined, {})).rejects.toThrow(/HTTP 500/);
    },
  );
  expect(calls).toBe(2); // tried once, retried once, then threw
});

test("retries ONCE on a transient server-side reset, then succeeds", async () => {
  // First call: a DO-reset RPC error (exactly what prod throws after a big
  // write). Second call: success. The model should never see the blip.
  let calls = 0;
  await withKeyAndFetch(
    async () => {
      calls++;
      const body = calls === 1
        ? { jsonrpc: "2.0", id: 1, error: { message: "Internal error in Durable Object storage caused object to be reset" } }
        : { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "recovered context" }] } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
    async () => {
      const { api, tools } = mockPi();
      conare(api as any);
      const recall = tools.find((t) => t.name === "recall");
      const res = await recall.execute("id", { query: "x" }, undefined, undefined, {});
      expect(res.content[0].text).toBe("recovered context");
    },
  );
  expect(calls).toBe(2);
});

test("output is capped at ~50KB so a large recall can't flood context", async () => {
  const huge = "x".repeat(200_000);
  await withKeyAndFetch(
    async () => new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: huge }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
    async () => {
      const { api, tools } = mockPi();
      conare(api as any);
      const recall = tools.find((t) => t.name === "recall");
      const res = await recall.execute("id", { query: "x" }, undefined, undefined, {});
      expect(Buffer.byteLength(res.content[0].text, "utf8")).toBeLessThanOrEqual(50_000);
      expect(res.content[0].text).toContain("truncated by Conare");
    },
  );
});
