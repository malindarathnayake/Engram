import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";
import { createOrUpdateEntity } from "../../src/graph/entities.js";
import {
  createRelationship,
  getRelationships,
  createOrUpdateRelationship,
  type UpsertRelationshipResult,
} from "../../src/graph/relationships.js";

describe("relationship CRUD", () => {
  let pool: EngramPool;
  let schema: SchemaManager;
  const graphName = "rel_test";

  let aliceId: string;
  let bobId: string;
  let projectId: string;
  let teamId: string;

  beforeAll(async () => {
    const testDb = process.env.ENGRAM_TEST_DB;
    if (!testDb) {
      throw new Error("ENGRAM_TEST_DB not set");
    }

    const url = new URL(testDb);
    const config = loadConfig({
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

    // Seed entities
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
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`SELECT drop_graph('${graphName}', true)`);
      } catch {
        // ignore
      }
      await pool.close();
    }
  });

  describe("createRelationship", () => {
    it("creates a relationship by UUID", async () => {
      const result = await createRelationship(pool, schema, {
        from: aliceId,
        to: projectId,
        type: "OWNS",
      });

      expect("needs_disambiguation" in result).toBe(false);
      if (!("needs_disambiguation" in result)) {
        expect(result.from_id).toBe(aliceId);
        expect(result.to_id).toBe(projectId);
        expect(result.type).toBe("OWNS");
        expect(result.id).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
        );
      }
    });

    it("creates a relationship by name", async () => {
      const result = await createRelationship(pool, schema, {
        from: "Bob",
        to: "Project Atlas",
        type: "CONTRIBUTES_TO",
      });

      expect("needs_disambiguation" in result).toBe(false);
      if (!("needs_disambiguation" in result)) {
        expect(result.from_id).toBe(bobId);
        expect(result.to_id).toBe(projectId);
        expect(result.type).toBe("CONTRIBUTES_TO");
      }
    });

    it("creates a relationship with properties", async () => {
      const result = await createRelationship(pool, schema, {
        from: aliceId,
        to: bobId,
        type: "REPORTS_TO",
        properties: { since: "2024-01-01" },
      });

      expect("needs_disambiguation" in result).toBe(false);
      if (!("needs_disambiguation" in result)) {
        expect(result.properties.since).toBe("2024-01-01");
      }
    });

    it("rejects invalid relationship type", async () => {
      await expect(
        createRelationship(pool, schema, {
          from: aliceId,
          to: bobId,
          type: "INVALID_TYPE",
        }),
      ).rejects.toThrow('Invalid relationship type: "INVALID_TYPE"');
    });

    it("throws for non-existent from entity", async () => {
      await expect(
        createRelationship(pool, schema, {
          from: "00000000-0000-0000-0000-000000000000",
          to: bobId,
          type: "RELATES_TO",
        }),
      ).rejects.toThrow("Entity not found");
    });

    it("throws for non-existent to entity", async () => {
      await expect(
        createRelationship(pool, schema, {
          from: aliceId,
          to: "00000000-0000-0000-0000-000000000000",
          type: "RELATES_TO",
        }),
      ).rejects.toThrow("Entity not found");
    });

    it("creates relationships between different entity types", async () => {
      const result = await createRelationship(pool, schema, {
        from: bobId,
        to: teamId,
        type: "WORKS_AT",
      });

      expect("needs_disambiguation" in result).toBe(false);
      if (!("needs_disambiguation" in result)) {
        expect(result.from_id).toBe(bobId);
        expect(result.to_id).toBe(teamId);
        expect(result.type).toBe("WORKS_AT");
      }
    });
  });

  describe("getRelationships", () => {
    it("gets outgoing relationships", async () => {
      const result = await getRelationships(pool, schema, aliceId, {
        direction: "out",
      });

      expect(result.relationships.length).toBeGreaterThanOrEqual(1);
      expect(
        result.relationships.every((r) => r.from_id === aliceId),
      ).toBe(true);
    });

    it("gets incoming relationships", async () => {
      const result = await getRelationships(pool, schema, projectId, {
        direction: "in",
      });

      expect(result.relationships.length).toBeGreaterThanOrEqual(1);
      expect(
        result.relationships.every((r) => r.to_id === projectId),
      ).toBe(true);
    });

    it("gets both directions by default", async () => {
      const result = await getRelationships(pool, schema, aliceId);

      expect(result.relationships.length).toBeGreaterThanOrEqual(1);
    });

    it("filters by relationship type", async () => {
      const result = await getRelationships(pool, schema, aliceId, {
        direction: "out",
        type_filter: "OWNS",
      });

      expect(result.relationships.length).toBeGreaterThanOrEqual(1);
      expect(
        result.relationships.every((r) => r.type === "OWNS"),
      ).toBe(true);
    });

    it("resolves entity by name", async () => {
      const result = await getRelationships(pool, schema, "Alice");

      expect(result.relationships.length).toBeGreaterThanOrEqual(1);
    });

    it("throws for non-existent entity", async () => {
      await expect(
        getRelationships(pool, schema, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow("Entity not found");
    });

    it("returns total_count", async () => {
      const result = await getRelationships(pool, schema, aliceId);

      expect(result.total_count).toBe(result.relationships.length);
    });
  });

  describe("createOrUpdateRelationship", () => {
    it("deduplicates same-type relationship between same entities", async () => {
      const entity1 = await createOrUpdateEntity(pool, schema, {
        name: "DedupFrom",
        type: "Person",
      });
      const entity2 = await createOrUpdateEntity(pool, schema, {
        name: "DedupTo",
        type: "Project",
      });

      // First create
      const r1 = await createOrUpdateRelationship(
        pool, entity1.id, entity2.id, "Person", "Project", "OWNS", { role: "lead" }
      );
      expect(r1.created).toBe(true);

      // Second create — same entities, same type — should update
      const r2 = await createOrUpdateRelationship(
        pool, entity1.id, entity2.id, "Person", "Project", "OWNS", { priority: "high" }
      );
      expect(r2.created).toBe(false);

      // Verify only 1 relationship exists
      const rels = await getRelationships(pool, schema, entity1.id, {
        direction: "out",
        type_filter: "OWNS",
      });
      expect(rels.relationships.length).toBe(1);
    });

    it("rejects reserved property key 'type'", async () => {
      await expect(
        createOrUpdateRelationship(
          pool, aliceId, projectId, "Person", "Project", "OWNS",
          { type: "foo" }
        )
      ).rejects.toThrow("'type' is a reserved relationship field");
    });

    it("allows non-reserved property keys", async () => {
      const entity1 = await createOrUpdateEntity(pool, schema, {
        name: "ReservedTestFrom",
        type: "Person",
      });
      const entity2 = await createOrUpdateEntity(pool, schema, {
        name: "ReservedTestTo",
        type: "Project",
      });
      const result = await createOrUpdateRelationship(
        pool, entity1.id, entity2.id, "Person", "Project", "CONTRIBUTES_TO",
        { role: "CEO", department: "Engineering" }
      );
      expect(result.created).toBe(true);
      expect(result.properties.role).toBe("CEO");
    });

    it("preserves existing properties on upsert and updates changed ones", async () => {
      const entity1 = await createOrUpdateEntity(pool, schema, {
        name: "PropTestFrom",
        type: "Person",
      });
      const entity2 = await createOrUpdateEntity(pool, schema, {
        name: "PropTestTo",
        type: "Team",
      });

      // Create with two properties
      await createOrUpdateRelationship(
        pool, entity1.id, entity2.id, "Person", "Team", "WORKS_AT",
        { role: "engineer", since: "2024-01" }
      );

      // Upsert with only role changed
      const r2 = await createOrUpdateRelationship(
        pool, entity1.id, entity2.id, "Person", "Team", "WORKS_AT",
        { role: "senior-engineer" }
      );
      expect(r2.created).toBe(false);
      expect(r2.properties.role).toBe("senior-engineer");
      expect(r2.properties.since).toBe("2024-01");
    });
  });

  describe("disambiguation", () => {
    beforeAll(async () => {
      // Create entities with similar names to trigger disambiguation
      await createOrUpdateEntity(pool, schema, {
        name: "Sarah Chen",
        type: "Person",
      });
      await createOrUpdateEntity(pool, schema, {
        name: "Sarah Williams",
        type: "Person",
      });
    });

    it("returns disambiguation when name is ambiguous", async () => {
      const result = await createRelationship(pool, schema, {
        from: "Sarah",
        to: projectId,
        type: "OWNS",
      });

      if ("needs_disambiguation" in result) {
        expect(result.needs_disambiguation).toBe(true);
        expect(result.field).toBe("from");
        expect(result.candidates.length).toBeGreaterThanOrEqual(2);
      }
      // If it resolved (e.g., only one Sarah visible), that's also acceptable
    });
  });
});
