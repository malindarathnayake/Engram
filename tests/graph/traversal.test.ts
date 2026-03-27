import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig, type EngramConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";
import { createOrUpdateEntity } from "../../src/graph/entities.js";
import { createRelationship } from "../../src/graph/relationships.js";
import {
  recallConnections,
  recallContext,
  recallTimeline,
} from "../../src/graph/traversal.js";

describe("graph traversal", () => {
  let pool: EngramPool;
  let schema: SchemaManager;
  let config: EngramConfig;
  const graphName = "traversal_test";

  let aliceId: string;
  let bobId: string;
  let charlieId: string;
  let projectId: string;
  let teamId: string;

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

    // Build test graph:
    // Alice --MANAGES--> Bob --COLLABORATES_WITH--> Charlie
    // Alice --OWNS--> Project Atlas
    // Bob --WORKS_AT--> Platform Team
    const alice = await createOrUpdateEntity(pool, schema, {
      name: "Alice",
      type: "Person",
      properties: { role: "CTO" },
    });
    aliceId = alice.id;

    const bob = await createOrUpdateEntity(pool, schema, {
      name: "Bob",
      type: "Person",
      properties: { role: "Engineer" },
    });
    bobId = bob.id;

    const charlie = await createOrUpdateEntity(pool, schema, {
      name: "Charlie",
      type: "Person",
      properties: { role: "Designer" },
    });
    charlieId = charlie.id;

    const project = await createOrUpdateEntity(pool, schema, {
      name: "Project Atlas",
      type: "Project",
      properties: { status: "active" },
    });
    projectId = project.id;

    const team = await createOrUpdateEntity(pool, schema, {
      name: "Platform Team",
      type: "Team",
      properties: { focus: "infrastructure" },
    });
    teamId = team.id;

    await createRelationship(pool, schema, {
      from: aliceId,
      to: bobId,
      type: "REPORTS_TO",
    });
    await createRelationship(pool, schema, {
      from: bobId,
      to: charlieId,
      type: "COLLABORATES_WITH",
    });
    await createRelationship(pool, schema, {
      from: aliceId,
      to: projectId,
      type: "OWNS",
    });
    await createRelationship(pool, schema, {
      from: bobId,
      to: teamId,
      type: "WORKS_AT",
    });
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`SELECT drop_graph('${graphName}', true)`);
      } catch { /* ignore */ }
      await pool.close();
    }
  });

  describe("recallConnections", () => {
    it("traverses depth 1 from anchor", async () => {
      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 1,
      });

      expect(result.anchor.id).toBe(aliceId);
      expect(result.anchor.name).toBe("Alice");
      expect(result.depth).toBe(1);

      // At depth 1: Alice connects to Bob and Project Atlas
      const entityNames = result.entities.map((e) => e.name);
      expect(entityNames).toContain("Bob");
      expect(entityNames).toContain("Project Atlas");
    });

    it("traverses depth 2 from anchor", async () => {
      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 2,
      });

      // At depth 2: Alice -> Bob -> Charlie, Platform Team
      const entityNames = result.entities.map((e) => e.name);
      expect(entityNames).toContain("Bob");
      expect(entityNames).toContain("Charlie");
      expect(entityNames).toContain("Platform Team");
    });

    it("respects result limit", async () => {
      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 3,
        limit: 2,
      });

      expect(result.entities.length).toBeLessThanOrEqual(2);
    });

    it("returns truncated flag when results exceed limit", async () => {
      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 3,
        limit: 1,
      });

      if (result.total_count > 1) {
        expect(result.truncated).toBe(true);
      }
    });

    it("filters by relationship type", async () => {
      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 2,
        relationship_types: ["OWNS"],
      });

      // Only OWNS relationships — should find Project Atlas
      const entityNames = result.entities.map((e) => e.name);
      expect(entityNames).toContain("Project Atlas");
      // Should NOT find Bob (connected via REPORTS_TO)
      expect(entityNames).not.toContain("Bob");
    });

    it("resolves anchor by name", async () => {
      const result = await recallConnections(pool, schema, "Alice", config, {
        depth: 1,
      });

      expect(result.anchor.id).toBe(aliceId);
    });

    it("throws for non-existent entity", async () => {
      await expect(
        recallConnections(
          pool,
          schema,
          "00000000-0000-0000-0000-000000000000",
          config,
        ),
      ).rejects.toThrow("Entity not found");
    });

    it("rejects invalid depth", async () => {
      await expect(
        recallConnections(pool, schema, aliceId, config, { depth: 0 }),
      ).rejects.toThrow("Invalid depth");
    });

    it("rejects limit exceeding max", async () => {
      await expect(
        recallConnections(pool, schema, aliceId, config, {
          limit: config.query_limits.max_limit + 1,
        }),
      ).rejects.toThrow("Limit must be between");
    });

    it("includes relationships in result", async () => {
      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 1,
      });

      expect(result.relationships.length).toBeGreaterThanOrEqual(1);
      for (const rel of result.relationships) {
        expect(rel.type).toBeDefined();
        expect(rel.from_id).toBeDefined();
        expect(rel.to_id).toBeDefined();
      }
    });

    it("filters out soft-deleted entities", async () => {
      // Create and soft-delete an entity connected to Alice
      const temp = await createOrUpdateEntity(pool, schema, {
        name: "TempDeletedPerson",
        type: "Person",
      });
      await createRelationship(pool, schema, {
        from: aliceId,
        to: temp.id,
        type: "COLLABORATES_WITH",
      });

      // Soft-delete
      const { softDeleteEntity } = await import("../../src/graph/entities.js");
      await softDeleteEntity(pool, schema, temp.id);

      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 1,
      });

      const entityNames = result.entities.map((e) => e.name);
      expect(entityNames).not.toContain("TempDeletedPerson");
    });

    it("returns entities and relationships at depth > 1 (3-hop graph)", async () => {
      // Graph: Alice → Bob → Charlie (depth 2 from Alice)
      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 3,
      });

      const entityNames = result.entities.map((e) => e.name);
      expect(entityNames).toContain("Bob");
      expect(entityNames).toContain("Charlie");
      expect(entityNames).toContain("Platform Team");
      expect(entityNames).toContain("Project Atlas");

      // Should have relationships at all depths
      expect(result.relationships.length).toBeGreaterThanOrEqual(4);
      // Verify multi-hop relationships present (not just depth-1)
      const relTypes = result.relationships.map((r) => r.type);
      expect(relTypes).toContain("COLLABORATES_WITH"); // Bob → Charlie (depth 2 from Alice)
      expect(relTypes).toContain("WORKS_AT"); // Bob → Platform Team (depth 2 from Alice)
    });

    it("excludes relationships of filtered types with relationship_types filter", async () => {
      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 2,
        relationship_types: ["OWNS"],
      });

      // Should find Project Atlas via OWNS
      const entityNames = result.entities.map((e) => e.name);
      expect(entityNames).toContain("Project Atlas");

      // Should NOT find entities only reachable via other types
      expect(entityNames).not.toContain("Bob");
      expect(entityNames).not.toContain("Charlie");

      // All returned relationships should be OWNS type only
      for (const rel of result.relationships) {
        expect(rel.type).toBe("OWNS");
      }
    });

    it("prevents traversal through soft-deleted intermediate nodes", async () => {
      // Create chain: Alice → Intermediate → Endpoint
      const intermediate = await createOrUpdateEntity(pool, schema, {
        name: "RT_Intermediate",
        type: "Person",
      });
      const endpoint = await createOrUpdateEntity(pool, schema, {
        name: "RT_Endpoint",
        type: "Person",
      });
      await createRelationship(pool, schema, {
        from: aliceId,
        to: intermediate.id,
        type: "COLLABORATES_WITH",
      });
      await createRelationship(pool, schema, {
        from: intermediate.id,
        to: endpoint.id,
        type: "COLLABORATES_WITH",
      });

      // Soft-delete the intermediate
      const { softDeleteEntity } = await import("../../src/graph/entities.js");
      await softDeleteEntity(pool, schema, intermediate.id);

      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 3,
      });

      const entityNames = result.entities.map((e) => e.name);
      // Intermediate is deleted — should be excluded
      expect(entityNames).not.toContain("RT_Intermediate");
      // Endpoint is only reachable through deleted intermediate — should also be excluded
      expect(entityNames).not.toContain("RT_Endpoint");
    });

    it("maps all relationship from_id/to_id to UUIDs (not AGE internal IDs)", async () => {
      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 2,
      });

      // Collect all entity UUIDs (anchor + connected)
      const allUuids = new Set([
        result.anchor.id,
        ...result.entities.map((e) => e.id),
      ]);

      for (const rel of result.relationships) {
        // UUID format: 8-4-4-4-12 hex chars
        expect(rel.from_id).toMatch(/^[0-9a-f]{8}-/);
        expect(rel.to_id).toMatch(/^[0-9a-f]{8}-/);
        // Both endpoints should be in our entity set
        expect(allUuids.has(rel.from_id)).toBe(true);
        expect(allUuids.has(rel.to_id)).toBe(true);
      }
    });

    it("includes relationships connected to the anchor entity", async () => {
      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 1,
      });

      // Alice has outgoing edges — should appear with anchor UUID
      const anchorRels = result.relationships.filter(
        (r) => r.from_id === aliceId || r.to_id === aliceId,
      );
      expect(anchorRels.length).toBeGreaterThanOrEqual(1);
    });

    it("populates entity_names map with all traversed entities including anchor", async () => {
      const result = await recallConnections(pool, schema, aliceId, config, {
        depth: 1,
      });

      // Anchor should be in entity_names
      expect(result.entity_names.get(aliceId)).toBe("Alice");

      // All returned entities should be in entity_names
      for (const entity of result.entities) {
        expect(result.entity_names.get(entity.id)).toBe(entity.name);
      }
    });
  });

  describe("recallContext", () => {
    beforeAll(async () => {
      // Add some facts for Alice
      const { supersedeFact } = await import("../../src/graph/facts.js");
      await supersedeFact(pool, schema, {
        entity: aliceId,
        new_fact: "Alice is the CTO since 2020",
      });
      await supersedeFact(pool, schema, {
        entity: aliceId,
        new_fact: "Alice reports to the board",
      });
    });

    it("returns connections and facts", async () => {
      const result = await recallContext(pool, schema, aliceId, config, {
        depth: 1,
      });

      expect(result.entity.id).toBe(aliceId);
      expect(result.connections.entities.length).toBeGreaterThanOrEqual(1);
      expect(result.facts.length).toBeGreaterThanOrEqual(2);
    });

    it("includes fact content and timestamps", async () => {
      const result = await recallContext(pool, schema, aliceId, config);

      for (const fact of result.facts) {
        expect(fact.id).toBeDefined();
        expect(fact.content).toBeDefined();
        expect(fact.timestamp).toBeDefined();
        expect(typeof fact.superseded).toBe("boolean");
      }
    });
  });

  describe("recallTimeline", () => {
    it("returns reverse-chronological events and total count", async () => {
      const result = await recallTimeline(pool, schema, aliceId, config, {
        depth: 2,
        limit: 2,
      });

      expect(result.entity_id).toBe(aliceId);
      expect(result.entity_name).toBe("Alice");
      expect(result.events.length).toBe(2);
      expect(result.total_events).toBeGreaterThanOrEqual(2);

      for (const event of result.events) {
        expect(event.id).toBeDefined();
        expect(event.type).toBeDefined();
        expect(event.timestamp).toBeDefined();
      }

      expect(result.events[0].timestamp >= result.events[1].timestamp).toBe(true);
    });

    it("resolves entity by name", async () => {
      const result = await recallTimeline(pool, schema, "Alice", config);
      expect(result.entity_id).toBe(aliceId);
    });

    it("throws for non-existent entity", async () => {
      await expect(
        recallTimeline(
          pool,
          schema,
          "00000000-0000-0000-0000-000000000000",
          config,
        ),
      ).rejects.toThrow("Entity not found");
    });
  });
});
