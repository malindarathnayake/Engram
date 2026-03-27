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
} from "../../src/tools/write-tools.js";
import {
  handleRecallEntity,
  handleSearchEntities,
} from "../../src/tools/read-tools.js";

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0].text);
}

describe("full pipeline injection tests", () => {
  let pool: EngramPool;
  let schema: SchemaManager;
  let config: EngramConfig;
  let deps: ToolDeps;
  const graphName = "injection_test";

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

  describe("Cypher injection via entity names", () => {
    it("handles SQL injection in entity name (DROP attempt)", async () => {
      const result = await handleRememberEntity(deps, {
        name: "'; DROP GRAPH injection_test; --",
        type: "Person",
      });
      // Should either succeed (name stored safely) or error without executing injection
      if (!result.isError) {
        const data = parseResult(result) as { id: string; status: string };
        expect(data.id).toBeDefined();
        expect(data.status).toBe("created");
      }

      // Verify graph still exists
      const graphCheck = await pool.query(
        "SELECT count(*) AS cnt FROM ag_catalog.ag_graph WHERE name = $1",
        [graphName],
      );
      expect(parseInt(graphCheck.rows[0].cnt, 10)).toBe(1);
    });

    it("handles Cypher injection in entity name (DELETE attempt)", async () => {
      const result = await handleRememberEntity(deps, {
        name: 'test"); DELETE FROM ag_catalog.ag_graph; --',
        type: "Person",
      });
      if (!result.isError) {
        const data = parseResult(result) as { status: string };
        expect(data.status).toBe("created");
      }

      // Graph must still exist
      const graphCheck = await pool.query(
        "SELECT count(*) AS cnt FROM ag_catalog.ag_graph WHERE name = $1",
        [graphName],
      );
      expect(parseInt(graphCheck.rows[0].cnt, 10)).toBe(1);
    });

    it("handles Cypher injection in entity name (MERGE attempt)", async () => {
      const result = await handleRememberEntity(deps, {
        name: "test' MERGE (x:Admin {role: 'superuser'}) //",
        type: "Person",
      });
      // Value goes into agtype map parameter, injection impossible
      if (!result.isError) {
        const data = parseResult(result) as { status: string };
        expect(data.status).toBe("created");
      }
    });
  });

  describe("Cypher injection via entity type (label validation)", () => {
    it("rejects type with Cypher injection (MERGE attempt)", async () => {
      const result = await handleRememberEntity(deps, {
        name: "Innocent Entity",
        type: "Person MERGE (x:Admin)",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/invalid|not.*valid|reject/i);
    });

    it("rejects type with special characters", async () => {
      const result = await handleRememberEntity(deps, {
        name: "Test",
        type: "Person'; DROP TABLE--",
      });
      expect(result.isError).toBe(true);
    });

    it("rejects type with spaces", async () => {
      const result = await handleRememberEntity(deps, {
        name: "Test",
        type: "My Type",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("Cypher injection via relationship type", () => {
    it("rejects relationship type with injection payload", async () => {
      // First create a valid entity
      await handleRememberEntity(deps, {
        name: "InjectionRelSource",
        type: "Person",
      });

      const result = await handleRememberRelationship(deps, {
        from: "InjectionRelSource",
        to: "InjectionRelSource",
        type: "WORKS_ON]->(x:Admin) MERGE (y:Backdoor)//",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("Cypher injection via property values", () => {
    it("safely stores property values with Cypher payloads", async () => {
      const result = await handleRememberEntity(deps, {
        name: "PropInjectionTest",
        type: "Person",
        properties: {
          bio: "I am $$}) RETURN 1; SELECT drop_graph('injection_test', true); --$$",
          notes: "'; MERGE (h:Hacker {pwned: true}) RETURN h; //",
        },
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as { status: string; id: string };
      expect(data.status).toBe("created");

      // Recall and verify properties stored as-is
      const recalled = await handleRecallEntity(deps, {
        identifier: data.id,
      });
      const recalledData = parseResult(recalled) as {
        found: boolean;
        properties: Record<string, unknown>;
      };
      expect(recalledData.found).toBe(true);
      expect(recalledData.properties.bio).toContain("drop_graph");
      expect(recalledData.properties.notes).toContain("MERGE");
    });
  });

  describe("Cypher injection via fact content", () => {
    it("safely stores fact with injection payload", async () => {
      // Create entity first
      await handleRememberEntity(deps, {
        name: "FactInjectionEntity",
        type: "Topic",
      });

      const result = await handleSupersedeFact(deps, {
        entity: "FactInjectionEntity",
        new_fact: "$$}) RETURN 1; SELECT drop_graph('injection_test', true); --$$",
        source: "'; DROP TABLE ag_catalog.ag_graph; --",
      });
      expect(result.isError).toBeUndefined();

      // Verify graph still intact
      const graphCheck = await pool.query(
        "SELECT count(*) AS cnt FROM ag_catalog.ag_graph WHERE name = $1",
        [graphName],
      );
      expect(parseInt(graphCheck.rows[0].cnt, 10)).toBe(1);
    });
  });

  describe("Cypher injection via search queries", () => {
    it("safely handles search with injection payload", async () => {
      const result = await handleSearchEntities(deps, {
        query: "$$}) RETURN 1; --$$",
      });
      // Should return empty results, not crash
      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as { count: number };
      expect(data.count).toBe(0);
    });

    it("safely handles search with SQL injection", async () => {
      const result = await handleSearchEntities(deps, {
        query: "' OR '1'='1",
      });
      expect(result.isError).toBeUndefined();
    });
  });

  describe("post-injection graph integrity", () => {
    it("graph is still intact after all injection attempts", async () => {
      // Verify graph exists
      const graphCheck = await pool.query(
        "SELECT count(*) AS cnt FROM ag_catalog.ag_graph WHERE name = $1",
        [graphName],
      );
      expect(parseInt(graphCheck.rows[0].cnt, 10)).toBe(1);

      // Verify we can still create entities
      const result = await handleRememberEntity(deps, {
        name: "PostInjectionEntity",
        type: "Person",
      });
      expect(result.isError).toBeUndefined();
      const data = parseResult(result) as { status: string };
      expect(data.status).toBe("created");

      // Verify pool health
      const healthy = await pool.healthCheck();
      expect(healthy).toBe(true);
    });
  });
});
