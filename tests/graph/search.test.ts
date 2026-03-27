import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";
import { createOrUpdateEntity } from "../../src/graph/entities.js";
import { searchEntities, resolveEntity } from "../../src/graph/search.js";

describe("entity search", () => {
  let pool: EngramPool;
  let schema: SchemaManager;
  const graphName = "search_test";

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

    // Seed test data
    await createOrUpdateEntity(pool, schema, {
      name: "Sarah Chen",
      type: "Person",
      properties: { role: "CTO" },
    });
    await createOrUpdateEntity(pool, schema, {
      name: "Sarah Williams",
      type: "Person",
      properties: { role: "Engineer" },
    });
    await createOrUpdateEntity(pool, schema, {
      name: "Bob Smith",
      type: "Person",
      properties: { role: "Designer" },
    });
    await createOrUpdateEntity(pool, schema, {
      name: "Project Atlas",
      type: "Project",
      properties: { status: "active" },
    });
    await createOrUpdateEntity(pool, schema, {
      name: "Project Zenith",
      type: "Project",
      properties: { status: "planning" },
    });
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

  describe("searchEntities", () => {
    it("finds entities by exact name (case-insensitive)", async () => {
      const results = await searchEntities(pool, schema, "sarah chen");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe("Sarah Chen");
      expect(results[0].score).toBe(1.0);
    });

    it("finds entities by partial name (contains)", async () => {
      const results = await searchEntities(pool, schema, "Sarah");

      expect(results.length).toBeGreaterThanOrEqual(2);
      const names = results.map((r) => r.name);
      expect(names).toContain("Sarah Chen");
      expect(names).toContain("Sarah Williams");
    });

    it("finds entities by starts-with match", async () => {
      const results = await searchEntities(pool, schema, "Bob");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe("Bob Smith");
      expect(results[0].score).toBe(0.8); // starts-with score
    });

    it("returns empty for no match", async () => {
      const results = await searchEntities(
        pool,
        schema,
        "NonExistent12345",
      );
      expect(results).toEqual([]);
    });

    it("returns empty for empty query", async () => {
      const results = await searchEntities(pool, schema, "");
      expect(results).toEqual([]);
    });

    it("returns empty for whitespace-only query", async () => {
      const results = await searchEntities(pool, schema, "   ");
      expect(results).toEqual([]);
    });

    it("respects limit", async () => {
      const results = await searchEntities(pool, schema, "Sarah", {
        limit: 1,
      });
      expect(results).toHaveLength(1);
    });

    it("filters by entity type", async () => {
      const results = await searchEntities(pool, schema, "Atlas", {
        type_filter: "Project",
      });

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.every((r) => r.type === "Project")).toBe(true);
    });

    it("rejects invalid type filter", async () => {
      await expect(
        searchEntities(pool, schema, "test", {
          type_filter: "InvalidType",
        }),
      ).rejects.toThrow("Invalid entity type filter");
    });

    it("sorts by relevance (exact > starts-with > contains)", async () => {
      // "Sarah Chen" is an exact match for "Sarah Chen"
      // "Sarah Williams" is a partial match
      const results = await searchEntities(pool, schema, "Sarah Chen");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].name).toBe("Sarah Chen");
      expect(results[0].score).toBe(1.0);
    });

    it("includes entity properties in results", async () => {
      const results = await searchEntities(pool, schema, "Bob Smith");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].properties.role).toBe("Designer");
    });

    it("includes entity ID in results", async () => {
      const results = await searchEntities(pool, schema, "Bob Smith");

      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results[0].id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  });

  describe("resolveEntity", () => {
    let sarahId: string;

    beforeAll(async () => {
      const results = await searchEntities(pool, schema, "Sarah Chen", {
        limit: 1,
      });
      sarahId = results[0].id;
    });

    it("resolves by UUID", async () => {
      const result = await resolveEntity(pool, schema, sarahId);

      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.entity.id).toBe(sarahId);
        expect(result.entity.name).toBe("Sarah Chen");
      }
    });

    it("resolves unambiguous name", async () => {
      const result = await resolveEntity(pool, schema, "Bob Smith");

      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.entity.name).toBe("Bob Smith");
      }
    });

    it("returns disambiguation for ambiguous name", async () => {
      const result = await resolveEntity(pool, schema, "Sarah");

      // "Sarah" matches both "Sarah Chen" and "Sarah Williams" — both starts-with
      expect(result.resolved).toBe(false);
      if (!result.resolved) {
        expect(result.needs_disambiguation).toBe(true);
        if (result.needs_disambiguation) {
          expect(result.candidates.length).toBeGreaterThanOrEqual(2);
        }
      }
    });

    it("resolves exact match even with partial matches present", async () => {
      const result = await resolveEntity(pool, schema, "Sarah Chen");

      // "Sarah Chen" is an exact match — should resolve despite "Sarah Williams" existing
      expect(result.resolved).toBe(true);
      if (result.resolved) {
        expect(result.entity.name).toBe("Sarah Chen");
      }
    });

    it("returns not found for non-existent UUID", async () => {
      const result = await resolveEntity(
        pool,
        schema,
        "00000000-0000-0000-0000-000000000000",
      );

      expect(result.resolved).toBe(false);
      if (!result.resolved) {
        expect(result.needs_disambiguation).toBe(false);
        expect(result.candidates).toEqual([]);
      }
    });

    it("returns not found for non-existent name", async () => {
      const result = await resolveEntity(
        pool,
        schema,
        "NonExistentPerson12345",
      );

      expect(result.resolved).toBe(false);
      if (!result.resolved) {
        expect(result.needs_disambiguation).toBe(false);
      }
    });
  });

  describe("exact search", () => {
    it("returns only exact matches when exact is true", async () => {
      const results = await searchEntities(pool, schema, "Sarah Chen", {
        exact: true,
      });
      expect(results.length).toBe(1);
      expect(results[0].name).toBe("Sarah Chen");
      expect(results[0].score).toBe(1.0);
    });

    it("returns empty for partial match with exact flag", async () => {
      const results = await searchEntities(pool, schema, "Sarah", {
        exact: true,
      });
      expect(results.length).toBe(0);
    });
  });
});
