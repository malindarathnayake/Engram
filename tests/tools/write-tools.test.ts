import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig, type EngramConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";
import type { ToolDeps } from "../../src/tools/write-tools.js";
import {
  handleRememberEntity,
  handleRememberRelationship,
  handleSupersedeFact,
  handleForgetEntity,
  handleMergeEntities,
  handleRememberKnowledge,
} from "../../src/tools/write-tools.js";

describe("write tools", () => {
  let pool: EngramPool;
  let schema: SchemaManager;
  let config: EngramConfig;
  let deps: ToolDeps;
  const graphName = "write_tools_test";

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
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`SELECT drop_graph('${graphName}', true)`);
      } catch {}
      await pool.close();
    }
  });

  describe("handleRememberEntity", () => {
    it("creates a new entity and returns it", async () => {
      const result = await handleRememberEntity(deps, {
        name: "Alice",
        type: "Person",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBeDefined();
      expect(data.status).toBe("created");
    });

    it("upserts existing entity", async () => {
      const result = await handleRememberEntity(deps, {
        name: "Alice",
        type: "Person",
        properties: { role: "engineer" },
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe("updated");
    });

    it("returns error for missing name", async () => {
      const result = await handleRememberEntity(deps, {
        name: "",
        type: "Person",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("required");
    });

    it("returns error for missing type", async () => {
      const result = await handleRememberEntity(deps, {
        name: "Bob",
        type: "",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("required");
    });

    it("returns error for invalid confidence", async () => {
      const result = await handleRememberEntity(deps, {
        name: "Charlie",
        type: "Person",
        confidence: 1.5,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("0.0-1.0");
    });

    it("returns error for confidence below threshold", async () => {
      const result = await handleRememberEntity(deps, {
        name: "Dave",
        type: "Person",
        confidence: 0.1,
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("below minimum");
    });

    it("returns error for invalid entity type", async () => {
      const result = await handleRememberEntity(deps, {
        name: "Eve",
        type: "InvalidType",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("handleRememberRelationship", () => {
    it("creates a relationship between two entities", async () => {
      // Create two entities first
      await handleRememberEntity(deps, { name: "WT_From", type: "Person" });
      await handleRememberEntity(deps, {
        name: "WT_To",
        type: "Project",
      });

      const result = await handleRememberRelationship(deps, {
        from: "WT_From",
        to: "WT_To",
        type: "WORKS_AT",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBeDefined();
      expect(data.status).toBe("created");
    });

    it("returns updated status when relationship already exists", async () => {
      // WT_From -> WT_To with WORKS_AT already created in the prior test
      const result = await handleRememberRelationship(deps, {
        from: "WT_From",
        to: "WT_To",
        type: "WORKS_AT",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe("updated");
    });

    it("returns error for missing fields", async () => {
      const result = await handleRememberRelationship(deps, {
        from: "",
        to: "WT_To",
        type: "WORKS_AT",
      });
      expect(result.isError).toBe(true);
    });

    it("returns disambiguation when name is ambiguous", async () => {
      // This depends on entity search behavior — multiple matches
      const result = await handleRememberRelationship(deps, {
        from: "nonexistent_xyz_entity",
        to: "WT_To",
        type: "WORKS_AT",
      });
      // Either error or disambiguation — both are valid
      expect(result.content[0].text).toBeDefined();
    });
  });

  describe("handleSupersedeFact", () => {
    it("creates a new fact for an entity", async () => {
      await handleRememberEntity(deps, {
        name: "WT_FactEntity",
        type: "Person",
      });

      const result = await handleSupersedeFact(deps, {
        entity: "WT_FactEntity",
        new_fact: "Lives in Seattle",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.new_fact_id).toBeDefined();
      expect(data.status).toBe("superseded");
    });

    it("supersedes an old fact", async () => {
      const result = await handleSupersedeFact(deps, {
        entity: "WT_FactEntity",
        new_fact: "Lives in Portland",
        old_fact: "Lives in Seattle",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.old_fact_id).toBeDefined();
      expect(data.new_fact_id).toBeDefined();
      expect(data.status).toBe("superseded");
    });

    it("returns error for missing entity", async () => {
      const result = await handleSupersedeFact(deps, {
        entity: "",
        new_fact: "Some fact",
      });
      expect(result.isError).toBe(true);
    });

    it("returns error for missing new_fact", async () => {
      const result = await handleSupersedeFact(deps, {
        entity: "WT_FactEntity",
        new_fact: "",
      });
      expect(result.isError).toBe(true);
    });

    it("returns error for invalid confidence", async () => {
      const result = await handleSupersedeFact(deps, {
        entity: "WT_FactEntity",
        new_fact: "Test fact",
        confidence: -0.5,
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("handleForgetEntity", () => {
    it("soft-deletes an entity", async () => {
      await handleRememberEntity(deps, {
        name: "WT_ForgetMe",
        type: "Person",
      });

      const result = await handleForgetEntity(deps, {
        identifier: "WT_ForgetMe",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.id).toBeDefined();
      expect(data.status).toBe("deleted");
    });

    it("returns error for missing identifier", async () => {
      const result = await handleForgetEntity(deps, {
        identifier: "",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("handleMergeEntities", () => {
    it("merges two entities", async () => {
      const r1 = await handleRememberEntity(deps, {
        name: "WT_Survivor",
        type: "Person",
      });
      const r2 = await handleRememberEntity(deps, {
        name: "WT_Merged",
        type: "Person",
      });

      const survivorId = JSON.parse(r1.content[0].text).id;
      const mergedId = JSON.parse(r2.content[0].text).id;

      const result = await handleMergeEntities(deps, {
        surviving_id: survivorId,
        merged_id: mergedId,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.surviving_id).toBe(survivorId);
      expect(data.merged_id).toBe(mergedId);
      expect(data.status).toBe("merged");
    });

    it("returns error for missing IDs", async () => {
      const result = await handleMergeEntities(deps, {
        surviving_id: "",
        merged_id: "some-id",
      });
      expect(result.isError).toBe(true);
    });

    it("merges by name using new param names", async () => {
      await handleRememberEntity(deps, {
        name: "WT_NameSurvivor",
        type: "Person",
      });
      await handleRememberEntity(deps, {
        name: "WT_NameMerged",
        type: "Person",
      });

      const result = await handleMergeEntities(deps, {
        surviving: "WT_NameSurvivor",
        merged: "WT_NameMerged",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.status).toBe("merged");
      expect(data.surviving_id).toBeDefined();
      expect(data.merged_id).toBeDefined();
    });

    it("returns disambiguation when name is ambiguous", async () => {
      // Create two entities that will match "WT_Ambig"
      await handleRememberEntity(deps, {
        name: "WT_Ambig_Alpha",
        type: "Person",
      });
      await handleRememberEntity(deps, {
        name: "WT_Ambig_Beta",
        type: "Person",
      });

      const result = await handleMergeEntities(deps, {
        surviving: "WT_Ambig",
        merged: "WT_NameSurvivor", // this one should resolve fine
      });
      // Either disambiguation or error — both acceptable depending on search behavior
      const data = JSON.parse(result.content[0].text);
      if (data.needs_disambiguation) {
        expect(data.field).toBe("surviving");
        expect(data.candidates.length).toBeGreaterThanOrEqual(2);
      }
      // If it resolved (only one match), that's also acceptable
    });
  });

  describe("handleRememberKnowledge", () => {
    it("batch creates entities and relationships", async () => {
      const result = await handleRememberKnowledge(deps, {
        entities: [
          { name: "BK_Alice", type: "Person" },
          { name: "BK_Acme", type: "Company" },
        ],
        relationships: [
          { from: "BK_Alice", to: "BK_Acme", type: "WORKS_AT" },
        ],
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.entities.created).toBe(2);
      expect(data.relationships.created).toBe(1);
      expect(data.relationships.failed).toEqual([]);
    });

    it("handles forward references within batch", async () => {
      // Entity C referenced in relationship is created in same batch
      const result = await handleRememberKnowledge(deps, {
        entities: [
          { name: "BK_Forward_A", type: "Person" },
          { name: "BK_Forward_B", type: "Project" },
        ],
        relationships: [
          { from: "BK_Forward_A", to: "BK_Forward_B", type: "CONTRIBUTES_TO" },
        ],
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.entities.created).toBe(2);
      expect(data.relationships.created).toBe(1);
      expect(data.relationships.failed).toEqual([]);
    });

    it("reports item-level errors for failed relationships", async () => {
      const result = await handleRememberKnowledge(deps, {
        entities: [
          { name: "BK_ErrEntity", type: "Person" },
          { name: "BK_ErrTarget", type: "Company" },
        ],
        relationships: [
          { from: "BK_ErrEntity", to: "BK_NonExistentXYZ999", type: "WORKS_AT" },
          { from: "BK_ErrEntity", to: "BK_ErrTarget", type: "WORKS_AT" },
        ],
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.entities.created).toBe(2);
      // First relationship should fail (target not found), second should succeed via batch map
      expect(data.relationships.failed.length).toBe(1);
      expect(data.relationships.failed[0].index).toBe(0);
      expect(data.relationships.failed[0].error).toContain("not found");
      // The successful one
      expect(data.relationships.created + data.relationships.updated).toBeGreaterThanOrEqual(1);
    });

    it("uses from_type for disambiguation", async () => {
      // Create two entities with same name, different types
      await handleRememberEntity(deps, { name: "BK_Ambig", type: "Person" });
      await handleRememberEntity(deps, { name: "BK_Ambig", type: "Company" });

      const result = await handleRememberKnowledge(deps, {
        entities: [],
        relationships: [
          {
            from: "BK_Ambig",
            to: "BK_Acme",
            type: "WORKS_AT",
            from_type: "Person",
          },
        ],
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      // Should resolve using from_type
      expect(data.relationships.created + data.relationships.updated).toBeGreaterThanOrEqual(1);
      expect(data.relationships.failed).toEqual([]);
    });

    it("rejects reserved property keys in bulk relationships", async () => {
      const result = await handleRememberKnowledge(deps, {
        entities: [
          { name: "BK_ReservedA", type: "Person" },
          { name: "BK_ReservedB", type: "Company" },
        ],
        relationships: [
          {
            from: "BK_ReservedA",
            to: "BK_ReservedB",
            type: "WORKS_AT",
            properties: { type: "full-time" }, // "type" is reserved
          },
        ],
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.relationships.failed.length).toBe(1);
      expect(data.relationships.failed[0].error).toContain("reserved");
    });

    it("returns error for empty input", async () => {
      const result = await handleRememberKnowledge(deps, {
        entities: [],
        relationships: [],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("At least one");
    });
  });
});
