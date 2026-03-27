import type { EngramPool } from "./connection.js";

/**
 * Verify that required PostgreSQL extensions are loaded.
 */
async function verifyExtensions(pool: EngramPool): Promise<void> {
  const result = await pool.query(
    "SELECT extname FROM pg_extension WHERE extname IN ('age', 'vector') ORDER BY extname",
  );
  const loaded = result.rows.map((r: { extname: string }) => r.extname);

  if (!loaded.includes("age")) {
    throw new Error(
      "Apache AGE extension is not installed. Run: CREATE EXTENSION age;",
    );
  }
  // pgvector is optional in v1 but expected
  if (!loaded.includes("vector")) {
    console.warn(
      "pgvector extension not found — vector similarity features will be unavailable",
    );
  }
}

/**
 * Check if the graph exists in AGE.
 */
async function graphExists(
  pool: EngramPool,
  graphName: string,
): Promise<boolean> {
  const result = await pool.query(
    "SELECT count(*) AS cnt FROM ag_catalog.ag_graph WHERE name = $1",
    [graphName],
  );
  return parseInt(result.rows[0].cnt, 10) > 0;
}

/**
 * Create the graph if it doesn't exist.
 */
async function createGraph(
  pool: EngramPool,
  graphName: string,
): Promise<void> {
  await pool.query(`SELECT create_graph('${graphName}')`);
}

/**
 * Initialize the database: verify extensions, ensure graph exists.
 *
 * @returns true if a new graph was created, false if it already existed.
 */
export async function initializeDatabase(pool: EngramPool): Promise<boolean> {
  await verifyExtensions(pool);

  const exists = await graphExists(pool, pool.graphName);
  if (exists) {
    return false;
  }

  await createGraph(pool, pool.graphName);
  return true;
}
