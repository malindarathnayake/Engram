/**
 * Entity search operations.
 *
 * Provides fuzzy name matching across all entity types with disambiguation support.
 */

import type { EngramPool } from "../db/connection.js";
import type { AgtypeVertex } from "../db/agtype.js";
import { buildPreparedQuery, validateIdentifier } from "../db/cypher.js";
import type { SchemaManager } from "../schema/manager.js";

export interface SearchResult {
  id: string;
  name: string;
  type: string;
  score: number;
  properties: Record<string, unknown>;
}

export interface SearchOptions {
  /** Maximum number of results to return */
  limit?: number;
  /** Filter to specific entity type */
  type_filter?: string;
  /** When true, return only exact matches (score === 1.0) */
  exact?: boolean;
}

/**
 * Search entities by name with fuzzy matching.
 *
 * Returns matching entities sorted by relevance:
 * 1. Exact match (case-insensitive)
 * 2. Starts-with match
 * 3. Contains match
 *
 * If type_filter is specified, only searches that entity type.
 */
export async function searchEntities(
  pool: EngramPool,
  schema: SchemaManager,
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  const limit = options.limit ?? 10;

  if (!query || query.trim().length === 0) {
    return [];
  }

  const normalizedQuery = query.trim().toLowerCase();
  const results: SearchResult[] = [];

  const typesToSearch = options.type_filter
    ? [options.type_filter]
    : schema.getEntityTypeNames();

  for (const typeName of typesToSearch) {
    if (options.type_filter && !schema.isValidEntityType(typeName)) {
      throw new Error(
        `Invalid entity type filter: "${typeName}". Valid types: ${schema.getEntityTypeNames().join(", ")}`,
      );
    }

    validateIdentifier(typeName, "entity type");

    // Fetch all non-deleted entities of this type
    const cypherQuery = buildPreparedQuery({
      graphName: pool.graphName,
      cypher: `MATCH (n:${typeName}) WHERE n._deleted IS NULL OR n._deleted <> true RETURN n`,
    });

    const rows = await pool.executePrepared(cypherQuery);

    for (const row of rows) {
      const vertex = row[0] as AgtypeVertex;
      if (!vertex || !vertex.properties) continue;

      const entityName = String(vertex.properties.name ?? "");
      const lowerName = entityName.toLowerCase();

      let score = 0;
      if (lowerName === normalizedQuery) {
        score = 1.0; // Exact match
      } else if (lowerName.startsWith(normalizedQuery)) {
        score = 0.8; // Starts-with
      } else if (lowerName.includes(normalizedQuery)) {
        score = 0.6; // Contains
      } else if (normalizedQuery.includes(lowerName)) {
        score = 0.4; // Query contains entity name
      }

      if (score > 0) {
        results.push({
          id: String(vertex.properties.id),
          name: entityName,
          type: vertex.label,
          score,
          properties: vertex.properties,
        });
      }
    }
  }

  // Sort by score (descending), then by name length (shorter = more relevant)
  results.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.length - b.name.length;
  });

  const filtered = options.exact
    ? results.filter((r) => r.score === 1.0)
    : results;

  return filtered.slice(0, limit);
}

/**
 * Resolve an entity identifier (UUID or name) to a definite entity.
 * Returns the entity if unambiguous, or a disambiguation list if multiple matches.
 */
export async function resolveEntity(
  pool: EngramPool,
  schema: SchemaManager,
  identifier: string,
): Promise<
  | { resolved: true; entity: SearchResult }
  | { resolved: false; needs_disambiguation: true; candidates: SearchResult[] }
  | { resolved: false; needs_disambiguation: false; candidates: [] }
> {
  // UUID: direct lookup
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier)) {
    for (const typeName of schema.getEntityTypeNames()) {
      validateIdentifier(typeName, "entity type");

      const cypherQuery = buildPreparedQuery({
        graphName: pool.graphName,
        cypher: `MATCH (n:${typeName}) WHERE n.id = $id AND (n._deleted IS NULL OR n._deleted <> true) RETURN n`,
        cypherParams: { id: identifier },
      });

      const rows = await pool.executePrepared(cypherQuery);
      if (rows.length > 0) {
        const vertex = rows[0][0] as AgtypeVertex;
        return {
          resolved: true,
          entity: {
            id: String(vertex.properties.id),
            name: String(vertex.properties.name ?? ""),
            type: vertex.label,
            score: 1.0,
            properties: vertex.properties,
          },
        };
      }
    }

    return { resolved: false, needs_disambiguation: false, candidates: [] };
  }

  // Name: fuzzy search
  const matches = await searchEntities(pool, schema, identifier, { limit: 5 });

  if (matches.length === 0) {
    return { resolved: false, needs_disambiguation: false, candidates: [] };
  }

  if (matches.length === 1) {
    return { resolved: true, entity: matches[0] };
  }

  // Check if the top match is an exact match and significantly better than second
  if (matches[0].score === 1.0 && matches[1].score < 1.0) {
    return { resolved: true, entity: matches[0] };
  }

  return {
    resolved: false,
    needs_disambiguation: true,
    candidates: matches,
  };
}
