/**
 * Graph export with keyset pagination.
 */

import type { EngramPool } from "../db/connection.js";
import type { AgtypeVertex, AgtypeEdge } from "../db/agtype.js";
import { buildPreparedQuery, validateIdentifier } from "../db/cypher.js";
import type { SchemaManager } from "../schema/manager.js";

const PAGE_SIZE = 200;

export async function exportEntities(
  pool: EngramPool,
  schema: SchemaManager,
  cursor?: string,
): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
  const typeNames = schema.getEntityTypeNames().filter(t => t !== "Fact");
  const allItems: Record<string, unknown>[] = [];

  for (const typeName of typeNames) {
    validateIdentifier(typeName, "entity type");
    const cypher = cursor
      ? `MATCH (n:${typeName}) WHERE (n._deleted IS NULL OR n._deleted <> true) AND n.id > $cursor RETURN n ORDER BY n.id LIMIT 200`
      : `MATCH (n:${typeName}) WHERE (n._deleted IS NULL OR n._deleted <> true) RETURN n ORDER BY n.id LIMIT 200`;

    const query = buildPreparedQuery({
      graphName: pool.graphName,
      cypher,
      cypherParams: cursor ? { cursor } : undefined,
      columns: [["n", "agtype"]],
    });

    const rows = await pool.executePrepared(query);
    for (const row of rows) {
      const vertex = row[0] as AgtypeVertex;
      if (vertex && vertex.type === "vertex") {
        allItems.push({
          id: vertex.properties.id ?? vertex.id,
          name: vertex.properties.name,
          type: vertex.label,
          properties: vertex.properties,
          created_at: vertex.properties.created_at,
        });
      }
    }
  }

  // Sort by id and take first PAGE_SIZE
  allItems.sort((a, b) => {
    const aId = String(a.id ?? "");
    const bId = String(b.id ?? "");
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  const items = allItems.slice(0, PAGE_SIZE);
  const next_cursor =
    items.length === PAGE_SIZE ? String(items[items.length - 1].id) : null;

  return { items, next_cursor };
}

export async function exportRelationships(
  pool: EngramPool,
  schema: SchemaManager,
  cursor?: string,
): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
  const relTypes = schema.getRelationshipTypeNames();
  const allItems: Record<string, unknown>[] = [];

  for (const relType of relTypes) {
    validateIdentifier(relType, "relationship type");
    const cypher = cursor
      ? `MATCH (a)-[r:${relType}]->(b) WHERE r.id > $cursor RETURN a, r, b ORDER BY r.id LIMIT 200`
      : `MATCH (a)-[r:${relType}]->(b) RETURN a, r, b ORDER BY r.id LIMIT 200`;

    const query = buildPreparedQuery({
      graphName: pool.graphName,
      cypher,
      cypherParams: cursor ? { cursor } : undefined,
      columns: [["a", "agtype"], ["r", "agtype"], ["b", "agtype"]],
    });

    const rows = await pool.executePrepared(query);
    for (const row of rows) {
      const fromVertex = row[0] as AgtypeVertex;
      const edge = row[1] as AgtypeEdge;
      const toVertex = row[2] as AgtypeVertex;
      if (edge && edge.type === "edge") {
        allItems.push({
          id: edge.properties.id ?? edge.id,
          type: edge.label,
          from_id: fromVertex?.properties?.id,
          to_id: toVertex?.properties?.id,
          properties: edge.properties,
        });
      }
    }
  }

  // Sort by id and take first PAGE_SIZE
  allItems.sort((a, b) => {
    const aId = String(a.id ?? "");
    const bId = String(b.id ?? "");
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  const items = allItems.slice(0, PAGE_SIZE);
  const next_cursor =
    items.length === PAGE_SIZE ? String(items[items.length - 1].id) : null;

  return { items, next_cursor };
}

export async function exportFacts(
  pool: EngramPool,
  _schema: SchemaManager,
  cursor?: string,
): Promise<{ items: Record<string, unknown>[]; next_cursor: string | null }> {
  const cypher = cursor
    ? `MATCH (f:Fact) WHERE f.id > $cursor RETURN f ORDER BY f.id LIMIT 200`
    : `MATCH (f:Fact) RETURN f ORDER BY f.id LIMIT 200`;

  const query = buildPreparedQuery({
    graphName: pool.graphName,
    cypher,
    cypherParams: cursor ? { cursor } : undefined,
    columns: [["f", "agtype"]],
  });

  const rows = await pool.executePrepared(query);
  const items: Record<string, unknown>[] = [];

  for (const row of rows) {
    const vertex = row[0] as AgtypeVertex;
    if (vertex && vertex.type === "vertex") {
      items.push({
        id: vertex.properties.id ?? vertex.id,
        content: vertex.properties.content,
        source: vertex.properties.source,
        confidence: vertex.properties.confidence,
        entity_id: vertex.properties.entity_id,
        timestamp: vertex.properties.timestamp,
        superseded_by: vertex.properties.superseded_by,
      });
    }
  }

  const next_cursor =
    items.length === PAGE_SIZE ? String(items[items.length - 1].id) : null;

  return { items, next_cursor };
}
