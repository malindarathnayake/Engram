#!/usr/bin/env node

/**
 * Engram MCP Server — Entry Point
 *
 * Startup sequence: config → pool → verify → schema → tools → transport.
 * Degrades gracefully if DB is unavailable on startup (tools return structured errors).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type EngramConfig } from "./config.js";
import { createPool, type EngramPool } from "./db/connection.js";
import { initializeDatabase } from "./db/init.js";
import { SchemaManager } from "./schema/manager.js";
import { getToolDefinitions } from "./tools/tool-descriptions.js";
import {
  handleRememberEntity,
  handleRememberRelationship,
  handleSupersedeFact,
  handleForgetEntity,
  handleMergeEntities,
  handleRememberKnowledge,
  type ToolDeps,
  type ToolResult,
} from "./tools/write-tools.js";
import {
  handleRecallEntity,
  handleRecallConnections,
  handleRecallContext,
  handleRecallTimeline,
  handleFindContradictions,
  handleSearchEntities,
  handleListEntities,
  handleExportGraph,
  handleGraphStats,
} from "./tools/read-tools.js";
import {
  handleGetMemorySchema,
  handleUpdateMemorySchema,
  type SchemaDeps,
} from "./tools/schema-tools.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Log to stderr (stdout is reserved for MCP JSON-RPC) */
function log(level: "info" | "warn" | "error", message: string): void {
  const ts = new Date().toISOString();
  process.stderr.write(`[${ts}] [engram] [${level}] ${message}\n`);
}

/**
 * Handle --initialize flag: add systemPromptFile config to openclaw.json.
 */
function handleInitialize(): void {
  const openclawPath = resolve(process.cwd(), "openclaw.json");

  const systemPromptSrc = resolve(__dirname, "system-prompt.md");
  if (!existsSync(systemPromptSrc)) {
    log("error", `system-prompt.md not found at ${systemPromptSrc}`);
    process.exit(1);
  }

  let config: Record<string, unknown> = {};
  if (existsSync(openclawPath)) {
    try {
      config = JSON.parse(readFileSync(openclawPath, "utf-8"));
    } catch (err) {
      log("error", `Failed to parse ${openclawPath}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  // Ensure agents.defaults exists
  if (!config.agents || typeof config.agents !== "object") {
    config.agents = {};
  }
  const agents = config.agents as Record<string, unknown>;
  if (!agents.defaults || typeof agents.defaults !== "object") {
    agents.defaults = {};
  }
  const defaults = agents.defaults as Record<string, unknown>;

  // Set systemPromptFile if not already present
  if (!defaults.systemPromptFile) {
    defaults.systemPromptFile = systemPromptSrc;
    writeFileSync(openclawPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    log("info", `Added systemPromptFile to ${openclawPath}`);
  } else {
    log("info", `systemPromptFile already set in ${openclawPath}, skipping`);
  }

  // Ensure mcpServers.engram exists
  if (!config.mcpServers || typeof config.mcpServers !== "object") {
    config.mcpServers = {};
  }
  const mcpServers = config.mcpServers as Record<string, unknown>;
  if (!mcpServers.engram) {
    mcpServers.engram = { command: "engram", transport: "stdio" };
    writeFileSync(openclawPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
    log("info", `Added mcpServers.engram to ${openclawPath}`);
  } else {
    log("info", `mcpServers.engram already set in ${openclawPath}, skipping`);
  }

  process.exit(0);
}

/**
 * Create a degraded ToolResult for when DB is unavailable.
 */
function degradedResult(toolName: string): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: "database_unavailable",
          message: `Engram database is not available. The "${toolName}" tool cannot execute. Check database connectivity and retry.`,
        }),
      },
    ],
    isError: true,
  };
}

/**
 * Main startup sequence.
 */
async function main(): Promise<void> {
  // Handle --initialize flag
  if (process.argv.includes("--initialize")) {
    handleInitialize();
    return;
  }

  // 1. Load config
  const config = loadConfig();
  log("info", `Config loaded: mode=${config.mode}, preset=${config.schema_preset}`);

  // 2. Load schema preset
  const schema = SchemaManager.fromPreset(config.schema_preset, {
    max_entity_types: config.guardrails.max_entity_types,
    similarity_threshold: config.guardrails.similarity_threshold,
    min_examples_per_type: config.guardrails.min_examples_per_type,
  });
  log("info", `Schema loaded: ${schema.getEntityTypeNames().length} entity types, ${schema.getRelationshipTypeNames().length} relationship types`);

  // 3. Attempt DB connection (graceful degradation if unavailable)
  let pool: EngramPool | null = null;
  let dbAvailable = false;

  try {
    pool = await createPool(config);
    const created = await initializeDatabase(pool);
    dbAvailable = true;
    log("info", `Database connected. Graph "${pool.graphName}" ${created ? "created" : "exists"}.`);
  } catch (err) {
    log("warn", `Database unavailable on startup: ${err instanceof Error ? err.message : String(err)}. Tools will return degradation errors.`);
  }

  // 4. Create MCP server
  const mcpServer = new McpServer(
    {
      name: "engram",
      version: "0.3.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // 5. Build deps
  const deps: ToolDeps = {
    pool: pool!,
    schema,
    config,
  };

  const schemaDeps: SchemaDeps = {
    ...deps,
    schemaFilePath: undefined, // MEMORY_SCHEMA.md path set by caller if needed
    notifyToolsChanged: async () => {
      // Re-register tools with updated descriptions after schema change
      // The MCP SDK sends notifications/tools/list_changed automatically
      // when tools are re-registered
    },
  };

  // 6. Register tools
  const toolDefs = getToolDefinitions(schema);

  // Tool handler dispatch map
  const toolHandlers: Record<
    string,
    (args: Record<string, unknown>) => Promise<ToolResult>
  > = {
    // Write tools
    remember_entity: (args) =>
      dbAvailable
        ? handleRememberEntity(deps, args as Parameters<typeof handleRememberEntity>[1])
        : Promise.resolve(degradedResult("remember_entity")),
    remember_relationship: (args) =>
      dbAvailable
        ? handleRememberRelationship(deps, args as Parameters<typeof handleRememberRelationship>[1])
        : Promise.resolve(degradedResult("remember_relationship")),
    supersede_fact: (args) =>
      dbAvailable
        ? handleSupersedeFact(deps, args as Parameters<typeof handleSupersedeFact>[1])
        : Promise.resolve(degradedResult("supersede_fact")),
    forget_entity: (args) =>
      dbAvailable
        ? handleForgetEntity(deps, args as Parameters<typeof handleForgetEntity>[1])
        : Promise.resolve(degradedResult("forget_entity")),
    merge_entities: (args) =>
      dbAvailable
        ? handleMergeEntities(deps, args as Parameters<typeof handleMergeEntities>[1])
        : Promise.resolve(degradedResult("merge_entities")),
    remember_knowledge: (args) =>
      dbAvailable
        ? handleRememberKnowledge(deps, args as Parameters<typeof handleRememberKnowledge>[1])
        : Promise.resolve(degradedResult("remember_knowledge")),

    // Read tools
    recall_entity: (args) =>
      dbAvailable
        ? handleRecallEntity(deps, args as Parameters<typeof handleRecallEntity>[1])
        : Promise.resolve(degradedResult("recall_entity")),
    recall_connections: (args) =>
      dbAvailable
        ? handleRecallConnections(deps, args as Parameters<typeof handleRecallConnections>[1])
        : Promise.resolve(degradedResult("recall_connections")),
    recall_context: (args) =>
      dbAvailable
        ? handleRecallContext(deps, args as Parameters<typeof handleRecallContext>[1])
        : Promise.resolve(degradedResult("recall_context")),
    recall_timeline: (args) =>
      dbAvailable
        ? handleRecallTimeline(deps, args as Parameters<typeof handleRecallTimeline>[1])
        : Promise.resolve(degradedResult("recall_timeline")),
    find_contradictions: (args) =>
      dbAvailable
        ? handleFindContradictions(deps, args as Parameters<typeof handleFindContradictions>[1])
        : Promise.resolve(degradedResult("find_contradictions")),
    search_entities: (args) =>
      dbAvailable
        ? handleSearchEntities(deps, args as Parameters<typeof handleSearchEntities>[1])
        : Promise.resolve(degradedResult("search_entities")),
    list_entities: (args) =>
      dbAvailable
        ? handleListEntities(deps, args as Parameters<typeof handleListEntities>[1])
        : Promise.resolve(degradedResult("list_entities")),
    export_graph: (args) =>
      dbAvailable
        ? handleExportGraph(deps, args as Parameters<typeof handleExportGraph>[1])
        : Promise.resolve(degradedResult("export_graph")),
    graph_stats: () =>
      dbAvailable
        ? handleGraphStats(deps)
        : Promise.resolve(degradedResult("graph_stats")),

    // Schema tools
    get_memory_schema: (args) =>
      dbAvailable
        ? handleGetMemorySchema(schemaDeps, args as Parameters<typeof handleGetMemorySchema>[1])
        : Promise.resolve(degradedResult("get_memory_schema")),
    update_memory_schema: (args) =>
      dbAvailable
        ? handleUpdateMemorySchema(schemaDeps, args as Parameters<typeof handleUpdateMemorySchema>[1])
        : Promise.resolve(degradedResult("update_memory_schema")),
  };

  // Register each tool with the MCP server using Zod schemas
  for (const toolDef of toolDefs) {
    const handler = toolHandlers[toolDef.name];
    if (!handler) {
      log("warn", `No handler for tool "${toolDef.name}", skipping registration`);
      continue;
    }

    // Build Zod schema from JSON Schema definition for input validation
    const inputProps = (toolDef.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    const requiredFields = (toolDef.inputSchema as { required?: string[] }).required ?? [];

    // Use a raw JSON schema approach — register tool with description only, handle validation in handlers
    mcpServer.tool(
      toolDef.name,
      toolDef.description,
      buildZodSchema(inputProps, requiredFields),
      async (args) => {
        const result = await handler(args as Record<string, unknown>);
        return result as { content: Array<{ type: "text"; text: string }>; isError?: boolean; [key: string]: unknown };
      },
    );
  }

  // 7. Connect transport
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  log("info", "Engram MCP server started on stdio transport");

  // 8. Handle graceful shutdown
  const shutdown = async () => {
    log("info", "Shutting down...");
    try {
      await mcpServer.close();
    } catch {
      // ignore close errors
    }
    if (pool) {
      try {
        await pool.close();
      } catch {
        // ignore close errors
      }
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Build a Zod schema object from JSON Schema properties for MCP tool registration.
 */
function buildZodSchema(
  properties: Record<string, unknown>,
  required: string[],
): Record<string, z.ZodTypeAny> {
  const zodShape: Record<string, z.ZodTypeAny> = {};
  const requiredSet = new Set(required);

  for (const [key, propDef] of Object.entries(properties)) {
    const prop = propDef as { type?: string; description?: string; items?: { type?: string }; enum?: string[] };
    let schema: z.ZodTypeAny;

    if (prop.enum) {
      schema = z.enum(prop.enum as [string, ...string[]]);
    } else {
      switch (prop.type) {
        case "string":
          schema = z.string();
          break;
        case "number":
          schema = z.number();
          break;
        case "boolean":
          schema = z.boolean();
          break;
        case "object":
          schema = z.record(z.unknown());
          break;
        case "array":
          if (prop.items?.type === "string") {
            schema = z.array(z.string());
          } else {
            schema = z.array(z.unknown());
          }
          break;
        default:
          schema = z.unknown();
      }
    }

    if (prop.description) {
      schema = schema.describe(prop.description);
    }

    if (!requiredSet.has(key)) {
      schema = schema.optional();
    }

    zodShape[key] = schema;
  }

  return zodShape;
}

// Run
main().catch((err) => {
  log("error", `Fatal startup error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
