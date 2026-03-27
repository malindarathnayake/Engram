import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig, type EngramConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";
import type { SchemaDeps } from "../../src/tools/schema-tools.js";
import {
  handleGetMemorySchema,
  handleUpdateMemorySchema,
} from "../../src/tools/schema-tools.js";
import { getToolDefinitions } from "../../src/tools/tool-descriptions.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("schema tools", () => {
  let pool: EngramPool;
  let schema: SchemaManager;
  let config: EngramConfig;
  let deps: SchemaDeps;
  let tmpDir: string;
  const graphName = "schema_tools_test";

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
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "engram-schema-test-"));
    deps = {
      pool,
      schema,
      config,
      schemaFilePath: path.join(tmpDir, "MEMORY_SCHEMA.md"),
    };
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`SELECT drop_graph('${graphName}', true)`);
      } catch {}
      await pool.close();
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("handleGetMemorySchema", () => {
    it("returns current schema with entity and relationship types", async () => {
      const result = await handleGetMemorySchema(deps);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.preset_name).toBe("dev-team");
      expect(data.entity_types).toBeDefined();
      expect(data.entity_types.length).toBeGreaterThan(0);
      expect(data.relationship_types).toBeDefined();
      expect(data.relationship_types.length).toBeGreaterThan(0);
      expect(data.guardrails).toBeDefined();
      expect(data.guardrails.max_entity_types).toBe(15);
    });

    it("includes extraction hints and examples in full mode", async () => {
      const result = await handleGetMemorySchema(deps);
      const data = JSON.parse(result.content[0].text);
      const personType = data.entity_types.find(
        (t: { name: string }) => t.name === "Person"
      );
      expect(personType).toBeDefined();
      expect(personType.properties).toBeDefined();
      expect(personType.extraction_hint).toBeDefined();
      expect(personType.examples).toBeDefined();
      expect(data.guardrails.similarity_threshold).toBeDefined();
      expect(data.guardrails.min_examples_per_type).toBeDefined();
    });

    it("returns compact schema when requested", async () => {
      const result = await handleGetMemorySchema(deps, { compact: true });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      const personType = data.entity_types.find(
        (t: { name: string }) => t.name === "Person"
      );

      expect(personType).toBeDefined();
      expect(personType.properties).toBeDefined();
      expect(personType.extraction_hint).toBeUndefined();
      expect(personType.examples).toBeUndefined();
      expect(data.guardrails).toEqual({ max_entity_types: 15 });
    });
  });

  describe("handleUpdateMemorySchema", () => {
    it("adds a new entity type", async () => {
      const result = await handleUpdateMemorySchema(deps, {
        action: "add",
        name: "Customer",
        properties: ["name", "company", "tier"],
        extraction_hint: "When someone mentions a customer or client",
        examples: ["Acme Corp", "BigCo Inc", "StartupXYZ"],
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.added).toBe("Customer");
      expect(data.total_types).toBeGreaterThan(0);
    });

    it("rejects non-add actions", async () => {
      const result = await handleUpdateMemorySchema(deps, {
        action: "remove",
        name: "Customer",
        properties: [],
        extraction_hint: "",
        examples: [],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("add");
    });

    it("rejects missing name", async () => {
      const result = await handleUpdateMemorySchema(deps, {
        action: "add",
        name: "",
        properties: ["a"],
        extraction_hint: "test",
        examples: ["a", "b", "c"],
      });
      expect(result.isError).toBe(true);
    });

    it("rejects missing extraction_hint", async () => {
      const result = await handleUpdateMemorySchema(deps, {
        action: "add",
        name: "Widget",
        properties: ["size"],
        extraction_hint: "",
        examples: ["a", "b", "c"],
      });
      expect(result.isError).toBe(true);
    });

    it("rejects too few examples", async () => {
      const result = await handleUpdateMemorySchema(deps, {
        action: "add",
        name: "Widget",
        properties: ["size"],
        extraction_hint: "When widgets are mentioned",
        examples: ["one"],
      });
      expect(result.isError).toBe(true);
    });

    it("rejects similar type names", async () => {
      // "Customers" is similar to "Customer" which was already added
      const result = await handleUpdateMemorySchema(deps, {
        action: "add",
        name: "Customers",
        properties: ["name"],
        extraction_hint: "Customer entities",
        examples: ["a", "b", "c"],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("similar");
    });

    it("syncs to MEMORY_SCHEMA.md file", async () => {
      // The "Customer" add above should have created the file
      expect(fs.existsSync(deps.schemaFilePath!)).toBe(true);
    });

    it("calls notifyToolsChanged when provided", async () => {
      const notifyFn = vi.fn().mockResolvedValue(undefined);
      const depsWithNotify: SchemaDeps = {
        ...deps,
        notifyToolsChanged: notifyFn,
      };

      const result = await handleUpdateMemorySchema(depsWithNotify, {
        action: "add",
        name: "Vendor",
        properties: ["name", "product"],
        extraction_hint: "When vendors are mentioned",
        examples: ["SupplyCo", "PartnerInc", "VendorXYZ"],
      });

      expect(result.isError).toBeUndefined();
      expect(notifyFn).toHaveBeenCalledTimes(1);
    });

    it("succeeds even if notifyToolsChanged fails", async () => {
      const notifyFn = vi.fn().mockRejectedValue(new Error("notify failed"));
      const depsWithNotify: SchemaDeps = {
        ...deps,
        notifyToolsChanged: notifyFn,
      };

      const result = await handleUpdateMemorySchema(depsWithNotify, {
        action: "add",
        name: "Partner",
        properties: ["name", "relationship"],
        extraction_hint: "When business partners are mentioned",
        examples: ["AlphaCo", "BetaInc", "GammaLLC"],
      });

      // Should succeed despite notification failure
      expect(result.isError).toBeUndefined();
    });
  });
});

describe("tool descriptions", () => {
  it("generates all 17 tool definitions", () => {
    const schema = SchemaManager.fromPreset("dev-team");
    const tools = getToolDefinitions(schema);
    expect(tools.length).toBe(17);

    const names = tools.map((t) => t.name);
    expect(names).toContain("remember_entity");
    expect(names).toContain("remember_relationship");
    expect(names).toContain("supersede_fact");
    expect(names).toContain("forget_entity");
    expect(names).toContain("merge_entities");
    expect(names).toContain("recall_entity");
    expect(names).toContain("recall_connections");
    expect(names).toContain("recall_context");
    expect(names).toContain("recall_timeline");
    expect(names).toContain("find_contradictions");
    expect(names).toContain("search_entities");
    expect(names).toContain("list_entities");
    expect(names).toContain("graph_stats");
    expect(names).toContain("get_memory_schema");
    expect(names).toContain("update_memory_schema");
  });

  it("includes entity types in descriptions", () => {
    const schema = SchemaManager.fromPreset("dev-team");
    const tools = getToolDefinitions(schema);
    const rememberTool = tools.find((t) => t.name === "remember_entity")!;
    expect(rememberTool.description).toContain("Person");
    expect(rememberTool.description).toContain("Project");
  });

  it("includes relationship types in descriptions", () => {
    const schema = SchemaManager.fromPreset("dev-team");
    const tools = getToolDefinitions(schema);
    const relTool = tools.find((t) => t.name === "remember_relationship")!;
    expect(relTool.description).toContain("WORKS_AT");
  });

  it("includes guardrails in schema tool descriptions", () => {
    const schema = SchemaManager.fromPreset("dev-team");
    const tools = getToolDefinitions(schema);
    const updateTool = tools.find((t) => t.name === "update_memory_schema")!;
    expect(updateTool.description).toContain("15");
  });

  it("adds compact to get_memory_schema inputSchema", () => {
    const schema = SchemaManager.fromPreset("dev-team");
    const tools = getToolDefinitions(schema);
    const schemaTool = tools.find((t) => t.name === "get_memory_schema")!;
    const compact = schemaTool.inputSchema.properties.compact as {
      type: string;
    };

    expect(compact).toBeDefined();
    expect(compact.type).toBe("boolean");
  });

  it("all tools have valid inputSchema", () => {
    const schema = SchemaManager.fromPreset("dev-team");
    const tools = getToolDefinitions(schema);
    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.properties).toBeDefined();
    }
  });

  it("updates descriptions after schema change", () => {
    const schema = SchemaManager.fromPreset("dev-team");
    const before = getToolDefinitions(schema);
    const rememberBefore = before.find(
      (t) => t.name === "remember_entity"
    )!;
    expect(rememberBefore.description).not.toContain("Widget");

    schema.addEntityType({
      name: "Widget",
      properties: ["size", "color"],
      extraction_hint: "When widgets are mentioned",
      examples: ["small widget", "big widget", "red widget"],
    });

    const after = getToolDefinitions(schema);
    const rememberAfter = after.find(
      (t) => t.name === "remember_entity"
    )!;
    expect(rememberAfter.description).toContain("Widget");
  });
});
