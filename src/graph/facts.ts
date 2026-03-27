/**
 * Fact supersession and contradiction detection.
 *
 * Facts are versioned knowledge claims attached to entities. When a fact is
 * superseded, the old Fact node is linked to the new one via SUPERSEDED_BY.
 * Contradiction detection finds active facts for an entity where the content
 * conflicts (simple: multiple non-superseded facts on same subject).
 */

import { randomUUID } from "node:crypto";
import type { EngramPool } from "../db/connection.js";
import type { AgtypeVertex, AgtypeEdge } from "../db/agtype.js";
import { buildPreparedQuery, validateIdentifier } from "../db/cypher.js";
import type { SchemaManager } from "../schema/manager.js";
import { resolveEntity } from "./search.js";

export interface SupersedeFactInput {
  /** Entity the fact is about (UUID or name) */
  entity: string;
  /** The new fact content */
  new_fact: string;
  /** The old fact content to supersede (optional — if omitted, creates standalone fact) */
  old_fact?: string;
  /** Source of the new fact */
  source?: string;
  /** Confidence in the new fact */
  confidence?: number;
}

export interface SupersedeFactResult {
  old_fact_id: string | null;
  new_fact_id: string;
  entity_id: string;
  superseded_at: string;
}

export interface FactResult {
  id: string;
  content: string;
  source?: string;
  confidence?: number;
  timestamp: string;
  superseded_by?: string;
  entity_id: string;
}

export interface ContradictionResult {
  entity_id: string;
  entity_name: string;
  facts: FactResult[];
}

/**
 * Supersede a fact for an entity.
 *
 * 1. Resolve the entity
 * 2. Create a new Fact node with new_fact content
 * 3. If old_fact specified: find or create old Fact node, link with SUPERSEDED_BY
 * 4. Link new fact to entity via RELATES_TO
 */
export async function supersedeFact(
  pool: EngramPool,
  schema: SchemaManager,
  input: SupersedeFactInput,
): Promise<SupersedeFactResult> {
  if (!input.new_fact || input.new_fact.trim().length === 0) {
    throw new Error("new_fact cannot be empty");
  }

  if (input.confidence !== undefined && (input.confidence < 0 || input.confidence > 1)) {
    throw new Error("Confidence must be between 0.0 and 1.0");
  }

  // Resolve entity
  const resolution = await resolveEntity(pool, schema, input.entity);
  if (!resolution.resolved) {
    if (resolution.needs_disambiguation) {
      throw new Error(
        `Ambiguous entity: "${input.entity}". Candidates: ${resolution.candidates.map((c) => `${c.name} (${c.type})`).join(", ")}`,
      );
    }
    throw new Error(`Entity not found: "${input.entity}"`);
  }

  const entity = resolution.entity;
  const now = new Date().toISOString();
  const newFactId = randomUUID();

  // Create new Fact node
  const newFactProps: Record<string, unknown> = {
    id: newFactId,
    name: input.new_fact.slice(0, 100), // Short name for display
    content: input.new_fact,
    timestamp: now,
    created_at: now,
  };
  if (input.source) newFactProps.source = input.source;
  if (input.confidence !== undefined) newFactProps.confidence = input.confidence;

  const propKeys = Object.keys(newFactProps);
  const propAssignment = propKeys.map((k) => `${k}: $${k}`).join(", ");

  const createFactQuery = buildPreparedQuery({
    graphName: pool.graphName,
    cypher: `CREATE (f:Fact {${propAssignment}}) RETURN f`,
    cypherParams: newFactProps,
  });
  await pool.executePrepared(createFactQuery);

  // Link new fact to entity via RELATES_TO
  validateIdentifier(entity.type, "entity type");
  const linkQuery = buildPreparedQuery({
    graphName: pool.graphName,
    cypher:
      `MATCH (e:${entity.type}), (f:Fact) ` +
      `WHERE e.id = $entity_id AND f.id = $fact_id ` +
      `CREATE (f)-[r:RELATES_TO]->(e) RETURN r`,
    cypherParams: { entity_id: entity.id, fact_id: newFactId },
  });
  await pool.executePrepared(linkQuery);

  let oldFactId: string | null = null;

  if (input.old_fact) {
    // Find existing Fact node with matching content for this entity
    const findOldQuery = buildPreparedQuery({
      graphName: pool.graphName,
      cypher:
        `MATCH (f:Fact)-[:RELATES_TO]->(e:${entity.type}) ` +
        `WHERE e.id = $entity_id AND f.content = $content ` +
        `AND (f._deleted IS NULL OR f._deleted <> true) ` +
        `RETURN f`,
      cypherParams: { entity_id: entity.id, content: input.old_fact },
    });
    const oldRows = await pool.executePrepared(findOldQuery);

    if (oldRows.length > 0) {
      const oldVertex = oldRows[0][0] as AgtypeVertex;
      oldFactId = String(oldVertex.properties.id);
    } else {
      // Create the old fact node so we can link it
      oldFactId = randomUUID();
      const oldFactProps: Record<string, unknown> = {
        id: oldFactId,
        name: input.old_fact.slice(0, 100),
        content: input.old_fact,
        timestamp: now,
        created_at: now,
        _superseded: true,
      };

      const oldPropKeys = Object.keys(oldFactProps);
      const oldPropAssignment = oldPropKeys.map((k) => `${k}: $${k}`).join(", ");

      const createOldQuery = buildPreparedQuery({
        graphName: pool.graphName,
        cypher: `CREATE (f:Fact {${oldPropAssignment}}) RETURN f`,
        cypherParams: oldFactProps,
      });
      await pool.executePrepared(createOldQuery);

      // Link old fact to entity
      const linkOldQuery = buildPreparedQuery({
        graphName: pool.graphName,
        cypher:
          `MATCH (e:${entity.type}), (f:Fact) ` +
          `WHERE e.id = $entity_id AND f.id = $fact_id ` +
          `CREATE (f)-[r:RELATES_TO]->(e) RETURN r`,
        cypherParams: { entity_id: entity.id, fact_id: oldFactId },
      });
      await pool.executePrepared(linkOldQuery);
    }

    // Create SUPERSEDED_BY edge from old to new
    const supersedeQuery = buildPreparedQuery({
      graphName: pool.graphName,
      cypher:
        `MATCH (old:Fact), (new:Fact) ` +
        `WHERE old.id = $old_id AND new.id = $new_id ` +
        `CREATE (old)-[r:SUPERSEDED_BY {superseded_at: $superseded_at}]->(new) ` +
        `RETURN r`,
      cypherParams: {
        old_id: oldFactId,
        new_id: newFactId,
        superseded_at: now,
      },
    });
    await pool.executePrepared(supersedeQuery);

    // Mark old fact as superseded
    const markOldQuery = buildPreparedQuery({
      graphName: pool.graphName,
      cypher:
        `MATCH (f:Fact) WHERE f.id = $fact_id ` +
        `SET f._superseded = true RETURN f`,
      cypherParams: { fact_id: oldFactId },
    });
    await pool.executePrepared(markOldQuery);
  }

  return {
    old_fact_id: oldFactId,
    new_fact_id: newFactId,
    entity_id: entity.id,
    superseded_at: now,
  };
}

/**
 * Find contradictions for an entity.
 *
 * Returns all active (non-superseded) facts related to the entity.
 * Multiple active facts about the same entity may indicate contradictions.
 * The bot decides which facts actually contradict — we just surface them.
 */
export async function findContradictions(
  pool: EngramPool,
  schema: SchemaManager,
  identifier: string,
): Promise<ContradictionResult> {
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

  // Find all non-superseded facts for this entity
  const factsQuery = buildPreparedQuery({
    graphName: pool.graphName,
    cypher:
      `MATCH (f:Fact)-[:RELATES_TO]->(e:${entity.type}) ` +
      `WHERE e.id = $entity_id ` +
      `AND (f._deleted IS NULL OR f._deleted <> true) ` +
      `AND (f._superseded IS NULL OR f._superseded <> true) ` +
      `RETURN f ORDER BY f.timestamp`,
    cypherParams: { entity_id: entity.id },
  });

  const rows = await pool.executePrepared(factsQuery);

  const facts: FactResult[] = rows.map((row) => {
    const vertex = row[0] as AgtypeVertex;
    return {
      id: String(vertex.properties.id),
      content: String(vertex.properties.content ?? ""),
      source: vertex.properties.source as string | undefined,
      confidence: vertex.properties.confidence as number | undefined,
      timestamp: String(vertex.properties.timestamp ?? ""),
      entity_id: entity.id,
    };
  });

  return {
    entity_id: entity.id,
    entity_name: entity.name,
    facts,
  };
}
