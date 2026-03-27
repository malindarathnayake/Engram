import pg from "pg";
import { type EngramConfig, getConnectionString } from "../config.js";
import { parseAgtype, type AgtypeValue } from "./agtype.js";
import type { PreparedQuery } from "./cypher.js";

const { Pool } = pg;

export interface EngramPool {
  /** The underlying pg Pool */
  pool: pg.Pool;
  /** Graph name from config */
  graphName: string;
  /** Execute a raw SQL query */
  query(text: string, params?: unknown[]): Promise<pg.QueryResult>;
  /** Execute a Cypher query via AGE and parse agtype results */
  cypherQuery(
    cypher: string,
    params?: Record<string, unknown>,
    columns?: string[],
  ): Promise<AgtypeValue[][]>;
  /** Execute a PreparedQuery (from cypher builder) and parse agtype results */
  executePrepared(query: PreparedQuery): Promise<AgtypeValue[][]>;
  /** Acquire a dedicated connection with AGE bootstrapped. Caller must release. */
  acquireWriteConnection(): Promise<pg.PoolClient>;
  /** Health check — verifies pool connectivity and AGE availability */
  healthCheck(): Promise<boolean>;
  /** Shut down the pool */
  close(): Promise<void>;
}

/**
 * Discover the OID for the `agtype` type so we can register a custom parser.
 * Falls back to parsing in application code if OID lookup fails.
 */
async function discoverAgtypeOid(client: pg.PoolClient): Promise<number | null> {
  try {
    const result = await client.query(
      "SELECT oid FROM pg_type WHERE typname = 'agtype'",
    );
    if (result.rows.length > 0) {
      return parseInt(result.rows[0].oid, 10);
    }
  } catch {
    // agtype type may not exist yet
  }
  return null;
}

/**
 * Bootstrap a connection for AGE usage.
 * Runs LOAD 'age' (catches if pre-loaded) and sets search_path.
 */
async function bootstrapConnection(client: pg.PoolClient): Promise<void> {
  try {
    await client.query("LOAD 'age'");
  } catch (err: unknown) {
    // If AGE is in shared_preload_libraries, LOAD may fail or be unnecessary.
    // Verify AGE is available by checking ag_catalog.
    const message = err instanceof Error ? err.message : String(err);
    if (
      !message.includes("already loaded") &&
      !message.includes("shared_preload_libraries")
    ) {
      // Try to verify AGE is available anyway
      try {
        await client.query("SELECT count(*) FROM ag_catalog.ag_graph");
      } catch {
        throw new Error(
          `AGE extension is not available: LOAD failed (${message}) and ag_catalog is not accessible`,
        );
      }
    }
  }

  await client.query(
    `SET search_path = ag_catalog, "$user", public`,
  );
}

/**
 * Create an Engram connection pool with per-connection AGE bootstrap.
 */
export async function createPool(config: EngramConfig): Promise<EngramPool> {
  const connectionString = getConnectionString(config);
  const graphName = config.external.graph_name;

  const pool = new Pool({
    connectionString,
    min: 2,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // Register per-connection AGE bootstrap
  pool.on("connect", (client: pg.PoolClient) => {
    // Use a sync listener that queues the async bootstrap.
    // The pool waits for the connect event to complete before making
    // the client available — we use the client's private _connected promise
    // pattern, but since pg doesn't support async connect listeners natively,
    // we bootstrap on first use instead (see below).
  });

  // Verify initial connectivity and bootstrap
  let agtypeOid: number | null = null;
  const client = await pool.connect();
  try {
    await bootstrapConnection(client);
    agtypeOid = await discoverAgtypeOid(client);
  } finally {
    client.release();
  }

  // Register agtype parser globally if OID discovered
  if (agtypeOid !== null) {
    pg.types.setTypeParser(agtypeOid, (val: string) => val);
  }

  const engramPool: EngramPool = {
    pool,
    graphName,

    async query(text: string, params?: unknown[]): Promise<pg.QueryResult> {
      const client = await pool.connect();
      try {
        await bootstrapConnection(client);
        return await client.query(text, params);
      } finally {
        client.release();
      }
    },

    async cypherQuery(
      cypher: string,
      params?: Record<string, unknown>,
      columns: string[] = ["result"],
    ): Promise<AgtypeValue[][]> {
      const client = await pool.connect();
      try {
        await bootstrapConnection(client);

        const columnDef = columns.map((c) => `${c} agtype`).join(", ");

        let sql: string;
        let sqlParams: unknown[];

        if (params && Object.keys(params).length > 0) {
          sql = `SELECT * FROM cypher('${graphName}', $$ ${cypher} $$, $1) AS (${columnDef})`;
          sqlParams = [JSON.stringify(params)];
        } else {
          sql = `SELECT * FROM cypher('${graphName}', $$ ${cypher} $$) AS (${columnDef})`;
          sqlParams = [];
        }

        const result = await client.query(sql, sqlParams);

        // Parse all agtype values in the result
        return result.rows.map((row: Record<string, string>) =>
          Object.values(row).map((cell) => parseAgtype(cell)),
        );
      } finally {
        client.release();
      }
    },

    async executePrepared(preparedQuery: PreparedQuery): Promise<AgtypeValue[][]> {
      const client = await pool.connect();
      try {
        await bootstrapConnection(client);
        const result = await client.query(preparedQuery.sql, preparedQuery.params);
        return result.rows.map((row: Record<string, string>) =>
          Object.values(row).map((cell) => parseAgtype(cell)),
        );
      } finally {
        client.release();
      }
    },

    async acquireWriteConnection(): Promise<pg.PoolClient> {
      const client = await pool.connect();
      try {
        await bootstrapConnection(client);
      } catch (err) {
        client.release();
        throw err;
      }
      return client;
    },

    async healthCheck(): Promise<boolean> {
      try {
        const client = await pool.connect();
        try {
          await bootstrapConnection(client);
          await client.query("SELECT 1");
          await client.query("SELECT count(*) FROM ag_catalog.ag_graph");
          return true;
        } finally {
          client.release();
        }
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };

  return engramPool;
}
