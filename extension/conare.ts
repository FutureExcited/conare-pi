/**
 * Conare memory for the Pi coding agent.
 *
 * Pi has no built-in MCP — by design it asks you to add capabilities as
 * extensions. This is that extension: it gives Pi persistent, cross-session
 * memory by talking to the Conare memory engine directly over its MCP HTTP
 * endpoint, and exposes recall/search/save/forget as *native* Pi tools (no
 * proxy, no per-tool token tax) — the same tool set as the Conare MCP server.
 *
 * What it does
 *   • registerTool → `recall`, `search`, `save`, `forget` become first-class
 *                    tools the model can call when memory is relevant. No
 *                    automatic recall — that would put a live synthesis round-
 *                    trip on the critical path (slow first message). Tools-only
 *                    keeps Pi fast; the model decides when to reach for memory.
 *
 * Setup
 *   1. pi install npm:@conare/pi          (or drop this file in ~/.pi/agent/extensions/)
 *   2. Set your key:  export CONARE_API_KEY=cmem_...     (get one at conare.ai)
 *
 * Uses global fetch (Node 20+, which Pi requires) + TypeBox (Pi's own schema
 * library) for the tool parameter schemas.
 *
 * MIT licensed. https://conare.ai
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const conareUrl = () => process.env.CONARE_URL ?? "https://conare.ai";

/**
 * Resolve the Conare API key at CALL time (not module-init, to dodge ESM
 * hoisting if a loader sets the env var before re-exporting). Order:
 *   1. CONARE_API_KEY env var.
 *   2. ~/.conare/config.json — written by the Conare CLI (`bunx conare`), so a
 *      user who already set Conare up for any other agent needs zero extra
 *      config here. This is what makes `pi install npm:@conare/pi` "just work".
 */
function apiKey(): string {
  if (process.env.CONARE_API_KEY) return process.env.CONARE_API_KEY;
  // CONARE_HOME relocates the config dir (mirrors the Conare CLI's own override);
  // os.homedir() is otherwise resolved once at process start, so this is also the
  // only reliable way to point the lookup elsewhere at runtime (e.g. in tests).
  const base = process.env.CONARE_HOME ?? homedir();
  try {
    const cfg = JSON.parse(readFileSync(join(base, ".conare", "config.json"), "utf-8"));
    if (typeof cfg.apiKey === "string") return cfg.apiKey;
  } catch { /* no Conare CLI config — fall through to empty */ }
  return "";
}

/**
 * Cap tool output so a large recall never floods the LLM context. Pi's own
 * built-in tools cap at 50KB; we match that. Self-contained (no Pi runtime
 * dep just for a truncation helper — keeps the extension lean).
 */
const MAX_OUTPUT_BYTES = 50_000;
function cap(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  // Byte-safe slice from the head (recall ranks most-relevant first), then note.
  const note = "\n\n…[truncated by Conare to fit context]";
  let end = MAX_OUTPUT_BYTES - Buffer.byteLength(note, "utf8");
  while (end > 0 && (text.charCodeAt(end) & 0xc0) === 0x80) end--; // don't split a UTF-8 char
  return text.slice(0, end) + note;
}

/**
 * Call a Conare MCP tool over plain HTTP JSON-RPC (the MCP `tools/call` method).
 * Returns the text content. Retries ONCE on a transient error (5xx, network
 * blip, or a server-side reset). THROWS only if the retry also fails, so Pi sets
 * `isError: true` and the model knows. A missing key is NOT an error (nothing
 * to retry) — it returns guidance text instead.
 */
async function callConareTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const key = apiKey();
  if (!key) {
    return "Conare memory is not configured. Set CONARE_API_KEY or run the Conare CLI (conare.ai); proceed without memory for now.";
  }
  try {
    return await callOnce(name, args, key, signal);
  } catch (e) {
    if (signal?.aborted || !isTransient(e)) throw e;
    await new Promise((r) => setTimeout(r, 400)); // brief backoff; server usually recovers fast
    return await callOnce(name, args, key, signal);
  }
}

/** A server-side reset / 5xx / network blip is worth one retry. */
function isTransient(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /HTTP 5\d\d/.test(msg) ||           // server-side 5xx
    /reset|Internal error/i.test(msg) || // transient server-side reset
    /network|fetch failed|ECONNRESET|ETIMEDOUT/i.test(msg)
  );
}

async function callOnce(
  name: string,
  args: Record<string, unknown>,
  key: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(`${conareUrl()}/mcp`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  if (!res.ok) {
    throw new Error(`Conare returned HTTP ${res.status} ${res.statusText}`);
  }

  const payload = await readJsonRpc(res);
  if (payload?.error) {
    throw new Error(`Conare error: ${payload.error.message ?? "unknown"}`);
  }
  const content = payload?.result?.content;
  if (Array.isArray(content)) {
    return cap(
      content
        .map((c: { type?: string; text?: string }) => (c?.type === "text" ? c.text ?? "" : ""))
        .filter(Boolean)
        .join("\n\n")
        .trim(),
    );
  }
  return "";
}

/**
 * The MCP endpoint may answer as a single JSON body or as an SSE stream
 * (`text/event-stream`) carrying one `data:` JSON-RPC message. Handle both so
 * the extension works regardless of how the server negotiates the response.
 */
async function readJsonRpc(res: Response): Promise<{
  result?: { content?: Array<{ type?: string; text?: string }> };
  error?: { message?: string };
} | null> {
  const text = await res.text();
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("data:")) {
        try {
          return JSON.parse(trimmed.slice("data:".length).trim());
        } catch { /* keep scanning for a parseable data line */ }
      }
    }
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Wrap a memory-engine reply in Pi's tool-result shape. */
function toolText(text: string) {
  return { content: [{ type: "text" as const, text: text || "(no result)" }], details: {} };
}

export default function conare(pi: ExtensionAPI): void {
  // ── Native tools ──────────────────────────────────────────────────────────
  // These mirror the Conare MCP server's tool set (recall/search/save/forget)
  // and parameters 1:1, so the model behaves the same in Pi as in every other
  // Conare-connected agent.

  // recall: broad project context at the start of a task. ONCE per conversation.
  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Load this developer's context for the task at hand — what they've built, " +
      "decided, tried and rejected, and why. Call it ONCE when a session starts " +
      "or turns to real work, before exploring a codebase or asking the user to " +
      "re-explain something they've already worked through. It synthesizes " +
      "across the entire corpus, so it answers open questions ('how did X " +
      "evolve', 'why is it built this way') that no single lookup can. For " +
      "narrow mid-task lookups use search instead, not a second recall. Pass " +
      "prompt to steer what the synthesis emphasizes.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "What this task is about — describe it broadly and keyword-dense " +
          "(e.g. 'debugging auth token expiry in the API worker', not 'auth').",
      }),
      prompt: Type.Optional(Type.String({
        description:
          "Steers synthesis (e.g. 'focus on shipped changes and open blockers', " +
          "'preserve all CLI commands verbatim', 'why each decision was made').",
      })),
      author: Type.Optional(Type.String({
        description:
          "TEAM ONLY. Load context from ONE teammate — their name, email, or " +
          "handle, or 'me' for your own. Omit to merge yourself + all teammates.",
      })),
      shallow: Type.Optional(Type.Boolean({
        description:
          "Return raw matching memories instead of a synthesized answer. Only " +
          "for exact-string lookups where you want the unprocessed list.",
      })),
    }),
    async execute(_id, params, signal) {
      return toolText(await callConareTool("recall", params as Record<string, unknown>, signal));
    },
  });

  // search: targeted lookup of a specific topic, AFTER the initial recall.
  pi.registerTool({
    name: "search",
    label: "Search",
    description:
      "Answer a question from the developer's history — it reasons over what it " +
      "retrieves rather than returning a match list, so analytical questions " +
      "work as well as lookups: what was decided and why, how something is " +
      "wired, whether an approach was already tried and rejected, what a person " +
      "said, how something changed over time. Reach for it whenever you need " +
      "project context mid-task, before grepping a repo or asking the user to " +
      "re-explain (use it AFTER the initial recall — never call recall twice). " +
      "Returns dated evidence with sources. Pass prompt to steer synthesis.",
    parameters: Type.Object({
      query: Type.String({
        description:
          "The specific thing you're looking up — a descriptive phrase, not " +
          "keywords (e.g. 'how the billing webhook handles refunds', not 'billing').",
      }),
      prompt: Type.Optional(Type.String({
        description:
          "Steers synthesis (e.g. 'focus on the final decision and why', " +
          "'chronological timeline with dates', 'compare approach X vs Y').",
      })),
      after: Type.Optional(Type.Number({
        description: "Only memories after this Unix ms timestamp (e.g. now - 7*24*60*60*1000 for last week).",
      })),
      before: Type.Optional(Type.Number({ description: "Only memories before this Unix ms timestamp." })),
      author: Type.Optional(Type.String({
        description:
          "TEAM ONLY. Restrict to ONE teammate's memories — name, email, or " +
          "handle, or 'me'. Omit to search across everyone (results stay labeled).",
      })),
      shallow: Type.Optional(Type.Boolean({
        description:
          "Return raw matching memories instead of a synthesized answer. Only " +
          "for exact-string lookups where you want the unprocessed list.",
      })),
    }),
    async execute(_id, params, signal) {
      return toolText(await callConareTool("search", params as Record<string, unknown>, signal));
    },
  });

  // save: persist a durable fact/preference/decision for future sessions.
  pi.registerTool({
    name: "save",
    label: "Save",
    description:
      "Call save to persist durable information to Conare long-term memory — " +
      "preferences, decisions, research findings, anything worth remembering " +
      "across conversations. Use save when the user says 'remember this' or " +
      "shares standing context.",
    parameters: Type.Object({
      content: Type.String({ description: "The information to remember." }),
    }),
    async execute(_id, params, signal) {
      return toolText(await callConareTool("save", params as Record<string, unknown>, signal));
    },
  });

  // forget: delete a specific memory by ID.
  pi.registerTool({
    name: "forget",
    label: "Forget",
    description:
      "Call forget to delete a specific memory by its ID — use when the user " +
      "asks to remove or forget something they previously saved.",
    parameters: Type.Object({
      memoryId: Type.String({ description: "The ID of the memory to delete." }),
    }),
    async execute(_id, params, signal) {
      return toolText(await callConareTool("forget", params as Record<string, unknown>, signal));
    },
  });

  // ── No automatic recall (by design) ───────────────────────────────────────
  // We deliberately do NOT recall on session_start or before_agent_start: any
  // automatic recall today means a live LLM-synthesis round-trip (seconds) on
  // the critical path — it blocks either startup or the first message, which is
  // exactly the latency users hate. Instead we give the model the recall/search
  // tools and let it pull memory when it's actually relevant.
  //
  // Future: auto-inject a *pre-prepared* context blob (precomputed server-side,
  // ~1s) on the first message. That's fast enough to be invisible; live synth
  // is not. Until that exists, tools-only is the right call.
}
