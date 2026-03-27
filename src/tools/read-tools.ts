/**
 * MCP read tool handlers.
 *
 * Handlers for: recall_entity, recall_connections, recall_context,
 * recall_timeline, find_contradictions, search_entities, graph_stats.
 */

import type { EngramPool } from "../db/connection.js";
import type { SchemaManager } from "../schema/manager.js";
import type { EngramConfig } from "../config.js";
import { getEntity, listEntities } from "../graph/entities.js";
import { getRelationships } from "../graph/relationships.js";
import {
  recallConnections,
  recallContext,
  recallTimeline,
} from "../graph/traversal.js";
import { findContradictions } from "../graph/facts.js";
import { searchEntities } from "../graph/search.js";
import { generateMermaid } from "../mermaid/generator.js";
import type { ToolResult, ToolDeps } from "./write-tools.js";
import { textResult, errorResult, stripDuplicateId, formatRelationship, rawTextResult } from "../format/response.js";
import { exportEntities, exportRelationships, exportFacts } from "../graph/export.js";

/**
 * recall_entity — Retrieve an entity by name or UUID.
 */
export async function handleRecallEntity(
  deps: ToolDeps,
  args: {
    identifier: string;
    include_relationships?: boolean;
  }
): Promise<ToolResult> {
  try {
    if (!args.identifier) {
      return errorResult("'identifier' is required (entity name or UUID).");
    }

    const entity = await getEntity(
      deps.pool,
      deps.schema,
      args.identifier
    );

    if (!entity) {
      return textResult({
        found: false,
        message: `No entity found for "${args.identifier}". Try search_entities for fuzzy matching.`,
      });
    }

    const cleanedEntity = stripDuplicateId(entity);
    const result: Record<string, unknown> = { ...cleanedEntity, found: true };

    if (args.include_relationships) {
      const rels = await getRelationships(
        deps.pool,
        deps.schema,
        entity.id,
        { limit: deps.config.query_limits.default_limit }
      );
      const nameMap = new Map(rels.entity_names);
      nameMap.set(entity.id, entity.name);
      result.relationships = rels.relationships.map((r) =>
        formatRelationship(r, nameMap)
      );
      result.relationship_count = rels.total_count;
    }

    return textResult(result);
  } catch (err) {
    return errorResult(
      `Failed to recall entity: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * recall_connections — Multi-hop graph traversal from an anchor entity.
 */
export async function handleRecallConnections(
  deps: ToolDeps,
  args: {
    identifier: string;
    depth?: number;
    limit?: number;
    relationship_types?: string[];
    include_mermaid?: boolean;
  }
): Promise<ToolResult> {
  try {
    if (!args.identifier) {
      return errorResult("'identifier' is required (entity name or UUID).");
    }

    const traversalResult = await recallConnections(
      deps.pool,
      deps.schema,
      args.identifier,
      deps.config,
      {
        depth: args.depth,
        limit: args.limit,
        relationship_types: args.relationship_types,
      }
    );

    const { entity_names: _names, ...traversalData } = traversalResult;
    const result: Record<string, unknown> = {
      ...traversalData,
      anchor: stripDuplicateId(traversalResult.anchor),
      entities: traversalResult.entities.map((entity) =>
        stripDuplicateId(entity)
      ),
      relationships: traversalResult.relationships.map((r) =>
        formatRelationship(r, traversalResult.entity_names)
      ),
    };

    if (args.include_mermaid) {
      const mermaidResult = generateMermaid({
        entities: [traversalResult.anchor, ...traversalResult.entities],
        relationships: traversalResult.relationships,
        maxNodes: deps.config.query_limits.mermaid_max_nodes,
      });
      result.mermaid = mermaidResult.mermaid;
      result.mermaid_truncated = mermaidResult.truncated;
    }

    return textResult(result);
  } catch (err) {
    return errorResult(
      `Failed to recall connections: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * recall_context — Entity with connections and facts.
 */
export async function handleRecallContext(
  deps: ToolDeps,
  args: {
    identifier: string;
    depth?: number;
    limit?: number;
    sections?: string[];
    include_mermaid?: boolean;
  }
): Promise<ToolResult> {
  try {
    if (!args.identifier) {
      return errorResult("'identifier' is required (entity name or UUID).");
    }

    const validSections = ["entity", "connections", "facts"];
    const sections = args.sections ?? validSections;

    if (sections.length === 0) {
      return errorResult("At least one section required");
    }

    for (const section of sections) {
      if (!validSections.includes(section)) {
        return errorResult(
          `Invalid section: "${section}". Valid: entity, connections, facts`
        );
      }
    }

    const contextResult = await recallContext(
      deps.pool,
      deps.schema,
      args.identifier,
      deps.config,
      { depth: args.depth, limit: args.limit }
    );
    const cleanedEntity = stripDuplicateId(contextResult.entity);
    const { entity_names: _connNames, ...connData } = contextResult.connections;
    const cleanedConnections = {
      ...connData,
      anchor: stripDuplicateId(contextResult.connections.anchor),
      entities: contextResult.connections.entities.map((entity) =>
        stripDuplicateId(entity)
      ),
      relationships: contextResult.connections.relationships.map((r) =>
        formatRelationship(r, contextResult.connections.entity_names)
      ),
    };

    const result: Record<string, unknown> = {};

    if (sections.includes("entity")) {
      result.entity = cleanedEntity;
    }

    if (sections.includes("connections")) {
      result.connections = cleanedConnections;
    }

    if (sections.includes("facts")) {
      result.facts = contextResult.facts;
    }

    if (args.include_mermaid) {
      const mermaidResult = generateMermaid({
        entities: [
          cleanedEntity,
          ...cleanedConnections.entities,
        ],
        relationships: contextResult.connections.relationships,
        maxNodes: deps.config.query_limits.mermaid_max_nodes,
      });
      result.mermaid = mermaidResult.mermaid;
      result.mermaid_truncated = mermaidResult.truncated;
    }

    return textResult(result);
  } catch (err) {
    return errorResult(
      `Failed to recall context: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * recall_timeline — Timeline of events for an entity.
 */
export async function handleRecallTimeline(
  deps: ToolDeps,
  args: {
    identifier: string;
    last_n?: number;
  }
): Promise<ToolResult> {
  try {
    if (!args.identifier) {
      return errorResult("'identifier' is required (entity name or UUID).");
    }

    const limit = Math.max(1, args.last_n ?? 5);

    const result = await recallTimeline(
      deps.pool,
      deps.schema,
      args.identifier,
      deps.config,
      { limit }
    );

    return textResult({
      ...result,
      showing: result.events.length,
    });
  } catch (err) {
    return errorResult(
      `Failed to recall timeline: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * find_contradictions — Find contradicting facts for an entity.
 */
export async function handleFindContradictions(
  deps: ToolDeps,
  args: { identifier: string }
): Promise<ToolResult> {
  try {
    if (!args.identifier) {
      return errorResult("'identifier' is required (entity name or UUID).");
    }

    const result = await findContradictions(
      deps.pool,
      deps.schema,
      args.identifier
    );

    return textResult(result);
  } catch (err) {
    return errorResult(
      `Failed to find contradictions: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * search_entities — Fuzzy name search across entities.
 */
export async function handleSearchEntities(
  deps: ToolDeps,
  args: {
    query: string;
    limit?: number;
    type_filter?: string;
    exact?: boolean;
  }
): Promise<ToolResult> {
  try {
    if (!args.query) {
      return errorResult("'query' is required.");
    }

    const limit = args.limit === undefined
      ? undefined
      : Math.min(args.limit, deps.config.query_limits.max_limit);

    const results = await searchEntities(deps.pool, deps.schema, args.query, {
      limit,
      type_filter: args.type_filter,
      exact: args.exact,
    });

    return textResult({
      results: results.map((result) => stripDuplicateId(result)),
      count: results.length,
    });
  } catch (err) {
    return errorResult(
      `Failed to search entities: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * list_entities — List all entities, optionally filtered by type.
 */
export async function handleListEntities(
  deps: ToolDeps,
  args: {
    type_filter?: string;
    limit?: number;
  }
): Promise<ToolResult> {
  try {
    const limit = args.limit === undefined
      ? deps.config.query_limits.default_limit
      : Math.max(1, Math.min(args.limit, deps.config.query_limits.max_limit));

    const result = await listEntities(deps.pool, deps.schema, {
      type_filter: args.type_filter,
      limit,
    });

    return textResult(result);
  } catch (err) {
    return errorResult(
      `Failed to list entities: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * graph_stats — Returns graph statistics.
 */
export async function handleGraphStats(
  deps: ToolDeps
): Promise<ToolResult> {
  try {
    const schema = deps.schema.getSchema();

    // Count entities per type
    const entityCounts: Record<string, number> = {};
    for (const typeName of schema.entity_types.map((t) => t.name)) {
      try {
        const rows = await deps.pool.cypherQuery(
          `MATCH (n:${typeName}) WHERE n._deleted IS NULL OR n._deleted = false RETURN count(n)`,
          undefined,
          ["count"]
        );
        const count = rows[0]?.[0];
        entityCounts[typeName] =
          typeof count === "number"
            ? count
            : typeof count === "string"
              ? parseInt(count, 10)
              : 0;
      } catch {
        entityCounts[typeName] = 0;
      }
    }

    // Count relationships per type
    const relationshipCounts: Record<string, number> = {};
    for (const relType of schema.relationship_types) {
      try {
        const rows = await deps.pool.cypherQuery(
          `MATCH ()-[r:${relType}]->() RETURN count(r)`,
          undefined,
          ["count"]
        );
        const count = rows[0]?.[0];
        relationshipCounts[relType] =
          typeof count === "number"
            ? count
            : typeof count === "string"
              ? parseInt(count, 10)
              : 0;
      } catch {
        relationshipCounts[relType] = 0;
      }
    }

    const totalEntities = Object.values(entityCounts).reduce(
      (sum, c) => sum + c,
      0
    );
    const totalRelationships = Object.values(relationshipCounts).reduce(
      (sum, c) => sum + c,
      0
    );

    return textResult({
      total_entities: totalEntities,
      total_relationships: totalRelationships,
      entities_by_type: entityCounts,
      relationships_by_type: relationshipCounts,
      schema_preset: schema.preset_name,
      entity_type_count: schema.entity_types.length,
      relationship_type_count: schema.relationship_types.length,
      healthy: true,
    });
  } catch (err) {
    return textResult({
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * export_graph — Export entire graph as JSONL with keyset pagination.
 */
export async function handleExportGraph(
  deps: ToolDeps,
  args: {
    sections?: string[];
  }
): Promise<ToolResult> {
  try {
    const validSections = ["entities", "relationships", "facts"];
    const sections = args.sections ?? validSections;

    // Validate sections
    for (const section of sections) {
      if (!validSections.includes(section)) {
        return errorResult(`Invalid section: "${section}". Valid: entities, relationships, facts`);
      }
    }

    const lines: string[] = [];

    // Process sections in order
    if (sections.includes("entities")) {
      let cursor: string | undefined;
      do {
        const page = await exportEntities(deps.pool, deps.schema, cursor);
        for (const item of page.items) {
          lines.push(JSON.stringify({ section: "entities", data: item }));
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
    }

    if (sections.includes("relationships")) {
      let cursor: string | undefined;
      do {
        const page = await exportRelationships(deps.pool, deps.schema, cursor);
        for (const item of page.items) {
          lines.push(JSON.stringify({ section: "relationships", data: item }));
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
    }

    if (sections.includes("facts")) {
      let cursor: string | undefined;
      do {
        const page = await exportFacts(deps.pool, deps.schema, cursor);
        for (const item of page.items) {
          lines.push(JSON.stringify({ section: "facts", data: item }));
        }
        cursor = page.next_cursor ?? undefined;
      } while (cursor);
    }

    // IMPORTANT: Use rawTextResult, not textResult
    return rawTextResult(lines.join("\n"));
  } catch (err) {
    return errorResult(
      `Failed to export graph: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
