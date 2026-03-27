/**
 * MCP schema tool handlers.
 *
 * Handlers for: get_memory_schema, update_memory_schema.
 */

import type { EngramPool } from "../db/connection.js";
import type { SchemaManager, AddEntityTypeInput } from "../schema/manager.js";
import type { EngramConfig } from "../config.js";
import { writeSchemaFile } from "../schema/file-sync.js";
import type { ToolResult, ToolDeps } from "./write-tools.js";
import { textResult, errorResult } from "../format/response.js";

/** Callback for emitting notifications/tools/list_changed */
export type NotifyToolsChanged = () => Promise<void>;

export interface SchemaDeps extends ToolDeps {
  /** Path to MEMORY_SCHEMA.md for file sync */
  schemaFilePath?: string;
  /** Callback to emit notifications/tools/list_changed after schema update */
  notifyToolsChanged?: NotifyToolsChanged;
}

/**
 * get_memory_schema — Returns the current schema (entity types, relationship types).
 */
export async function handleGetMemorySchema(
  deps: SchemaDeps,
  args?: { compact?: boolean }
): Promise<ToolResult> {
  try {
    const schema = deps.schema.getSchema();
    const compact = args?.compact === true;

    return textResult({
      preset_name: schema.preset_name,
      entity_types: schema.entity_types.map((t) =>
        compact
          ? {
              name: t.name,
              properties: t.properties,
            }
          : {
              name: t.name,
              properties: t.properties,
              extraction_hint: t.extraction_hint,
              examples: t.examples,
            }
      ),
      relationship_types: schema.relationship_types,
      guardrails: compact
        ? {
            max_entity_types: deps.schema.getGuardrails().max_entity_types,
          }
        : deps.schema.getGuardrails(),
    });
  } catch (err) {
    return errorResult(
      `Failed to get schema: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * update_memory_schema — Add a new entity type (v1: add-only).
 */
export async function handleUpdateMemorySchema(
  deps: SchemaDeps,
  args: {
    action: string;
    name: string;
    properties: string[];
    extraction_hint: string;
    examples: string[];
  }
): Promise<ToolResult> {
  try {
    if (args.action !== "add") {
      return errorResult(
        `Only "add" action is supported in v1. Got: "${args.action}".`
      );
    }

    if (!args.name) {
      return errorResult("'name' is required.");
    }

    if (!args.properties || !Array.isArray(args.properties)) {
      return errorResult("'properties' must be an array of strings.");
    }

    if (!args.extraction_hint) {
      return errorResult("'extraction_hint' is required.");
    }

    if (
      !args.examples ||
      !Array.isArray(args.examples)
    ) {
      return errorResult("'examples' must be an array of strings.");
    }

    const input: AddEntityTypeInput = {
      name: args.name,
      properties: args.properties,
      extraction_hint: args.extraction_hint,
      examples: args.examples,
    };

    // Add to schema manager (validates guardrails)
    const result = deps.schema.addEntityType(input);

    // Create AGE label
    try {
      await deps.pool.query(
        `SELECT create_vlabel('${deps.pool.graphName}', '${args.name}')`
      );
    } catch (err) {
      // Label may already exist if schema was loaded from file
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("already exists")) {
        throw err;
      }
    }

    // Sync to MEMORY_SCHEMA.md if path provided
    if (deps.schemaFilePath) {
      try {
        writeSchemaFile(deps.schemaFilePath, deps.schema.getPreset());
      } catch {
        // File sync failure is non-fatal — DB state is canonical
      }
    }

    // Emit notifications/tools/list_changed (best-effort)
    if (deps.notifyToolsChanged) {
      try {
        await deps.notifyToolsChanged();
      } catch {
        // Notification failure is non-fatal
      }
    }

    return textResult(result);
  } catch (err) {
    return errorResult(
      `Failed to update schema: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
