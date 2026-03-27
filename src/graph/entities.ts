/**
 * Entity CRUD operations.
 *
 * Entities are graph vertices with a validated label (type) from the schema preset.
 * Server-issued UUIDv4 identifies each entity. Upsert uses name+type as the
 * natural key — matching entities get properties merged (new overwrites old).
 */

import { randomUUID } from "node:crypto";
import type { EngramPool } from "../db/connection.js";
import type { AgtypeVertex } from "../db/agtype.js";
import {
  buildPreparedQuery,
  buildCreateNode,
  buildMatchNode,
  buildUpdateNode,
  validateIdentifier,
} from "../db/cypher.js";
import type { SchemaManager } from "../schema/manager.js";
import { createOrUpdateRelationship } from "./relationships.js";

export interface EntityInput {
  name: string;
  type: string;
  properties?: Record<string, unknown>;
  confidence?: number;
}

export interface EntityResult {
  id: string;
  name: string;
  type: string;
  properties: Record<string, unknown>;
  created: boolean;
}

export interface MergeEntitiesResult {
  surviving_id: string;
  merged_id: string;
  relationships_transferred: number;
}

/**
 * Create or update an entity. If an entity with the same name+type exists,
 * merge properties (new values overwrite, old retained) and return created: false.
 */
export async function createOrUpdateEntity(
  pool: EngramPool,
  schema: SchemaManager,
  input: EntityInput,
): Promise<EntityResult> {
  // Validate input
  if (!input.name || input.name.trim().length === 0) {
    throw new Error("Entity name cannot be empty");
  }
  if (!schema.isValidEntityType(input.type)) {
    throw new Error(
      `Invalid entity type: "${input.type}". Valid types: ${schema.getEntityTypeNames().join(", ")}`,
    );
  }
  if (
    input.confidence !== undefined &&
    (input.confidence < 0 || input.confidence > 1)
  ) {
    throw new Error("Confidence must be between 0.0 and 1.0");
  }

  validateIdentifier(input.type, "entity type");

  const name = input.name.trim();

  // Check for existing entity with same name+type
  const existing = await findEntityByNameAndType(pool, name, input.type);

  if (existing) {
    const existingUuid = String(existing.properties.id);

    // Merge properties: new overwrite old, old retained
    const mergedProps: Record<string, unknown> = {
      ...existing.properties,
      ...input.properties,
    };

    if (input.confidence !== undefined) {
      mergedProps.confidence = input.confidence;
    }
    mergedProps.updated_at = new Date().toISOString();

    // Remove id from set props (match on it, don't overwrite it)
    const { id: _id, ...setProps } = mergedProps;

    const query = buildUpdateNode(
      pool.graphName,
      input.type,
      { id: existingUuid },
      setProps,
    );

    await pool.executePrepared(query);

    return {
      id: existingUuid,
      name,
      type: input.type,
      properties: mergedProps,
      created: false,
    };
  }

  // Create new entity
  const id = randomUUID();
  const props: Record<string, unknown> = {
    id,
    name,
    ...input.properties,
    created_at: new Date().toISOString(),
  };
  if (input.confidence !== undefined) {
    props.confidence = input.confidence;
  }

  const query = buildCreateNode(pool.graphName, input.type, props);
  const rows = await pool.executePrepared(query);

  return {
    id,
    name,
    type: input.type,
    properties: props,
    created: true,
  };
}

/**
 * Get an entity by ID. Resolves across all valid entity types.
 * Filters out soft-deleted entities.
 */
export async function getEntity(
  pool: EngramPool,
  schema: SchemaManager,
  identifier: string,
): Promise<EntityResult | null> {
  // Try as UUID first (direct lookup across all types)
  if (isUUID(identifier)) {
    for (const typeName of schema.getEntityTypeNames()) {
      const query = buildMatchNode(pool.graphName, typeName, { id: identifier });
      const rows = await pool.executePrepared(query);

      if (rows.length > 0) {
        const vertex = rows[0][0] as AgtypeVertex;
        if (isSoftDeleted(vertex)) return null;
        return vertexToEntityResult(vertex);
      }
    }
    return null;
  }

  // Try as name (fuzzy match)
  const matches = await searchByName(pool, schema, identifier, 1);
  if (matches.length === 0) return null;
  if (isSoftDeleted(matches[0])) return null;
  return vertexToEntityResult(matches[0]);
}

/**
 * Soft-delete an entity by setting _deleted = true.
 */
export async function softDeleteEntity(
  pool: EngramPool,
  schema: SchemaManager,
  identifier: string,
): Promise<{ id: string; deleted: boolean }> {
  const entity = await getEntity(pool, schema, identifier);
  if (!entity) {
    throw new Error(`Entity not found: "${identifier}"`);
  }

  const query = buildUpdateNode(
    pool.graphName,
    entity.type,
    { id: entity.id },
    {
      _deleted: true,
      _deleted_at: new Date().toISOString(),
    },
  );

  await pool.executePrepared(query);

  return { id: entity.id, deleted: true };
}

/**
 * Merge two entities of the same type. The "surviving" entity keeps all properties,
 * and all relationships from the "merged" entity are transferred.
 * The merged entity is soft-deleted.
 */
export async function mergeEntities(
  pool: EngramPool,
  schema: SchemaManager,
  survivingId: string,
  mergedId: string,
): Promise<MergeEntitiesResult> {
  const surviving = await getEntity(pool, schema, survivingId);
  if (!surviving) {
    throw new Error(`Surviving entity not found: "${survivingId}"`);
  }

  const merged = await getEntity(pool, schema, mergedId);
  if (!merged) {
    throw new Error(`Merged entity not found: "${mergedId}"`);
  }

  if (surviving.type !== merged.type) {
    throw new Error(
      `Cannot merge entities of different types: ${surviving.type} and ${merged.type}`,
    );
  }

  if (surviving.id === merged.id) {
    throw new Error("Cannot merge an entity with itself");
  }

  // Merge properties from merged into surviving (surviving takes precedence)
  const mergedProps: Record<string, unknown> = {
    ...merged.properties,
    ...surviving.properties,
    updated_at: new Date().toISOString(),
    merged_from: merged.id,
  };

  const { id: _id, ...setProps } = mergedProps;

  const updateQuery = buildUpdateNode(
    pool.graphName,
    surviving.type,
    { id: surviving.id },
    setProps,
  );
  await pool.executePrepared(updateQuery);

  // Transfer relationships from merged to surviving using shared upsert
  let transferred = 0;

  // Acquire dedicated write connection once for all transfer operations
  const client = await pool.acquireWriteConnection();
  try {
    // Outgoing relationships from merged entity
    const outQuery = buildPreparedQuery({
      graphName: pool.graphName,
      cypher:
        `MATCH (a:${merged.type})-[r]->(b) WHERE a.id = $merged_id RETURN r, b`,
      cypherParams: { merged_id: merged.id },
      columns: [
        ["r", "agtype"],
        ["b", "agtype"],
      ],
    });
    const outRows = await pool.executePrepared(outQuery);

    for (const row of outRows) {
      const edge = row[0] as { type: string; label: string; properties: Record<string, unknown> };
      const target = row[1] as AgtypeVertex;
      if (edge && "label" in edge && target && "properties" in target) {
        const targetId = target.properties.id as string;
        // Skip self-loops
        if (targetId === surviving.id) continue;

        // Skip-on-collision: check if surviving already has same-typed edge to same target
        const collisionCheck = buildPreparedQuery({
          graphName: pool.graphName,
          cypher:
            `MATCH (a:${surviving.type})-[r:${edge.label}]->(b:${target.label}) ` +
            `WHERE a.id = $surviving_id AND b.id = $target_id RETURN r`,
          cypherParams: { surviving_id: surviving.id, target_id: targetId },
          columns: [["r", "agtype"]],
        });
        const collisionRows = await pool.executePrepared(collisionCheck);
        if (collisionRows.length > 0) continue; // surviving's edge takes precedence

        // Strip system fields from edge properties
        const { id: _, created_at: __, updated_at: ___, ...userProps } = edge.properties;

        try {
          await createOrUpdateRelationship(
            pool,
            surviving.id,
            targetId,
            surviving.type,
            target.label,
            edge.label,
            userProps,
            { client },
          );
          transferred++;
        } catch {
          // Skip if transfer fails (e.g., invalid relationship type)
        }
      }
    }

    // Incoming relationships to merged entity
    const inQuery = buildPreparedQuery({
      graphName: pool.graphName,
      cypher:
        `MATCH (a)-[r]->(b:${merged.type}) WHERE b.id = $merged_id RETURN a, r`,
      cypherParams: { merged_id: merged.id },
      columns: [
        ["a", "agtype"],
        ["r", "agtype"],
      ],
    });
    const inRows = await pool.executePrepared(inQuery);

    for (const row of inRows) {
      const source = row[0] as AgtypeVertex;
      const edge = row[1] as { type: string; label: string; properties: Record<string, unknown> };
      if (source && "properties" in source && edge && "label" in edge) {
        const sourceId = source.properties.id as string;
        // Skip self-loops
        if (sourceId === surviving.id) continue;

        // Skip-on-collision: check if source already has same-typed edge to surviving
        const collisionCheck = buildPreparedQuery({
          graphName: pool.graphName,
          cypher:
            `MATCH (a:${source.label})-[r:${edge.label}]->(b:${surviving.type}) ` +
            `WHERE a.id = $source_id AND b.id = $surviving_id RETURN r`,
          cypherParams: { source_id: sourceId, surviving_id: surviving.id },
          columns: [["r", "agtype"]],
        });
        const collisionRows = await pool.executePrepared(collisionCheck);
        if (collisionRows.length > 0) continue; // surviving's edge takes precedence

        // Strip system fields from edge properties
        const { id: _, created_at: __, updated_at: ___, ...userProps } = edge.properties;

        try {
          await createOrUpdateRelationship(
            pool,
            sourceId,
            surviving.id,
            source.label,
            surviving.type,
            edge.label,
            userProps,
            { client },
          );
          transferred++;
        } catch {
          // Skip if transfer fails
        }
      }
    }
  } finally {
    client.release();
  }

  // Soft-delete the merged entity
  await softDeleteEntity(pool, schema, merged.id);

  return {
    surviving_id: surviving.id,
    merged_id: merged.id,
    relationships_transferred: transferred,
  };
}

// === Internal helpers ===

async function findEntityByNameAndType(
  pool: EngramPool,
  name: string,
  type: string,
): Promise<AgtypeVertex | null> {
  const query = buildMatchNode(pool.graphName, type, { name });
  const rows = await pool.executePrepared(query);

  if (rows.length === 0) return null;
  const vertex = rows[0][0] as AgtypeVertex;
  if (isSoftDeleted(vertex)) return null;
  return vertex;
}

/**
 * Search for entities by name across all valid types.
 * Returns matching vertices sorted by name similarity.
 */
async function searchByName(
  pool: EngramPool,
  schema: SchemaManager,
  name: string,
  limit: number,
): Promise<AgtypeVertex[]> {
  const results: AgtypeVertex[] = [];
  const lowerName = name.toLowerCase();

  for (const typeName of schema.getEntityTypeNames()) {
    // Match all non-deleted entities of this type and filter by name
    const query = buildPreparedQuery({
      graphName: pool.graphName,
      cypher: `MATCH (n:${typeName}) WHERE n._deleted IS NULL OR n._deleted <> true RETURN n`,
    });

    const rows = await pool.executePrepared(query);
    for (const row of rows) {
      const vertex = row[0] as AgtypeVertex;
      if (vertex && vertex.properties) {
        const entityName = String(vertex.properties.name ?? "").toLowerCase();
        if (entityName === lowerName || entityName.includes(lowerName)) {
          results.push(vertex);
        }
      }
    }
  }

  // Sort: exact matches first, then substring matches
  results.sort((a, b) => {
    const aName = String(a.properties.name ?? "").toLowerCase();
    const bName = String(b.properties.name ?? "").toLowerCase();
    const aExact = aName === lowerName ? 0 : 1;
    const bExact = bName === lowerName ? 0 : 1;
    return aExact - bExact;
  });

  return results.slice(0, limit);
}

function isSoftDeleted(vertex: AgtypeVertex): boolean {
  return vertex.properties._deleted === true;
}

function vertexToEntityResult(vertex: AgtypeVertex): EntityResult {
  const { id, name, ...rest } = vertex.properties;
  return {
    id: String(id),
    name: String(name ?? ""),
    type: vertex.label,
    properties: vertex.properties,
    created: false, // existing entity
  };
}

function isUUID(str: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    str,
  );
}

export { searchByName, isUUID };

export interface ListEntitiesResult {
  entities: Array<{ id: string; name: string; type: string; created_at: string }>;
  count: number;
}

/**
 * List all non-deleted entities, optionally filtered by type, ordered by name.
 */
export async function listEntities(
  pool: EngramPool,
  schema: SchemaManager,
  options: { type_filter?: string; limit?: number } = {},
): Promise<ListEntitiesResult> {
  const limit = options.limit ?? 50;
  const entities: Array<{ id: string; name: string; type: string; created_at: string }> = [];

  const typesToQuery = options.type_filter
    ? [options.type_filter]
    : schema.getEntityTypeNames();

  for (const typeName of typesToQuery) {
    if (options.type_filter && !schema.isValidEntityType(typeName)) {
      throw new Error(
        `Invalid entity type: "${typeName}". Valid types: ${schema.getEntityTypeNames().join(", ")}`,
      );
    }
    validateIdentifier(typeName, "entity type");

    const query = buildPreparedQuery({
      graphName: pool.graphName,
      cypher:
        `MATCH (n:${typeName}) ` +
        `WHERE n._deleted IS NULL OR n._deleted <> true ` +
        `RETURN n ORDER BY n.name`,
    });

    const rows = await pool.executePrepared(query);
    for (const row of rows) {
      const vertex = row[0] as AgtypeVertex;
      if (vertex?.properties) {
        entities.push({
          id: String(vertex.properties.id),
          name: String(vertex.properties.name ?? ""),
          type: vertex.label,
          created_at: String(vertex.properties.created_at ?? ""),
        });
      }
    }
  }

  // Sort by name across all types, then apply limit
  entities.sort((a, b) => a.name.localeCompare(b.name));
  const limited = entities.slice(0, limit);

  return {
    entities: limited,
    count: limited.length,
  };
}
