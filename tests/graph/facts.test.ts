import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";
import { createOrUpdateEntity } from "../../src/graph/entities.js";
import { supersedeFact, findContradictions } from "../../src/graph/facts.js";

describe("facts", () => {
  let pool: EngramPool;
  let schema: SchemaManager;
  const graphName = "facts_test";
  let sarahId: string;
  let projectId: string;

  beforeAll(async () => {
    const testDb = process.env.ENGRAM_TEST_DB;
    if (!testDb) throw new Error("ENGRAM_TEST_DB not set");

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

    const sarah = await createOrUpdateEntity(pool, schema, {
      name: "Sarah",
      type: "Person",
      properties: { role: "CTO" },
    });
    sarahId = sarah.id;

    const project = await createOrUpdateEntity(pool, schema, {
      name: "Atlas",
      type: "Project",
      properties: { status: "active" },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`SELECT drop_graph('${graphName}', true)`);
      } catch { /* ignore */ }
      await pool.close();
    }
  });

  describe("supersedeFact", () => {
    it("creates a standalone fact (no old_fact)", async () => {
      const result = await supersedeFact(pool, schema, {
        entity: sarahId,
        new_fact: "Sarah is the CTO",
        confidence: 0.9,
      });

      expect(result.new_fact_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(result.old_fact_id).toBeNull();
      expect(result.entity_id).toBe(sarahId);
      expect(result.superseded_at).toBeDefined();
    });

    it("supersedes an existing fact", async () => {
      // Create initial fact
      const initial = await supersedeFact(pool, schema, {
        entity: sarahId,
        new_fact: "Sarah manages 5 people",
      });

      // Supersede it
      const result = await supersedeFact(pool, schema, {
        entity: sarahId,
        old_fact: "Sarah manages 5 people",
        new_fact: "Sarah manages 8 people",
      });

      expect(result.old_fact_id).toBe(initial.new_fact_id);
      expect(result.new_fact_id).not.toBe(initial.new_fact_id);
      expect(result.entity_id).toBe(sarahId);
    });

    it("creates old fact node when old_fact doesn't exist yet", async () => {
      const result = await supersedeFact(pool, schema, {
        entity: sarahId,
        old_fact: "Sarah was VP of Engineering",
        new_fact: "Sarah is CTO (promoted from VP)",
      });

      expect(result.old_fact_id).toBeDefined();
      expect(result.old_fact_id).not.toBeNull();
      expect(result.new_fact_id).toBeDefined();
    });

    it("builds a supersession chain (A → B → C)", async () => {
      const factA = await supersedeFact(pool, schema, {
        entity: projectId,
        new_fact: "Atlas launches in Q1",
      });

      const factB = await supersedeFact(pool, schema, {
        entity: projectId,
        old_fact: "Atlas launches in Q1",
        new_fact: "Atlas launches in Q2",
      });

      const factC = await supersedeFact(pool, schema, {
        entity: projectId,
        old_fact: "Atlas launches in Q2",
        new_fact: "Atlas launches in Q3",
      });

      expect(factB.old_fact_id).toBe(factA.new_fact_id);
      expect(factC.old_fact_id).toBe(factB.new_fact_id);
    });

    it("resolves entity by name", async () => {
      const result = await supersedeFact(pool, schema, {
        entity: "Sarah",
        new_fact: "Sarah joined in 2020",
      });

      expect(result.entity_id).toBe(sarahId);
    });

    it("includes source and confidence", async () => {
      const result = await supersedeFact(pool, schema, {
        entity: sarahId,
        new_fact: "Sarah has 10 years experience",
        source: "interview",
        confidence: 0.85,
      });

      expect(result.new_fact_id).toBeDefined();
    });

    it("rejects empty new_fact", async () => {
      await expect(
        supersedeFact(pool, schema, {
          entity: sarahId,
          new_fact: "",
        }),
      ).rejects.toThrow("new_fact cannot be empty");
    });

    it("rejects invalid confidence", async () => {
      await expect(
        supersedeFact(pool, schema, {
          entity: sarahId,
          new_fact: "test",
          confidence: 1.5,
        }),
      ).rejects.toThrow("Confidence must be between 0.0 and 1.0");
    });

    it("throws for non-existent entity", async () => {
      await expect(
        supersedeFact(pool, schema, {
          entity: "00000000-0000-0000-0000-000000000000",
          new_fact: "test",
        }),
      ).rejects.toThrow("Entity not found");
    });
  });

  describe("findContradictions", () => {
    let contradictionEntityId: string;

    beforeAll(async () => {
      const entity = await createOrUpdateEntity(pool, schema, {
        name: "ContraTest",
        type: "Person",
      });
      contradictionEntityId = entity.id;

      // Create multiple active (non-superseded) facts
      await supersedeFact(pool, schema, {
        entity: contradictionEntityId,
        new_fact: "ContraTest is in the NYC office",
      });
      await supersedeFact(pool, schema, {
        entity: contradictionEntityId,
        new_fact: "ContraTest is in the SF office",
      });
      await supersedeFact(pool, schema, {
        entity: contradictionEntityId,
        new_fact: "ContraTest works remotely",
      });
    });

    it("returns all active facts for an entity", async () => {
      const result = await findContradictions(pool, schema, contradictionEntityId);

      expect(result.entity_id).toBe(contradictionEntityId);
      expect(result.entity_name).toBe("ContraTest");
      expect(result.facts.length).toBeGreaterThanOrEqual(3);
    });

    it("excludes superseded facts", async () => {
      // Create and supersede a fact
      const entity = await createOrUpdateEntity(pool, schema, {
        name: "SupersededTest",
        type: "Person",
      });

      await supersedeFact(pool, schema, {
        entity: entity.id,
        new_fact: "SupersededTest is junior",
      });
      await supersedeFact(pool, schema, {
        entity: entity.id,
        old_fact: "SupersededTest is junior",
        new_fact: "SupersededTest is senior",
      });

      const result = await findContradictions(pool, schema, entity.id);

      // Only the non-superseded fact should appear
      const contents = result.facts.map((f) => f.content);
      expect(contents).toContain("SupersededTest is senior");
      expect(contents).not.toContain("SupersededTest is junior");
    });

    it("returns fact properties", async () => {
      const result = await findContradictions(pool, schema, contradictionEntityId);

      for (const fact of result.facts) {
        expect(fact.id).toBeDefined();
        expect(fact.content).toBeDefined();
        expect(fact.timestamp).toBeDefined();
        expect(fact.entity_id).toBe(contradictionEntityId);
      }
    });

    it("resolves entity by name", async () => {
      const result = await findContradictions(pool, schema, "ContraTest");
      expect(result.entity_id).toBe(contradictionEntityId);
    });

    it("throws for non-existent entity", async () => {
      await expect(
        findContradictions(pool, schema, "00000000-0000-0000-0000-000000000000"),
      ).rejects.toThrow("Entity not found");
    });

    it("returns empty facts for entity with no facts", async () => {
      const entity = await createOrUpdateEntity(pool, schema, {
        name: "NoFactsPerson",
        type: "Person",
      });

      const result = await findContradictions(pool, schema, entity.id);
      expect(result.facts).toEqual([]);
    });
  });
});
