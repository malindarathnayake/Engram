/**
 * Engram Bridge — OpenClaw Plugin
 *
 * Exposes Engram's 14 graph memory tools as native OpenClaw agent tools.
 * Spawns `engram` as a child process (stdio MCP), lazy-started on first tool call.
 * register() is synchronous (OpenClaw SDK requirement); async work deferred to execute().
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { spawn, type ChildProcess } from "node:child_process";

// ── Types ─────────────────────────────────────────────────────

interface McpResponse {
  jsonrpc: string;
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ToolResultContent {
  type: string;
  text: string;
}

// ── MCP Client (lazy singleton) ───────────────────────────────

let mcpProcess: ChildProcess | null = null;
let mcpReady = false;
let mcpStarting: Promise<void> | null = null;
let nextId = 1;
let restartCount = 0;
const pending = new Map<number, {
  resolve: (val: McpResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let buffer = "";

let pluginCommand = "engram";
let pluginMaxRestarts = 3;

function drainBuffer(): void {
  const lines = buffer.split("\n");
  buffer = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed: McpResponse = JSON.parse(line);
      if (parsed.id !== undefined && pending.has(parsed.id)) {
        const entry = pending.get(parsed.id)!;
        pending.delete(parsed.id);
        clearTimeout(entry.timer);
        entry.resolve(parsed);
      }
    } catch {
      // partial or non-JSON line
    }
  }
}

function sendMcp(msg: Record<string, unknown>): void {
  if (mcpProcess?.stdin?.writable) {
    mcpProcess.stdin.write(JSON.stringify(msg) + "\n");
  }
}

/**
 * Send a raw JSON-RPC request to the subprocess and wait for the response.
 * No readiness guard — used internally for the initialize handshake.
 */
function mcpSend(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<McpResponse> {
  if (!mcpProcess) {
    return Promise.reject(new Error("Engram MCP subprocess not running"));
  }
  const id = nextId++;
  return new Promise<McpResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP timeout: ${method} (${timeoutMs}ms)`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    sendMcp({ jsonrpc: "2.0", id, method, params });
  });
}

/**
 * Send a JSON-RPC request, guarded by mcpReady.
 * Used for tool calls after initialization is complete.
 */
async function mcpRequest(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<McpResponse> {
  if (!mcpProcess || !mcpReady) {
    throw new Error("Engram MCP server not ready");
  }
  return mcpSend(method, params, timeoutMs);
}

async function ensureMcpReady(): Promise<void> {
  if (mcpReady && mcpProcess && !mcpProcess.killed) return;
  if (mcpStarting) return mcpStarting;

  mcpStarting = (async () => {
    try {
      // Whitelist only ENGRAM_* vars + essentials
      const env: Record<string, string> = {
        PATH: process.env.PATH || "",
        NODE_PATH: process.env.NODE_PATH || "",
        HOME: process.env.HOME || "",
      };
      for (const [key, val] of Object.entries(process.env)) {
        if (key.startsWith("ENGRAM_") && val !== undefined) {
          env[key] = val;
        }
      }

      mcpProcess = spawn(pluginCommand, [], {
        env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      mcpProcess.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        drainBuffer();
      });

      // Wait for engram to signal readiness via stderr output.
      // Engram prints "[engram] [info] ..." lines to stderr during startup.
      // Once we see any stderr output, the stdio transport is listening.
      // Fallback: timeout after 10s if no stderr arrives (e.g., engram hangs).
      let stderrResolve: (() => void) | null = null;
      const stderrReady = new Promise<void>((resolve) => { stderrResolve = resolve; });
      const stderrTimeout = new Promise<void>((resolve) =>
        setTimeout(resolve, 10000)
      );

      mcpProcess.stderr!.on("data", () => {
        if (stderrResolve) {
          stderrResolve();
          stderrResolve = null; // only resolve once
        }
        // drain remaining stderr silently
      });

      mcpProcess.on("exit", () => {
        mcpReady = false;
        mcpProcess = null;
        // Resolve stderr wait if still pending (process died before output)
        if (stderrResolve) {
          stderrResolve();
          stderrResolve = null;
        }
        // Reject all pending calls
        for (const [id, entry] of pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error("Engram subprocess exited"));
          pending.delete(id);
        }
      });

      // Wait for ready signal or timeout
      await Promise.race([stderrReady, stderrTimeout]);

      // MCP initialize handshake (uses mcpSend — no mcpReady guard)
      const initResp = await mcpSend("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "engram-bridge", version: "0.2.0" },
      });

      if (initResp.error) {
        throw new Error(`MCP init failed: ${initResp.error.message}`);
      }

      // Send initialized notification
      sendMcp({ jsonrpc: "2.0", method: "notifications/initialized" });
      mcpReady = true;
      restartCount = 0;
    } catch (err) {
      mcpReady = false;
      if (mcpProcess) {
        mcpProcess.kill("SIGKILL");
        mcpProcess = null;
      }
      throw err;
    } finally {
      mcpStarting = null;
    }
  })();

  return mcpStarting;
}

async function callEngramTool(toolName: string, args: Record<string, unknown>): Promise<ToolResultContent[]> {
  try {
    await ensureMcpReady();
  } catch (err) {
    restartCount++;
    if (restartCount <= pluginMaxRestarts) {
      // Retry once
      try {
        await ensureMcpReady();
      } catch {
        return [{ type: "text", text: JSON.stringify({ error: "engram_unavailable", message: `Engram failed to start after ${restartCount} attempts: ${err}` }) }];
      }
    } else {
      return [{ type: "text", text: JSON.stringify({ error: "engram_unavailable", message: "Engram exceeded max restart attempts. Check database connectivity." }) }];
    }
  }

  try {
    const resp = await mcpRequest("tools/call", { name: toolName, arguments: args }, 20000);
    if (resp.error) {
      return [{ type: "text", text: JSON.stringify({ error: "tool_error", message: resp.error.message }) }];
    }
    // MCP tool results have content array
    const result = resp.result as { content?: ToolResultContent[]; isError?: boolean } | undefined;
    return result?.content || [{ type: "text", text: JSON.stringify(result) }];
  } catch (err) {
    return [{ type: "text", text: JSON.stringify({ error: "tool_error", message: String(err) }) }];
  }
}

// ── Tool Definitions (Static — Option B) ──────────────────────
// These are registered synchronously. Schemas use TypeBox.

const T_String = (desc: string) => Type.String({ description: desc });
const T_OptString = (desc: string) => Type.Optional(Type.String({ description: desc }));
const T_OptNumber = (desc: string) => Type.Optional(Type.Number({ description: desc }));
const T_OptBool = (desc: string) => Type.Optional(Type.Boolean({ description: desc }));
const T_OptStringArray = (desc: string) => Type.Optional(Type.Array(Type.String(), { description: desc }));
const T_OptObject = (desc: string) => Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: desc }));

function makeExecute(toolName: string) {
  return async (_id: string, params: Record<string, unknown>) => {
    const content = await callEngramTool(toolName, params);
    return { content };
  };
}

const TOOLS = [
  {
    name: "remember_entity",
    description: "Create or update an entity in the knowledge graph. If an entity with the same name and type exists, properties are merged.",
    parameters: Type.Object({
      name: T_String("Entity name"),
      type: T_String("Entity type (e.g., Person, Project, Company, Team, Decision, Meeting, Repository, Bug, Pattern, Topic, Fact)"),
      properties: T_OptObject("Additional key-value properties"),
      confidence: T_OptNumber("Confidence score 0.0-1.0"),
    }, { additionalProperties: false }),
  },
  {
    name: "remember_relationship",
    description: "Create a directed relationship between two entities. Entities can be specified by UUID or name (fuzzy matched).",
    parameters: Type.Object({
      from: T_String("Source entity (UUID or name)"),
      to: T_String("Target entity (UUID or name)"),
      type: T_String("Relationship type (e.g., WORKS_AT, REPORTS_TO, OWNS, DEPENDS_ON, RELATES_TO)"),
      properties: T_OptObject("Additional relationship properties"),
    }, { additionalProperties: false }),
  },
  {
    name: "supersede_fact",
    description: "Record a new fact that supersedes an old one. Creates a SUPERSEDED_BY chain for fact versioning.",
    parameters: Type.Object({
      entity: T_String("Entity UUID or name"),
      new_fact: T_String("The new fact content"),
      old_fact: T_OptString("Old fact content to supersede"),
      source: T_OptString("Source of the fact"),
      confidence: T_OptNumber("Confidence score 0.0-1.0"),
    }, { additionalProperties: false }),
  },
  {
    name: "forget_entity",
    description: "Soft-delete an entity. It remains in the graph but is excluded from queries.",
    parameters: Type.Object({
      identifier: T_String("Entity UUID or name"),
    }, { additionalProperties: false }),
  },
  {
    name: "merge_entities",
    description: "Merge two entities into one. The surviving entity inherits all relationships.",
    parameters: Type.Object({
      surviving_id: T_String("UUID of the entity to keep"),
      merged_id: T_String("UUID of the entity to merge and soft-delete"),
    }, { additionalProperties: false }),
  },
  {
    name: "recall_entity",
    description: "Retrieve an entity by name or UUID with optional relationships.",
    parameters: Type.Object({
      identifier: T_String("Entity UUID or name (fuzzy matched)"),
      include_relationships: T_OptBool("Include direct relationships"),
    }, { additionalProperties: false }),
  },
  {
    name: "recall_connections",
    description: "Multi-hop graph traversal from an anchor entity. Discovers connected entities up to N hops deep.",
    parameters: Type.Object({
      identifier: T_String("Anchor entity UUID or name"),
      depth: T_OptNumber("Maximum traversal depth"),
      limit: T_OptNumber("Maximum results"),
      relationship_types: T_OptStringArray("Filter to these relationship types"),
      include_mermaid: T_OptBool("Include Mermaid diagram in response"),
    }, { additionalProperties: false }),
  },
  {
    name: "recall_context",
    description: "Get full context for an entity: properties, connections, and facts in one call.",
    parameters: Type.Object({
      identifier: T_String("Entity UUID or name"),
      depth: T_OptNumber("Connection traversal depth"),
      limit: T_OptNumber("Maximum connections"),
      sections: Type.Optional(Type.Array(
        Type.Union([
          Type.Literal("entity"),
          Type.Literal("connections"),
          Type.Literal("facts"),
        ]),
        { description: "Filter response sections to entity, connections, and/or facts" },
      )),
      include_mermaid: T_OptBool("Include Mermaid diagram"),
    }, { additionalProperties: false }),
  },
  {
    name: "recall_timeline",
    description: "Get a chronological timeline of events related to an entity.",
    parameters: Type.Object({
      identifier: T_String("Entity UUID or name"),
      last_n: T_OptNumber("Number of most recent events to return (default: 5)"),
    }, { additionalProperties: false }),
  },
  {
    name: "find_contradictions",
    description: "Find potentially contradicting facts about an entity. Returns all active facts for review.",
    parameters: Type.Object({
      identifier: T_String("Entity UUID or name"),
    }, { additionalProperties: false }),
  },
  {
    name: "search_entities",
    description: "Fuzzy search for entities by name. Case-insensitive, supports partial matches.",
    parameters: Type.Object({
      query: T_String("Search query (fuzzy matched against names)"),
      limit: T_OptNumber("Maximum results"),
      type_filter: T_OptString("Filter to entity type"),
    }, { additionalProperties: false }),
  },
  {
    name: "graph_stats",
    description: "Get graph statistics: entity and relationship counts by type, schema info.",
    parameters: Type.Object({}, { additionalProperties: false }),
  },
  {
    name: "get_memory_schema",
    description: "View the current memory schema: entity types, relationship types, and guardrails.",
    parameters: Type.Object({
      compact: T_OptBool("Return a compact schema response without extraction hints, examples, or extended guardrails"),
    }, { additionalProperties: false }),
  },
  {
    name: "update_memory_schema",
    description: "Add a new entity type to the schema. Requires 3+ examples. Type names checked for similarity to prevent duplicates.",
    parameters: Type.Object({
      action: Type.Literal("add", { description: 'Action (v1: only "add" supported)' }),
      name: T_String("New entity type name (PascalCase)"),
      properties: Type.Array(Type.String(), { description: "Property names for this type" }),
      extraction_hint: T_String("Hint for when to extract this entity type"),
      examples: Type.Array(Type.String(), { description: "At least 3 example instances" }),
    }, { additionalProperties: false }),
  },
];

// ── Memory Instructions (injected via before_prompt_build) ────

const MEMORY_INSTRUCTIONS = `## Graph Memory (Engram)

You have access to a graph-based memory system. Use these tools to build and maintain a knowledge graph across conversations.

**When to store:** People with roles, projects with status, decisions with rationale, teams, companies, meetings, repositories, bugs, patterns, facts that change over time.

**How to store:** \`remember_entity\` (create/update), \`remember_relationship\` (connect), \`supersede_fact\` (version facts when info changes).

**When to query:** When asked about people/projects/decisions you may have encountered before, when you need relationship context, when checking for stale info.

**How to query:** \`recall_entity\` (by name/UUID), \`recall_connections\` (multi-hop traversal), \`recall_context\` (entity + connections + facts), \`recall_timeline\` (chronological), \`search_entities\` (fuzzy search), \`find_contradictions\` (conflicting facts), \`graph_stats\` (overview).

**Guidelines:** Be selective — store cross-conversation info, not ephemeral details. Use confidence scores. Supersede facts instead of duplicating. Merge duplicate entities. Soft-delete stale data.`;

// ── Plugin Entry ──────────────────────────────────────────────

export default definePluginEntry({
  id: "engram-bridge",
  name: "Engram Graph Memory",
  description: "Graph-based memory for OpenClaw bots via Apache AGE",
  register(api) {
    // Read plugin config
    const config = api.pluginConfig as { command?: string; maxRestarts?: number } | undefined;
    pluginCommand = config?.command || "engram";
    pluginMaxRestarts = config?.maxRestarts ?? 3;

    // Register all 14 tools
    for (const tool of TOOLS) {
      api.registerTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        execute: makeExecute(tool.name),
      });
    }

    // Inject memory instructions into system prompt
    api.on("before_prompt_build", () => ({
      appendSystemContext: MEMORY_INSTRUCTIONS,
    }));

    api.logger.info(`Engram bridge registered ${TOOLS.length} tools (command: ${pluginCommand})`);
  },
});
