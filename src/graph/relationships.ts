/**
 * Relationship CRUD operations.
 *
 * Relationships connect two entities with a validated relationship type.
 * Entity resolution supports both UUID and name-based lookup with disambiguation.
 */

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { EngramPool } from "../db/connection.js";
import type { AgtypeEdge, AgtypeVertex } from "../db/agtype.js";
import { parseAgtype } from "../db/agtype.js";
import { buildPreparedQuery, validateIdentifier, validatePropertyKey } from "../db/cypher.js";
import type { SchemaManager } from "../schema/manager.js";
import { resolveEntity, type SearchResult } from "./search.js";

export interface RelationshipInput {
  from: string; // UUID or name
  to: string; // UUID or name
  type: string;
  properties?: Record<string, unknown>;
}

export interface RelationshipResult {
  id: string;
  from_id: string;
  to_id: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface UpsertRelationshipResult extends RelationshipResult {
  created: boolean;
}

export const RESERVED_REL_KEYS = new Set([
  "type", "from", "to", "id", "created_at", "updated_at",
]);

function validateRelationshipProperties(
  properties: Record<string, unknown>,
): void {
  for (const key of Object.keys(properties)) {
    if (RESERVED_REL_KEYS.has(key)) {
      throw new Error(`'${key}' is a reserved relationship field`);
    }
    validatePropertyKey(key);
  }
}

export interface RelationshipQueryResult {
  relationships: RelationshipResult[];
  total_count: number;
  entity_names: Map<string, string>;
}

export interface DisambiguationResult {
  needs_disambiguation: true;
  field: "from" | "to";
  candidates: SearchResult[];
}

/**
 * Create or update a relationship between two entities by their IDs and types.
 *
 * If a relationship of the same type already exists between the two entities,
 * updates it with the new properties. Otherwise creates a new relationship.
 * Reserved property keys are rejected.
 */
export async function createOrUpdateRelationship(
  pool: EngramPool,
  fromId: string,
  toId: string,
  fromType: string,
  toType: string,
  relType: string,
  properties: Record<string, unknown>,
  options?: { client?: pg.PoolClient },
): Promise<UpsertRelationshipResult> {
  validateRelationshipProperties(properties);
  validateIdentifier(relType, "relationship type");
  validateIdentifier(fromType, "from entity type");
  validateIdentifier(toType, "to entity type");

  const ownedClient = !options?.client;
  const client = options?.client ?? (await pool.acquireWriteConnection());

  try {
    // Check for existing relationship
    const checkQuery = buildPreparedQuery({
      graphName: pool.graphName,
      cypher:
        `MATCH (a:${fromType})-[r:${relType}]->(b:${toType}) ` +
        `WHERE a.id = $from_id AND b.id = $to_id RETURN r`,
      cypherParams: { from_id: fromId, to_id: toId },
      columns: [["r", "agtype"]],
    });

    const checkResult = await client.query(checkQuery.sql, checkQuery.params);
    const rows = checkResult.rows;

    if (rows.length > 0) {
      // Relationship exists — update it
      const rawEdge = Object.values(rows[0])[0] as string;
      const existingEdge = parseAgtype(rawEdge) as AgtypeEdge;
      const existingProps = existingEdge.properties ?? {};

      const updateProps: Record<string, unknown> = {
        ...properties,
        updated_at: new Date().toISOString(),
      };

      const cypherParams: Record<string, unknown> = {
        from_id: fromId,
        to_id: toId,
      };
      const propAssignments = Object.keys(updateProps).map((k) => {
        cypherParams[`rel_${k}`] = updateProps[k];
        return `r.${k} = $rel_${k}`;
      });

      const setClause = propAssignments.length > 0
        ? ` SET ${propAssignments.join(", ")}`
        : "";

      const updateQuery = buildPreparedQuery({
        graphName: pool.graphName,
        cypher:
          `MATCH (a:${fromType})-[r:${relType}]->(b:${toType}) ` +
          `WHERE a.id = $from_id AND b.id = $to_id${setClause}`,
        cypherParams,
      });

      await client.query(updateQuery.sql, updateQuery.params);

      const mergedProps = { ...existingProps, ...updateProps };

      return {
        id: String(existingProps.id ?? existingEdge.id),
        from_id: fromId,
        to_id: toId,
        type: relType,
        properties: mergedProps,
        created: false,
      };
    } else {
      // Relationship does not exist — create it
      const relId = randomUUID();
      const relProps: Record<string, unknown> = {
        id: relId,
        ...properties,
        created_at: new Date().toISOString(),
      };

      const cypherParams: Record<string, unknown> = {
        from_id: fromId,
        to_id: toId,
      };
      const propKeys = Object.keys(relProps);
      let relPropsClause = "";
      if (propKeys.length > 0) {
        const propAssignments = propKeys.map((k) => {
          cypherParams[`rel_${k}`] = relProps[k];
          return `${k}: $rel_${k}`;
        });
        relPropsClause = ` {${propAssignments.join(", ")}}`;
      }

      const createQuery = buildPreparedQuery({
        graphName: pool.graphName,
        cypher:
          `MATCH (a:${fromType}), (b:${toType}) ` +
          `WHERE a.id = $from_id AND b.id = $to_id ` +
          `CREATE (a)-[r:${relType}${relPropsClause}]->(b) RETURN r`,
        cypherParams,
      });

      await client.query(createQuery.sql, createQuery.params);

      return {
        id: relId,
        from_id: fromId,
        to_id: toId,
        type: relType,
        properties: relProps,
        created: true,
      };
    }
  } finally {
    if (ownedClient) {
      client.release();
    }
  }
}

/**
 * Create a relationship between two entities.
 *
 * Resolves from/to by UUID or name. If a name resolves to multiple entities,
 * returns a disambiguation result instead of creating the relationship.
 */
export async function createRelationship(
  pool: EngramPool,
  schema: SchemaManager,
  input: RelationshipInput,
): Promise<UpsertRelationshipResult | DisambiguationResult> {
  // Validate relationship type
  if (!schema.isValidRelationshipType(input.type)) {
    throw new Error(
      `Invalid relationship type: "${input.type}". Valid types: ${schema.getRelationshipTypeNames().join(", ")}`,
    );
  }
  validateIdentifier(input.type, "relationship type");

  // Resolve from entity
  const fromResolution = await resolveEntity(pool, schema, input.from);
  if (!fromResolution.resolved) {
    if (fromResolution.needs_disambiguation) {
      return {
        needs_disambiguation: true,
        field: "from",
        candidates: fromResolution.candidates,
      };
    }
    throw new Error(`Entity not found: "${input.from}"`);
  }

  // Resolve to entity
  const toResolution = await resolveEntity(pool, schema, input.to);
  if (!toResolution.resolved) {
    if (toResolution.needs_disambiguation) {
      return {
        needs_disambiguation: true,
        field: "to",
        candidates: toResolution.candidates,
      };
    }
    throw new Error(`Entity not found: "${input.to}"`);
  }

  const fromEntity = fromResolution.entity;
  const toEntity = toResolution.entity;

  const result = await createOrUpdateRelationship(
    pool,
    fromEntity.id,
    toEntity.id,
    fromEntity.type,
    toEntity.type,
    input.type,
    input.properties ?? {},
  );

  return result;
}

/**
 * Get relationships for an entity.
 * Returns both incoming and outgoing relationships.
 */
export async function getRelationships(
  pool: EngramPool,
  schema: SchemaManager,
  identifier: string,
  options: {
    direction?: "in" | "out" | "both";
    type_filter?: string;
    limit?: number;
  } = {},
): Promise<RelationshipQueryResult> {
  const direction = options.direction ?? "both";
  const limit = options.limit ?? 50;

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

  const relationships: RelationshipResult[] = [];
  const entityNames = new Map<string, string>();

  // Build query based on direction
  if (direction === "out" || direction === "both") {
    const typeFilter = options.type_filter
      ? `:${options.type_filter}`
      : "";

    if (options.type_filter) {
      validateIdentifier(options.type_filter, "relationship type filter");
    }

    const outQuery = buildPreparedQuery({
      graphName: pool.graphName,
      cypher:
        `MATCH (a:${entity.type})-[r${typeFilter}]->(b) ` +
        `WHERE a.id = $entity_id AND (b._deleted IS NULL OR b._deleted <> true) ` +
        `RETURN r, b LIMIT ${limit}`,
      cypherParams: { entity_id: entity.id },
      columns: [
        ["r", "agtype"],
        ["b", "agtype"],
      ],
    });

    const outRows = await pool.executePrepared(outQuery);
    for (const row of outRows) {
      const edge = row[0] as AgtypeEdge;
      const target = row[1] as AgtypeVertex;
      if (edge && target) {
        const targetId = String(target.properties?.id ?? target.id);
        entityNames.set(targetId, String(target.properties?.name ?? ""));
        relationships.push({
          id: String(edge.properties?.id ?? edge.id),
          from_id: entity.id,
          to_id: targetId,
          type: edge.label,
          properties: edge.properties ?? {},
        });
      }
    }
  }

  if (direction === "in" || direction === "both") {
    const typeFilter = options.type_filter
      ? `:${options.type_filter}`
      : "";

    if (options.type_filter) {
      validateIdentifier(options.type_filter, "relationship type filter");
    }

    const inQuery = buildPreparedQuery({
      graphName: pool.graphName,
      cypher:
        `MATCH (a)-[r${typeFilter}]->(b:${entity.type}) ` +
        `WHERE b.id = $entity_id AND (a._deleted IS NULL OR a._deleted <> true) ` +
        `RETURN a, r LIMIT ${limit}`,
      cypherParams: { entity_id: entity.id },
      columns: [
        ["a", "agtype"],
        ["r", "agtype"],
      ],
    });

    const inRows = await pool.executePrepared(inQuery);
    for (const row of inRows) {
      const source = row[0] as AgtypeVertex;
      const edge = row[1] as AgtypeEdge;
      if (source && edge) {
        const sourceId = String(source.properties?.id ?? source.id);
        entityNames.set(sourceId, String(source.properties?.name ?? ""));
        relationships.push({
          id: String(edge.properties?.id ?? edge.id),
          from_id: sourceId,
          to_id: entity.id,
          type: edge.label,
          properties: edge.properties ?? {},
        });
      }
    }
  }

  return {
    relationships,
    total_count: relationships.length,
    entity_names: entityNames,
  };
}
