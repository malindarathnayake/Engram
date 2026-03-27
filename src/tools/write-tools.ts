/**
 * MCP write tool handlers.
 *
 * Handlers for: remember_entity, remember_relationship, supersede_fact,
 * forget_entity, merge_entities.
 *
 * Each handler takes dependencies (pool, schema, config) and tool arguments,
 * returns an MCP CallToolResult-shaped object.
 */

import type { EngramPool } from "../db/connection.js";
import type { SchemaManager } from "../schema/manager.js";
import type { EngramConfig } from "../config.js";
import {
  createOrUpdateEntity,
  softDeleteEntity,
  mergeEntities,
} from "../graph/entities.js";
import { createRelationship, createOrUpdateRelationship, type UpsertRelationshipResult } from "../graph/relationships.js";
import { resolveEntity } from "../graph/search.js";
import { supersedeFact } from "../graph/facts.js";
import { textResult, errorResult } from "../format/response.js";

/** MCP tool result shape */
export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface ToolDeps {
  pool: EngramPool;
  schema: SchemaManager;
  config: EngramConfig;
}

/**
 * remember_entity — Create or update an entity in the graph.
 */
export async function handleRememberEntity(
  deps: ToolDeps,
  args: {
    name: string;
    type: string;
    properties?: Record<string, unknown>;
    confidence?: number;
  }
): Promise<ToolResult> {
  try {
    if (!args.name || !args.type) {
      return errorResult("Both 'name' and 'type' are required.");
    }

    if (
      args.confidence !== undefined &&
      (args.confidence < 0 || args.confidence > 1)
    ) {
      return errorResult("Confidence must be 0.0-1.0.");
    }

    const minConfidence = deps.config.guardrails.min_confidence_to_store;
    if (args.confidence !== undefined && args.confidence < minConfidence) {
      return errorResult(
        `Confidence ${args.confidence} is below minimum threshold ${minConfidence}.`
      );
    }

    const result = await createOrUpdateEntity(deps.pool, deps.schema, {
      name: args.name,
      type: args.type,
      properties: args.properties,
      confidence: args.confidence,
    });

    return textResult({
      id: result.id,
      status: result.created ? "created" : "updated",
    });
  } catch (err) {
    return errorResult(
      `Failed to remember entity: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * remember_relationship — Create a relationship between two entities.
 */
export async function handleRememberRelationship(
  deps: ToolDeps,
  args: {
    from: string;
    to: string;
    type: string;
    properties?: Record<string, unknown>;
  }
): Promise<ToolResult> {
  try {
    if (!args.from || !args.to || !args.type) {
      return errorResult("'from', 'to', and 'type' are all required.");
    }

    const result = await createRelationship(deps.pool, deps.schema, {
      from: args.from,
      to: args.to,
      type: args.type,
      properties: args.properties,
    });

    if ("needs_disambiguation" in result) {
      return textResult(result);
    }

    return textResult({
      id: result.id,
      status: (result as UpsertRelationshipResult).created ? "created" : "updated",
    });
  } catch (err) {
    return errorResult(
      `Failed to remember relationship: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * supersede_fact — Record a new fact that supersedes an old one.
 */
export async function handleSupersedeFact(
  deps: ToolDeps,
  args: {
    entity: string;
    new_fact: string;
    old_fact?: string;
    source?: string;
    confidence?: number;
  }
): Promise<ToolResult> {
  try {
    if (!args.entity || !args.new_fact) {
      return errorResult("'entity' and 'new_fact' are required.");
    }

    if (
      args.confidence !== undefined &&
      (args.confidence < 0 || args.confidence > 1)
    ) {
      return errorResult("Confidence must be 0.0-1.0.");
    }

    const result = await supersedeFact(deps.pool, deps.schema, {
      entity: args.entity,
      new_fact: args.new_fact,
      old_fact: args.old_fact,
      source: args.source,
      confidence: args.confidence,
    });

    return textResult({
      new_fact_id: result.new_fact_id,
      old_fact_id: result.old_fact_id,
      status: "superseded",
    });
  } catch (err) {
    return errorResult(
      `Failed to supersede fact: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * forget_entity — Soft-delete an entity.
 */
export async function handleForgetEntity(
  deps: ToolDeps,
  args: { identifier: string }
): Promise<ToolResult> {
  try {
    if (!args.identifier) {
      return errorResult("'identifier' is required (entity name or UUID).");
    }

    const result = await softDeleteEntity(
      deps.pool,
      deps.schema,
      args.identifier
    );

    return textResult({
      id: result.id,
      status: "deleted",
    });
  } catch (err) {
    return errorResult(
      `Failed to forget entity: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * merge_entities — Merge two entities into one.
 * Accepts UUIDs or entity names. New param names: surviving/merged.
 * Old param names surviving_id/merged_id still accepted.
 */
export async function handleMergeEntities(
  deps: ToolDeps,
  args: {
    surviving_id?: string;
    merged_id?: string;
    surviving?: string;
    merged?: string;
  }
): Promise<ToolResult> {
  try {
    const survivingIdent = args.surviving ?? args.surviving_id;
    const mergedIdent = args.merged ?? args.merged_id;

    if (!survivingIdent || !mergedIdent) {
      return errorResult(
        "'surviving' and 'merged' (or 'surviving_id' and 'merged_id') are both required."
      );
    }

    // Resolve surviving entity (UUID or name)
    const survivingResolution = await resolveEntity(deps.pool, deps.schema, survivingIdent);
    if (!survivingResolution.resolved) {
      if (survivingResolution.needs_disambiguation) {
        return textResult({
          needs_disambiguation: true,
          field: "surviving",
          candidates: survivingResolution.candidates,
        });
      }
      return errorResult(`Surviving entity not found: "${survivingIdent}"`);
    }

    // Resolve merged entity (UUID or name)
    const mergedResolution = await resolveEntity(deps.pool, deps.schema, mergedIdent);
    if (!mergedResolution.resolved) {
      if (mergedResolution.needs_disambiguation) {
        return textResult({
          needs_disambiguation: true,
          field: "merged",
          candidates: mergedResolution.candidates,
        });
      }
      return errorResult(`Merged entity not found: "${mergedIdent}"`);
    }

    const result = await mergeEntities(
      deps.pool,
      deps.schema,
      survivingResolution.entity.id,
      mergedResolution.entity.id
    );

    return textResult({
      surviving_id: result.surviving_id,
      merged_id: result.merged_id,
      status: "merged",
    });
  } catch (err) {
    return errorResult(
      `Failed to merge entities: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * remember_knowledge — Bulk create or update entities and relationships in one call.
 * Phase 1: create/update entities sequentially, building a batch map for forward references.
 * Phase 2: create/update relationships sequentially using a dedicated write connection.
 */
export async function handleRememberKnowledge(
  deps: ToolDeps,
  args: {
    entities?: Array<{ name: string; type: string; properties?: Record<string, unknown> }>;
    relationships?: Array<{
      from: string;
      to: string;
      type: string;
      properties?: Record<string, unknown>;
      from_type?: string;
      to_type?: string;
    }>;
  }
): Promise<ToolResult> {
  try {
  const entities = args.entities ?? [];
  const relationships = args.relationships ?? [];

  if (entities.length === 0 && relationships.length === 0) {
    return errorResult("At least one entity or relationship is required.");
  }

  // Phase 1 — Entities
  let entitiesCreated = 0;
  let entitiesUpdated = 0;
  const batchMap = new Map<string, import("../graph/entities.js").EntityResult>();

  for (const entity of entities) {
    try {
      const result = await createOrUpdateEntity(deps.pool, deps.schema, {
        name: entity.name,
        type: entity.type,
        properties: entity.properties,
      });
      const key = `${entity.name.toLowerCase()}::${entity.type}`;
      batchMap.set(key, result);
      if (result.created) {
        entitiesCreated++;
      } else {
        entitiesUpdated++;
      }
    } catch (_err) {
      // Individual entity errors do not stop processing
    }
  }

  // Phase 2 — Relationships
  let relsCreated = 0;
  let relsUpdated = 0;
  const relsFailed: Array<{ index: number; error: string }> = [];

  const client = await deps.pool.acquireWriteConnection();
  try {
    for (let i = 0; i < relationships.length; i++) {
      const rel = relationships[i];
      try {
        // Resolve "from" entity
        let fromId: string;
        let fromType: string;

        const fromKeyWithType = rel.from_type
          ? `${rel.from.toLowerCase()}::${rel.from_type}`
          : null;
        const fromBatchExact = fromKeyWithType ? batchMap.get(fromKeyWithType) : undefined;

        if (fromBatchExact) {
          fromId = fromBatchExact.id;
          fromType = fromBatchExact.type;
        } else {
          // Fuzzy match in batch map
          const fromPrefix = `${rel.from.toLowerCase()}::`;
          let fromMatches = Array.from(batchMap.entries()).filter(([k]) =>
            k.startsWith(fromPrefix)
          );
          // If type hint provided, filter fuzzy matches by type
          if (rel.from_type && fromMatches.length > 0) {
            fromMatches = fromMatches.filter(([, v]) => v.type === rel.from_type);
          }
          if (fromMatches.length === 1) {
            fromId = fromMatches[0][1].id;
            fromType = fromMatches[0][1].type;
          } else {
            // Fall through to resolveEntity
            const fromResolution = await resolveEntity(deps.pool, deps.schema, rel.from);
            if (fromResolution.resolved) {
              fromId = fromResolution.entity.id;
              fromType = fromResolution.entity.type;
            } else if (fromResolution.needs_disambiguation) {
              // Try filtering by from_type if provided
              if (rel.from_type) {
                const filtered = fromResolution.candidates.filter(
                  (c) => c.type === rel.from_type
                );
                if (filtered.length === 1) {
                  fromId = filtered[0].id;
                  fromType = filtered[0].type;
                } else {
                  relsFailed.push({
                    index: i,
                    error: `Ambiguous 'from' entity "${rel.from}": ${fromResolution.candidates.map((c) => `${c.name} (${c.type})`).join(", ")}`,
                  });
                  continue;
                }
              } else {
                relsFailed.push({
                  index: i,
                  error: `Ambiguous 'from' entity "${rel.from}": ${fromResolution.candidates.map((c) => `${c.name} (${c.type})`).join(", ")}`,
                });
                continue;
              }
            } else {
              relsFailed.push({ index: i, error: `'from' entity not found: "${rel.from}"` });
              continue;
            }
          }
        }

        // Resolve "to" entity
        let toId: string;
        let toType: string;

        const toKeyWithType = rel.to_type
          ? `${rel.to.toLowerCase()}::${rel.to_type}`
          : null;
        const toBatchExact = toKeyWithType ? batchMap.get(toKeyWithType) : undefined;

        if (toBatchExact) {
          toId = toBatchExact.id;
          toType = toBatchExact.type;
        } else {
          // Fuzzy match in batch map
          const toPrefix = `${rel.to.toLowerCase()}::`;
          let toMatches = Array.from(batchMap.entries()).filter(([k]) =>
            k.startsWith(toPrefix)
          );
          // If type hint provided, filter fuzzy matches by type
          if (rel.to_type && toMatches.length > 0) {
            toMatches = toMatches.filter(([, v]) => v.type === rel.to_type);
          }
          if (toMatches.length === 1) {
            toId = toMatches[0][1].id;
            toType = toMatches[0][1].type;
          } else {
            // Fall through to resolveEntity
            const toResolution = await resolveEntity(deps.pool, deps.schema, rel.to);
            if (toResolution.resolved) {
              toId = toResolution.entity.id;
              toType = toResolution.entity.type;
            } else if (toResolution.needs_disambiguation) {
              // Try filtering by to_type if provided
              if (rel.to_type) {
                const filtered = toResolution.candidates.filter(
                  (c) => c.type === rel.to_type
                );
                if (filtered.length === 1) {
                  toId = filtered[0].id;
                  toType = filtered[0].type;
                } else {
                  relsFailed.push({
                    index: i,
                    error: `Ambiguous 'to' entity "${rel.to}": ${toResolution.candidates.map((c) => `${c.name} (${c.type})`).join(", ")}`,
                  });
                  continue;
                }
              } else {
                relsFailed.push({
                  index: i,
                  error: `Ambiguous 'to' entity "${rel.to}": ${toResolution.candidates.map((c) => `${c.name} (${c.type})`).join(", ")}`,
                });
                continue;
              }
            } else {
              relsFailed.push({ index: i, error: `'to' entity not found: "${rel.to}"` });
              continue;
            }
          }
        }

        // Validate relationship type against schema
        if (!deps.schema.isValidRelationshipType(rel.type)) {
          relsFailed.push({
            index: i,
            error: `Invalid relationship type: "${rel.type}". Valid types: ${deps.schema.getRelationshipTypeNames().join(", ")}`,
          });
          continue;
        }

        const relResult = await createOrUpdateRelationship(
          deps.pool,
          fromId,
          toId,
          fromType,
          toType,
          rel.type,
          rel.properties ?? {},
          { client }
        );

        if (relResult.created) {
          relsCreated++;
        } else {
          relsUpdated++;
        }
      } catch (err) {
        relsFailed.push({
          index: i,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    client.release();
  }

  return textResult({
    entities: { created: entitiesCreated, updated: entitiesUpdated },
    relationships: { created: relsCreated, updated: relsUpdated, failed: relsFailed },
  });
  } catch (err) {
    return errorResult(
      `Failed to remember knowledge: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
