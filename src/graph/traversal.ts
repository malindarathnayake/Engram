/**
 * Graph traversal operations.
 *
 * Provides multi-hop traversal with depth limits, result limits,
 * relationship type filters, and query timeout enforcement.
 */

import type { EngramPool } from "../db/connection.js";
import { parseAgtype, type AgtypeVertex, type AgtypeEdge } from "../db/agtype.js";
import { buildPreparedQuery, validateIdentifier, validateDepth } from "../db/cypher.js";
import type { SchemaManager } from "../schema/manager.js";
import type { EngramConfig } from "../config.js";
import { resolveEntity } from "./search.js";
import type { RelationshipResult } from "./relationships.js";

export interface TraversalOptions {
  /** Maximum path depth (default from config) */
  depth?: number;
  /** Maximum number of results (default from config) */
  limit?: number;
  /** Filter to specific relationship types */
  relationship_types?: string[];
  /** Query timeout in ms (default from config) */
  timeout_ms?: number;
}

export interface TraversalEntity {
  id: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface TraversalResult {
  anchor: TraversalEntity;
  entities: TraversalEntity[];
  relationships: RelationshipResult[];
  total_count: number;
  truncated: boolean;
  depth: number;
  entity_names: Map<string, string>;
}

export interface ContextResult {
  entity: TraversalEntity;
  connections: TraversalResult;
  facts: Array<{
    id: string;
    content: string;
    timestamp: string;
    superseded: boolean;
  }>;
}

export interface TimelineEntry {
  id: string;
  type: string;
  name: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

export interface TimelineResult {
  entity_id: string;
  entity_name: string;
  events: TimelineEntry[];
  total_events: number;
}

/**
 * Recall connections for an entity via multi-hop traversal.
 */
export async function recallConnections(
  pool: EngramPool,
  schema: SchemaManager,
  identifier: string,
  config: EngramConfig,
  options: TraversalOptions = {},
): Promise<TraversalResult> {
  const depth = options.depth ?? config.query_limits.max_depth;
  const limit = options.limit ?? config.query_limits.default_limit;
  const timeoutMs = options.timeout_ms ?? config.query_limits.query_timeout_ms;

  validateDepth(depth);
  if (limit < 1 || limit > config.query_limits.max_limit) {
    throw new Error(
      `Limit must be between 1 and ${config.query_limits.max_limit}`,
    );
  }

  // Resolve anchor entity
  const resolution = await resolveEntity(pool, schema, identifier);
  if (!resolution.resolved) {
    if (resolution.needs_disambiguation) {
      throw new Error(
        `Ambiguous entity: "${identifier}". Candidates: ${resolution.candidates.map((c) => `${c.name} (${c.type})`).join(", ")}`,
      );
    }
    throw new Error(`Entity not found: "${identifier}"`);
  }

  const anchor = resolution.entity;
  validateIdentifier(anchor.type, "entity type");

  // Validate relationship type filters
  if (options.relationship_types) {
    for (const rt of options.relationship_types) {
      validateIdentifier(rt, "relationship type");
    }
  }

  const relFilter = options.relationship_types?.length
    ? `:${options.relationship_types.join("|")}`
    : "";

  // Execute with timeout using transaction-scoped statement_timeout
  const entitiesMap = new Map<string, TraversalEntity>();
  const relationshipsMap = new Map<string, RelationshipResult>();
  // AGE internal ID → UUID map for relationship endpoint resolution
  const ageIdToUuid = new Map<string, string>();
  // Full entity name map (UUID → name) for Phase 4 formatting
  const entityNames = new Map<string, string>();
  // All nodes/rels from UNWIND (including deleted) — filtered after BFS
  const allNodesMap = new Map<string, TraversalEntity & { deleted: boolean }>();
  const allRelsMap = new Map<string, RelationshipResult>();

  // Query 1: Find all nodes along paths (including anchor via *0..)
  // Post-UNWIND filtering only — path-level soft-delete filtering is done
  // in application code via BFS reachability (AGE 1.5.0 doesn't support ALL())
  const entitiesQuery = buildPreparedQuery({
    graphName: pool.graphName,
    cypher:
      `MATCH p=(a:${anchor.type})-[${relFilter}*0..${depth}]-(b) ` +
      `WHERE a.id = $anchor_id ` +
      `UNWIND nodes(p) AS n ` +
      `RETURN DISTINCT n`,
    cypherParams: { anchor_id: anchor.id },
  });

  // Query 2: Find all relationships along paths
  const relsQuery = buildPreparedQuery({
    graphName: pool.graphName,
    cypher:
      `MATCH p=(a:${anchor.type})-[${relFilter}*1..${depth}]-(b) ` +
      `WHERE a.id = $anchor_id ` +
      `UNWIND relationships(p) AS r ` +
      `RETURN DISTINCT r`,
    cypherParams: { anchor_id: anchor.id },
  });

  const client = await pool.pool.connect();
  try {
    // Bootstrap AGE
    try {
      await client.query("LOAD 'age'");
    } catch { /* pre-loaded */ }
    await client.query(`SET search_path = ag_catalog, "$user", public`);

    // SET LOCAL requires a transaction
    await client.query("BEGIN");
    await client.query(`SET LOCAL statement_timeout = '${timeoutMs}'`);

    // Execute entities query — includes anchor via *0..
    // Collect all nodes first (including deleted ones) to build the ID map
    const entResult = await client.query(entitiesQuery.sql, entitiesQuery.params);
    for (const row of entResult.rows) {
      const raw = Object.values(row)[0] as string;
      if (raw) {
        const parsed = parseAgtype(raw) as AgtypeVertex;
        if (parsed && typeof parsed === "object" && "properties" in parsed) {
          const entityId = String(parsed.properties.id ?? parsed.id);
          // Build AGE internal ID → UUID map for relationship resolution
          ageIdToUuid.set(String(parsed.id), entityId);
          if (!allNodesMap.has(entityId)) {
            allNodesMap.set(entityId, {
              id: entityId,
              name: String(parsed.properties.name ?? ""),
              type: parsed.label,
              properties: parsed.properties,
              deleted: parsed.properties._deleted === true,
            });
          }
        }
      }
    }

    // Execute relationships query — collect all edges with UUID-mapped endpoints
    const relResult = await client.query(relsQuery.sql, relsQuery.params);
    for (const row of relResult.rows) {
      const raw = Object.values(row)[0] as string;
      if (raw) {
        const parsed = parseAgtype(raw) as AgtypeEdge;
        if (parsed && typeof parsed === "object" && "label" in parsed && "start_id" in parsed) {
          const relId = String(parsed.properties?.id ?? parsed.id);
          if (!allRelsMap.has(relId)) {
            const fromUuid = ageIdToUuid.get(String(parsed.start_id)) ?? String(parsed.start_id);
            const toUuid = ageIdToUuid.get(String(parsed.end_id)) ?? String(parsed.end_id);
            allRelsMap.set(relId, {
              id: relId,
              from_id: fromUuid,
              to_id: toUuid,
              type: parsed.label,
              properties: parsed.properties ?? {},
            });
          }
        }
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }

    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("statement timeout") || message.includes("canceling statement")) {
      throw new Error(`Query timeout: traversal exceeded ${timeoutMs}ms limit`);
    }
    throw err;
  } finally {
    client.release();
  }

  // Application-level soft-delete path filtering via BFS reachability.
  // AGE 1.5.0 doesn't support ALL() list predicates, so we filter here:
  // only include nodes reachable from anchor through non-deleted intermediates.
  const nonDeletedIds = new Set<string>();
  for (const [id, node] of allNodesMap) {
    if (!node.deleted) nonDeletedIds.add(id);
  }

  // Build adjacency list from relationships (only edges between non-deleted nodes)
  const adjacency = new Map<string, Set<string>>();
  for (const rel of allRelsMap.values()) {
    if (nonDeletedIds.has(rel.from_id) && nonDeletedIds.has(rel.to_id)) {
      if (!adjacency.has(rel.from_id)) adjacency.set(rel.from_id, new Set());
      if (!adjacency.has(rel.to_id)) adjacency.set(rel.to_id, new Set());
      adjacency.get(rel.from_id)!.add(rel.to_id);
      adjacency.get(rel.to_id)!.add(rel.from_id);
    }
  }

  // BFS from anchor to find reachable non-deleted nodes
  const reachable = new Set<string>();
  const queue = [anchor.id];
  reachable.add(anchor.id);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!reachable.has(neighbor)) {
        reachable.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  // Populate entity map and name map from reachable non-deleted nodes
  for (const [id, node] of allNodesMap) {
    if (!node.deleted && reachable.has(id)) {
      entityNames.set(id, node.name);
      if (id !== anchor.id) {
        entitiesMap.set(id, {
          id: node.id,
          name: node.name,
          type: node.type,
          properties: node.properties,
        });
      }
    }
  }
  // Ensure anchor is in the name map
  entityNames.set(anchor.id, anchor.name);

  // Filter relationships to only edges between reachable nodes
  for (const [relId, rel] of allRelsMap) {
    if (reachable.has(rel.from_id) && reachable.has(rel.to_id)) {
      relationshipsMap.set(relId, rel);
    }
  }

  const allEntities = [...entitiesMap.values()];
  const entities = allEntities.slice(0, limit);
  const truncated = allEntities.length > limit;

  return {
    anchor: {
      id: anchor.id,
      name: anchor.name,
      type: anchor.type,
      properties: anchor.properties,
    },
    entities,
    relationships: [...relationshipsMap.values()],
    total_count: allEntities.length,
    truncated,
    depth,
    entity_names: entityNames,
  };
}

/**
 * Recall full context for an entity (connections + facts).
 */
export async function recallContext(
  pool: EngramPool,
  schema: SchemaManager,
  identifier: string,
  config: EngramConfig,
  options: TraversalOptions = {},
): Promise<ContextResult> {
  // Get connections
  const connections = await recallConnections(pool, schema, identifier, config, options);

  const anchor = connections.anchor;
  validateIdentifier(anchor.type, "entity type");

  // Get facts for this entity
  const factsQuery = buildPreparedQuery({
    graphName: pool.graphName,
    cypher:
      `MATCH (f:Fact)-[:RELATES_TO]->(e:${anchor.type}) ` +
      `WHERE e.id = $entity_id ` +
      `AND (f._deleted IS NULL OR f._deleted <> true) ` +
      `RETURN f ORDER BY f.timestamp`,
    cypherParams: { entity_id: anchor.id },
  });

  const factRows = await pool.executePrepared(factsQuery);
  const facts = factRows.map((row) => {
    const vertex = row[0] as AgtypeVertex;
    return {
      id: String(vertex.properties.id),
      content: String(vertex.properties.content ?? ""),
      timestamp: String(vertex.properties.timestamp ?? ""),
      superseded: vertex.properties._superseded === true,
    };
  });

  return {
    entity: anchor,
    connections,
    facts,
  };
}

/**
 * Recall a timeline of events related to an entity.
 * Returns entities connected to the anchor that have timestamps, sorted most-recent first.
 */
export async function recallTimeline(
  pool: EngramPool,
  schema: SchemaManager,
  identifier: string,
  config: EngramConfig,
  options: TraversalOptions = {},
): Promise<TimelineResult> {
  const depth = options.depth ?? config.query_limits.max_depth;
  const limit = options.limit ?? config.query_limits.default_limit;

  validateDepth(depth);

  // Resolve entity
  const resolution = await resolveEntity(pool, schema, identifier);
  if (!resolution.resolved) {
    if (resolution.needs_disambiguation) {
      throw new Error(
        `Ambiguous entity: "${identifier}". Candidates: ${resolution.candidates.map((c) => `${c.name} (${c.type})`).join(", ")}`,
      );
    }
    throw new Error(`Entity not found: "${identifier}"`);
  }

  const entity = resolution.entity;
  validateIdentifier(entity.type, "entity type");

  // Find connected entities that have timestamp-like properties
  const timelineQuery = buildPreparedQuery({
    graphName: pool.graphName,
    cypher:
      `MATCH (a:${entity.type})-[*1..${depth}]-(b) ` +
      `WHERE a.id = $entity_id ` +
      `AND (b._deleted IS NULL OR b._deleted <> true) ` +
      `AND b.created_at IS NOT NULL ` +
      `RETURN DISTINCT b`,
    cypherParams: { entity_id: entity.id },
  });

  const rows = await pool.executePrepared(timelineQuery);

  const events: TimelineEntry[] = rows.map((row) => {
    const vertex = row[0] as AgtypeVertex;
    return {
      id: String(vertex.properties.id ?? vertex.id),
      type: vertex.label,
      name: String(vertex.properties.name ?? ""),
      timestamp: String(
        vertex.properties.date ??
        vertex.properties.timestamp ??
        vertex.properties.created_at ??
        "",
      ),
      properties: vertex.properties,
    };
  });

  // Sort reverse-chronologically and apply limit after capturing the full count.
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  const totalEvents = events.length;
  events.splice(limit);

  return {
    entity_id: entity.id,
    entity_name: entity.name,
    events,
    total_events: totalEvents,
  };
}
