import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";

describe("schema manager guardrails", () => {
  let pool: EngramPool;
  const graphName = "schema_test";

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
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`SELECT drop_graph('${graphName}', true)`);
      } catch { /* ignore */ }
      await pool.close();
    }
  });

  describe("addEntityType", () => {
    it("adds a new entity type", () => {
      const schema = SchemaManager.fromPreset("dev-team");
      const initialCount = schema.getEntityTypeCount();

      const result = schema.addEntityType({
        name: "Vendor",
        properties: ["name", "contact", "contract_value"],
        extraction_hint: "External vendors and suppliers",
        examples: [
          "Acme is our cloud vendor",
          "TechCo provides support tools",
          "DataCorp handles analytics",
        ],
      });

      expect(result.added).toBe("Vendor");
      expect(result.total_types).toBe(initialCount + 1);
      expect(schema.isValidEntityType("Vendor")).toBe(true);
    });

    it("rejects duplicate type name", () => {
      const schema = SchemaManager.fromPreset("dev-team");

      expect(() =>
        schema.addEntityType({
          name: "Person",
          properties: ["name"],
          extraction_hint: "People",
          examples: ["a", "b", "c"],
        }),
      ).toThrow('Entity type "Person" already exists');
    });

    it("rejects when max types reached", () => {
      const schema = SchemaManager.fromPreset("dev-team", {
        max_entity_types: 11, // dev-team has 11 types
      });

      expect(() =>
        schema.addEntityType({
          name: "NewType",
          properties: ["name"],
          extraction_hint: "Something new",
          examples: ["a", "b", "c"],
        }),
      ).toThrow("Maximum 11 entity types reached");
    });

    it("rejects similar type name (with lower threshold)", () => {
      const schema = SchemaManager.fromPreset("dev-team", {
        similarity_threshold: 0.6, // Lower threshold to catch "Persons" vs "Person"
      });

      expect(() =>
        schema.addEntityType({
          name: "Persons",
          properties: ["name"],
          extraction_hint: "Multiple people",
          examples: ["a", "b", "c"],
        }),
      ).toThrow(/similar to existing type "Person"/);
    });

    it("rejects similar extraction hint", () => {
      const schema = SchemaManager.fromPreset("dev-team", {
        similarity_threshold: 0.5, // Lower to catch hint similarity
      });

      expect(() =>
        schema.addEntityType({
          name: "Employee",
          properties: ["name"],
          extraction_hint: "People mentioned by name with a role",
          examples: ["a", "b", "c"],
        }),
      ).toThrow(/similar to existing type/);
    });

    it("rejects insufficient examples", () => {
      const schema = SchemaManager.fromPreset("dev-team");

      expect(() =>
        schema.addEntityType({
          name: "Gadget",
          properties: ["name"],
          extraction_hint: "Hardware devices and gadgets",
          examples: ["a", "b"],
        }),
      ).toThrow("At least 3 examples required. Got 2");
    });

    it("rejects invalid AGE identifier", () => {
      const schema = SchemaManager.fromPreset("dev-team");

      expect(() =>
        schema.addEntityType({
          name: "Bad Type!",
          properties: ["name"],
          extraction_hint: "Something",
          examples: ["a", "b", "c"],
        }),
      ).toThrow("Invalid entity type name");
    });

    it("allows adding type with custom guardrails", () => {
      const schema = SchemaManager.fromPreset("dev-team", {
        max_entity_types: 50,
        similarity_threshold: 0.95, // Very strict — only reject near-identical
        min_examples_per_type: 1,
      });

      const result = schema.addEntityType({
        name: "Workflow",
        properties: ["name", "steps"],
        extraction_hint: "Business workflows and processes",
        examples: ["CI/CD pipeline runs daily"],
      });

      expect(result.added).toBe("Workflow");
    });

    it("updates schema after adding type", () => {
      const schema = SchemaManager.fromPreset("dev-team");

      schema.addEntityType({
        name: "Document",
        properties: ["name", "url", "author"],
        extraction_hint: "Documents, files, and written artifacts",
        examples: [
          "The API spec is in Confluence",
          "RFC-42 was approved",
          "README needs updating",
        ],
      });

      const schemaState = schema.getSchema();
      const names = schemaState.entity_types.map((t) => t.name);
      expect(names).toContain("Document");
    });
  });

  describe("guardrail config", () => {
    it("returns default guardrails", () => {
      const schema = SchemaManager.fromPreset("dev-team");
      const guardrails = schema.getGuardrails();

      expect(guardrails.max_entity_types).toBe(15);
      expect(guardrails.similarity_threshold).toBe(0.7);
      expect(guardrails.min_examples_per_type).toBe(3);
    });

    it("accepts custom guardrails", () => {
      const schema = SchemaManager.fromPreset("dev-team", {
        max_entity_types: 25,
        similarity_threshold: 0.8,
        min_examples_per_type: 5,
      });

      const guardrails = schema.getGuardrails();
      expect(guardrails.max_entity_types).toBe(25);
      expect(guardrails.similarity_threshold).toBe(0.8);
      expect(guardrails.min_examples_per_type).toBe(5);
    });
  });
});
