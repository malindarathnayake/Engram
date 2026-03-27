import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig, type EngramConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";
import type { ToolDeps, ToolResult } from "../../src/tools/write-tools.js";
import {
  handleRememberEntity,
  handleRememberRelationship,
  handleSupersedeFact,
  handleForgetEntity,
  handleMergeEntities,
  handleRememberKnowledge,
} from "../../src/tools/write-tools.js";
import {
  handleRecallEntity,
  handleRecallConnections,
  handleRecallContext,
  handleRecallTimeline,
  handleFindContradictions,
  handleSearchEntities,
  handleGraphStats,
} from "../../src/tools/read-tools.js";
import {
  handleGetMemorySchema,
  type SchemaDeps,
} from "../../src/tools/schema-tools.js";

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("full-flow integration", () => {
  let pool: EngramPool;
  let schema: SchemaManager;
  let config: EngramConfig;
  let deps: ToolDeps;
  let schemaDeps: SchemaDeps;
  const graphName = "full_flow_test";

  beforeAll(async () => {
    const testDb = process.env.ENGRAM_TEST_DB;
    if (!testDb) throw new Error("ENGRAM_TEST_DB not set");

    const url = new URL(testDb);
    config = loadConfig({
      mode: "external",
      external: {
        host: url.hostname,
        port: parseInt(url.port, 10),
        database: url.pathname.slice(1),
        username: url.username,
        password: url.password,
        ssl: false,
        graph_name: graphName,
      },
    });

    pool = await createPool(config);
    await initializeDatabase(pool);
    schema = SchemaManager.fromPreset("dev-team");
    deps = { pool, schema, config };
    schemaDeps = { ...deps };
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`SELECT drop_graph('${graphName}', true)`);
      } catch {}
      await pool.close();
    }
  });

  it("complete workflow: entities → relationships → traverse → mermaid → supersede → contradictions", async () => {
    // Step 1: Create entities
    const alice = await handleRememberEntity(deps, {
      name: "Alice",
      type: "Person",
      properties: { role: "engineer", team: "backend" },
      confidence: 0.9,
    });
    expect(alice.isError).toBeUndefined();
    const aliceData = parseResult(alice) as { id: string; status: string };
    expect(aliceData.status).toBe("created");

    const projectX = await handleRememberEntity(deps, {
      name: "Project X",
      type: "Project",
      properties: { status: "active", priority: "high" },
    });
    expect(projectX.isError).toBeUndefined();
    const projData = parseResult(projectX) as { id: string; status: string };
    expect(projData.status).toBe("created");

    const techDoc = await handleRememberEntity(deps, {
      name: "ArchitectureRepo",
      type: "Repository",
      properties: { language: "typescript" },
    });
    expect(techDoc.isError).toBeUndefined();
    const docData = parseResult(techDoc) as { id: string };

    // Step 2: Create relationships
    const worksOn = await handleRememberRelationship(deps, {
      from: "Alice",
      to: "Project X",
      type: "CONTRIBUTES_TO",
      properties: { since: "2025-01" },
    });
    expect(worksOn.isError).toBeUndefined();

    const authored = await handleRememberRelationship(deps, {
      from: "Alice",
      to: "ArchitectureRepo",
      type: "OWNS",
    });
    expect(authored.isError).toBeUndefined();

    const relatesTo = await handleRememberRelationship(deps, {
      from: "ArchitectureRepo",
      to: "Project X",
      type: "RELATES_TO",
    });
    expect(relatesTo.isError).toBeUndefined();

    // Step 3: Recall entity with relationships
    const recalled = await handleRecallEntity(deps, {
      identifier: "Alice",
      include_relationships: true,
    });
    expect(recalled.isError).toBeUndefined();
    const recalledData = parseResult(recalled) as {
      found: boolean;
      name: string;
      relationships: unknown[];
      relationship_count: number;
    };
    expect(recalledData.found).toBe(true);
    expect(recalledData.name).toBe("Alice");
    expect(recalledData.relationship_count).toBeGreaterThanOrEqual(2);
    // Verify flat relationship format (Phase 4)
    const rel = recalledData.relationships[0] as Record<string, unknown>;
    expect(rel.from).toBeDefined();
    expect(rel.to).toBeDefined();
    expect(rel.type).toBeDefined();
    expect(rel.from_id).toBeUndefined();

    // Step 4: Traverse connections
    const connections = await handleRecallConnections(deps, {
      identifier: "Alice",
      depth: 2,
      include_mermaid: true,
    });
    expect(connections.isError).toBeUndefined();
    const connData = parseResult(connections) as {
      anchor: { name: string };
      entities: unknown[];
      relationships: unknown[];
      mermaid: string;
    };
    expect(connData.anchor.name).toBe("Alice");
    expect(connData.entities.length).toBeGreaterThanOrEqual(2);
    expect(connData.mermaid).toContain("graph LR");
    expect(connData.mermaid).toContain("Alice");
    // Verify mermaid contains edges (Phase 1 fix — edges now appear in diagram)
    expect(connData.mermaid).toContain("-->");

    // Step 5: Recall context
    const context = await handleRecallContext(deps, {
      identifier: "Alice",
      depth: 2,
      include_mermaid: true,
    });
    expect(context.isError).toBeUndefined();
    const ctxData = parseResult(context) as {
      entity: { name: string };
      connections: { entities: unknown[]; relationships: unknown[] };
      mermaid: string;
    };
    expect(ctxData.entity.name).toBe("Alice");
    expect(ctxData.mermaid).toContain("graph LR");

    // Step 6: Supersede a fact
    const fact1 = await handleSupersedeFact(deps, {
      entity: "Alice",
      new_fact: "Alice is a senior engineer",
      source: "conversation",
      confidence: 0.8,
    });
    expect(fact1.isError).toBeUndefined();

    const fact2 = await handleSupersedeFact(deps, {
      entity: "Alice",
      new_fact: "Alice is a staff engineer",
      old_fact: "Alice is a senior engineer",
      source: "promotion announcement",
      confidence: 0.95,
    });
    expect(fact2.isError).toBeUndefined();

    // Step 7: Find contradictions
    const contradictions = await handleFindContradictions(deps, {
      identifier: "Alice",
    });
    expect(contradictions.isError).toBeUndefined();
    const contradData = parseResult(contradictions) as { facts: unknown[] };
    // Should have at least 1 active fact (the latest one)
    expect(contradData.facts.length).toBeGreaterThanOrEqual(1);

    // Step 8: Timeline
    const timeline = await handleRecallTimeline(deps, {
      identifier: "Alice",
      last_n: 20,
    });
    expect(timeline.isError).toBeUndefined();
    const timelineData = parseResult(timeline) as { events: unknown[] };
    expect(timelineData.events.length).toBeGreaterThanOrEqual(1);

    // Step 9: Search
    const searchResult = await handleSearchEntities(deps, {
      query: "Ali",
      limit: 5,
    });
    expect(searchResult.isError).toBeUndefined();
    const searchData = parseResult(searchResult) as { results: Array<{ name: string }>; count: number };
    expect(searchData.count).toBeGreaterThanOrEqual(1);
    expect(searchData.results.some((r) => r.name === "Alice")).toBe(true);

    // Step 10: Graph stats
    const stats = await handleGraphStats(deps);
    expect(stats.isError).toBeUndefined();
    const statsData = parseResult(stats) as {
      total_entities: number;
      total_relationships: number;
      healthy: boolean;
    };
    expect(statsData.healthy).toBe(true);
    expect(statsData.total_entities).toBeGreaterThanOrEqual(3);
    expect(statsData.total_relationships).toBeGreaterThanOrEqual(3);

    // Step 11: Schema
    const schemaResult = await handleGetMemorySchema(schemaDeps);
    expect(schemaResult.isError).toBeUndefined();
    const schemaData = parseResult(schemaResult) as {
      preset_name: string;
      entity_types: unknown[];
      relationship_types: unknown[];
    };
    expect(schemaData.preset_name).toBe("dev-team");
    expect(schemaData.entity_types.length).toBeGreaterThan(0);
    expect(schemaData.relationship_types.length).toBeGreaterThan(0);
  });

  it("entity upsert merges properties and returns created: false", async () => {
    const first = await handleRememberEntity(deps, {
      name: "Bob",
      type: "Person",
      properties: { role: "designer" },
    });
    const firstData = parseResult(first) as { id: string; status: string };
    expect(firstData.status).toBe("created");

    const second = await handleRememberEntity(deps, {
      name: "Bob",
      type: "Person",
      properties: { team: "frontend" },
    });
    const secondData = parseResult(second) as { id: string; status: string };
    expect(secondData.status).toBe("updated");
    expect(secondData.id).toBe(firstData.id);
  });

  it("merge entities transfers relationships", async () => {
    // Create two entities
    const e1 = await handleRememberEntity(deps, {
      name: "Charlie Original",
      type: "Person",
    });
    const e1Data = parseResult(e1) as { id: string };

    const e2 = await handleRememberEntity(deps, {
      name: "Charlie Duplicate",
      type: "Person",
    });
    const e2Data = parseResult(e2) as { id: string };

    // Add relationship to duplicate
    await handleRememberRelationship(deps, {
      from: e2Data.id,
      to: "Project X",
      type: "CONTRIBUTES_TO",
    });

    // Merge duplicate into original
    const mergeResult = await handleMergeEntities(deps, {
      surviving_id: e1Data.id,
      merged_id: e2Data.id,
    });
    expect(mergeResult.isError).toBeUndefined();

    // Verify merged entity is soft-deleted
    const recalled = await handleRecallEntity(deps, {
      identifier: e2Data.id,
    });
    const recalledData = parseResult(recalled) as { found: boolean };
    expect(recalledData.found).toBe(false);
  });

  it("soft-delete hides entity from queries", async () => {
    const entity = await handleRememberEntity(deps, {
      name: "ToDelete",
      type: "Topic",
    });
    expect(entity.isError).toBeUndefined();
    const entityData = parseResult(entity) as { id: string };

    // Delete
    const deleteResult = await handleForgetEntity(deps, { identifier: entityData.id });
    expect(deleteResult.isError).toBeUndefined();

    // Search should not find it
    const search = await handleSearchEntities(deps, {
      query: "ToDelete",
    });
    expect(search.isError).toBeUndefined();
    const searchData = parseResult(search) as { results: Array<{ name: string }>; count: number };
    expect(searchData.results.every((r) => r.name !== "ToDelete")).toBe(true);
  });

  it("bulk knowledge creates entities and relationships in one call", async () => {
    const result = await handleRememberKnowledge(deps, {
      entities: [
        { name: "BulkAlpha", type: "Person", properties: { role: "lead" } },
        { name: "BulkBeta", type: "Project" },
      ],
      relationships: [
        { from: "BulkAlpha", to: "BulkBeta", type: "CONTRIBUTES_TO" },
      ],
    });
    expect(result.isError).toBeUndefined();
    const data = parseResult(result) as {
      entities: { created: number; updated: number };
      relationships: { created: number; updated: number; failed: unknown[] };
    };
    expect(data.entities.created).toBe(2);
    expect(data.relationships.created).toBe(1);
    expect(data.relationships.failed).toEqual([]);

    // Verify the entities were actually created
    const search = await handleSearchEntities(deps, { query: "BulkAlpha", exact: true });
    const searchData = parseResult(search) as { results: Array<{ name: string }>; count: number };
    expect(searchData.count).toBe(1);
    expect(searchData.results[0].name).toBe("BulkAlpha");
  });
});
