import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { loadConfig, type EngramConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";
import type { ToolDeps, ToolResult } from "../../src/tools/write-tools.js";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import {
  handleRememberEntity,
  handleRememberRelationship,
} from "../../src/tools/write-tools.js";
import {
  handleRecallEntity,
  handleRecallConnections,
  handleSearchEntities,
  handleGraphStats,
} from "../../src/tools/read-tools.js";

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("graceful degradation", () => {
  describe("tools error with unavailable DB", () => {
    let pool: EngramPool;
    let deps: ToolDeps;
    const graphName = "degradation_test";

    it("createPool fails when connecting to non-existent host", async () => {
      const config = loadConfig({
        mode: "external",
        external: {
          host: "127.0.0.1",
          port: 59999, // no server here
          database: "nonexistent",
          username: "postgres",
          password: "bad",
          ssl: false,
          graph_name: graphName,
        },
      });

      await expect(createPool(config)).rejects.toThrow();
    });
  });

  describe("DB recovery after initial availability", () => {
    let pool: EngramPool;
    let schema: SchemaManager;
    let config: EngramConfig;
    let deps: ToolDeps;
    const graphName = "degradation_recovery_test";

    it("tools work after DB connection is established", async () => {
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

      // Tools should work
      const result = await handleRememberEntity(deps, {
        name: "Recovery Test",
        type: "Topic",
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as { status: string };
      expect(data.status).toBe("created");

      // Graph stats should report healthy
      const stats = await handleGraphStats(deps);
      const statsData = parseResult(stats) as { healthy: boolean };
      expect(statsData.healthy).toBe(true);

      // Cleanup
      try {
        await pool.query(`SELECT drop_graph('${graphName}', true)`);
      } catch {}
      await pool.close();
    });
  });

  describe("error messages are structured", () => {
    let pool: EngramPool;
    let schema: SchemaManager;
    let config: EngramConfig;
    let deps: ToolDeps;
    const graphName = "degradation_errors_test";

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

    it("recall_entity returns structured not-found response", async () => {
      const result = await handleRecallEntity(deps, {
        identifier: "NonExistentEntity12345",
      });
      expect(result.isError).toBeUndefined(); // not-found is not an error
      const data = parseResult(result) as { found: boolean; message: string };
      expect(data.found).toBe(false);
      expect(data.message).toContain("NonExistentEntity12345");
    });

    it("remember_entity returns error for invalid type", async () => {
      const result = await handleRememberEntity(deps, {
        name: "Test",
        type: "InvalidTypeXYZ",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("InvalidTypeXYZ");
    });

    it("remember_relationship returns error for invalid type", async () => {
      // First create an entity to reference
      await handleRememberEntity(deps, {
        name: "ErrorTestPerson",
        type: "Person",
      });

      const result = await handleRememberRelationship(deps, {
        from: "ErrorTestPerson",
        to: "ErrorTestPerson",
        type: "INVALID_REL_TYPE",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("INVALID_REL_TYPE");
    });

    it("remember_entity returns error for missing required fields", async () => {
      const result = await handleRememberEntity(deps, {
        name: "",
        type: "Person",
      });
      expect(result.isError).toBe(true);
    });

    it("graph_stats reports healthy status", async () => {
      const result = await handleGraphStats(deps);
      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as { healthy: boolean };
      expect(data.healthy).toBe(true);
    });
  });
});
