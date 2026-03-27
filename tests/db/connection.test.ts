import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig } from "../../src/config.js";

// These tests require a running PostgreSQL+AGE instance via testcontainers.
// The globalSetup (tests/setup.ts) sets ENGRAM_TEST_DB.

describe("connection pool", () => {
  let pool: EngramPool;

  beforeAll(async () => {
    const testDb = process.env.ENGRAM_TEST_DB;
    if (!testDb) {
      throw new Error(
        "ENGRAM_TEST_DB not set — testcontainers global setup may have failed",
      );
    }

    // Parse the test connection string into config
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
        graph_name: "engram_test",
      },
    });

    pool = await createPool(config);
  });

  afterAll(async () => {
    if (pool) {
      // Clean up test graph
      try {
        await pool.query("SELECT drop_graph('engram_test', true)");
      } catch {
        // Graph may not exist
      }
      await pool.close();
    }
  });

  it("creates a pool and connects", async () => {
    expect(pool).toBeDefined();
    expect(pool.graphName).toBe("engram_test");
  });

  it("bootstraps AGE on each connection", async () => {
    // If bootstrap fails, this query would throw
    const result = await pool.query(
      "SELECT count(*) AS cnt FROM ag_catalog.ag_graph",
    );
    expect(parseInt(result.rows[0].cnt, 10)).toBeGreaterThanOrEqual(0);
  });

  it("passes health check", async () => {
    const healthy = await pool.healthCheck();
    expect(healthy).toBe(true);
  });

  it("initializes database and creates graph", async () => {
    const created = await initializeDatabase(pool);
    expect(created).toBe(true);

    // Graph should now exist
    const result = await pool.query(
      "SELECT count(*) AS cnt FROM ag_catalog.ag_graph WHERE name = $1",
      ["engram_test"],
    );
    expect(parseInt(result.rows[0].cnt, 10)).toBe(1);
  });

  it("initializeDatabase returns false when graph already exists", async () => {
    const created = await initializeDatabase(pool);
    expect(created).toBe(false);
  });

  it("executes a basic Cypher query", async () => {
    const rows = await pool.cypherQuery(
      "CREATE (n:TestNode {name: 'test'}) RETURN n",
    );
    expect(rows).toHaveLength(1);
    const vertex = rows[0][0];
    expect(vertex).toBeDefined();
    expect(typeof vertex === "object" && vertex !== null && "type" in vertex).toBe(true);
    if (typeof vertex === "object" && vertex !== null && "type" in vertex) {
      expect(vertex.type).toBe("vertex");
    }
  });

  it("executes a parameterized Cypher query", async () => {
    const rows = await pool.cypherQuery(
      "MATCH (n:TestNode) WHERE n.name = $name RETURN n",
      { name: "test" },
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
