/**
 * Prepared Statement Cypher Builder.
 *
 * Builds SQL that uses AGE's `cypher()` function with parameterized queries.
 * User values go in an agtype map (the third argument to cypher()), never
 * interpolated into the Cypher string. Labels and property keys are the ONLY
 * values interpolated — validated against a strict allowlist pattern first.
 *
 * Reference: https://age.apache.org/age-manual/master/advanced/prepared_statements.html
 */

/**
 * Regex for valid AGE identifiers: labels, property keys, relationship types.
 * Must start with a letter, followed by letters/digits/underscores, 2-31 chars total.
 */
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]{1,30}$/;

/**
 * Regex for internal property keys (prefixed with underscore).
 * Used for system properties like _deleted, _deleted_at.
 */
const INTERNAL_PROP_RE = /^_[A-Za-z][A-Za-z0-9_]{0,29}$/;

/**
 * Validate an AGE identifier (label, property key, relationship type).
 * Throws if the identifier is invalid.
 */
export function validateIdentifier(value: string, kind: string): void {
  if (!IDENTIFIER_RE.test(value)) {
    throw new Error(
      `Invalid ${kind}: "${value}". Must match ${IDENTIFIER_RE.source}`,
    );
  }
}

/**
 * Validate a property key, allowing internal underscore-prefixed keys
 * like _deleted, _deleted_at (system properties).
 */
export function validatePropertyKey(value: string): void {
  if (!IDENTIFIER_RE.test(value) && !INTERNAL_PROP_RE.test(value)) {
    throw new Error(
      `Invalid property key: "${value}". Must match ${IDENTIFIER_RE.source} or ${INTERNAL_PROP_RE.source}`,
    );
  }
}

/**
 * Validate that a depth value is a safe positive integer for path length interpolation.
 */
export function validateDepth(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 10) {
    throw new Error(
      `Invalid depth: ${value}. Must be an integer between 1 and 10.`,
    );
  }
}

export interface PreparedQuery {
  /** The SQL string with $1 placeholder for the agtype map */
  sql: string;
  /** The SQL parameters array (0 or 1 element: the JSON-stringified agtype map) */
  params: unknown[];
}

export interface CypherBuildOptions {
  /** The graph name (validated as identifier) */
  graphName: string;
  /** The Cypher query string (with $param references for agtype map keys) */
  cypher: string;
  /** Parameter values to pass in the agtype map */
  cypherParams?: Record<string, unknown>;
  /** Column definitions for the AS clause. Defaults to [["result", "agtype"]] */
  columns?: Array<[name: string, type: string]>;
}

/**
 * Build a prepared SQL query that calls AGE's cypher() function.
 *
 * The generated SQL looks like:
 *   SELECT * FROM cypher('graph', $$ MATCH (n) WHERE n.id = $id RETURN n $$, $1) AS (result agtype)
 *
 * Where $1 is the JSON-stringified agtype map containing all parameter values.
 *
 * @throws Error if graphName contains invalid characters
 */
export function buildPreparedQuery(options: CypherBuildOptions): PreparedQuery {
  const { graphName, cypher, cypherParams, columns } = options;

  validateIdentifier(graphName, "graph name");

  const columnDef =
    columns?.map(([name, type]) => `${name} ${type}`).join(", ") ??
    "result agtype";

  if (cypherParams && Object.keys(cypherParams).length > 0) {
    const sql = `SELECT * FROM cypher('${graphName}', $$ ${cypher} $$, $1) AS (${columnDef})`;
    return {
      sql,
      params: [JSON.stringify(cypherParams)],
    };
  }

  const sql = `SELECT * FROM cypher('${graphName}', $$ ${cypher} $$) AS (${columnDef})`;
  return { sql, params: [] };
}

/**
 * Build a Cypher CREATE node query.
 *
 * Label is validated and interpolated. All property values go in the agtype map.
 */
export function buildCreateNode(
  graphName: string,
  label: string,
  properties: Record<string, unknown>,
): PreparedQuery {
  validateIdentifier(label, "label");

  const propKeys = Object.keys(properties);
  if (propKeys.length === 0) {
    return buildPreparedQuery({
      graphName,
      cypher: `CREATE (n:${label}) RETURN n`,
    });
  }

  // Validate all property keys
  for (const key of propKeys) {
    validatePropertyKey(key);
  }

  // Build property assignment: {key1: $key1, key2: $key2, ...}
  const propAssignment = propKeys.map((k) => `${k}: $${k}`).join(", ");

  return buildPreparedQuery({
    graphName,
    cypher: `CREATE (n:${label} {${propAssignment}}) RETURN n`,
    cypherParams: properties,
  });
}

/**
 * Build a Cypher MATCH node query by property conditions.
 *
 * Label is validated and interpolated. Match values go in the agtype map.
 */
export function buildMatchNode(
  graphName: string,
  label: string,
  matchProps: Record<string, unknown>,
  returnExpr: string = "n",
): PreparedQuery {
  validateIdentifier(label, "label");

  const matchKeys = Object.keys(matchProps);
  if (matchKeys.length === 0) {
    return buildPreparedQuery({
      graphName,
      cypher: `MATCH (n:${label}) RETURN ${returnExpr}`,
    });
  }

  for (const key of matchKeys) {
    validatePropertyKey(key);
  }

  const conditions = matchKeys.map((k) => `n.${k} = $${k}`).join(" AND ");

  return buildPreparedQuery({
    graphName,
    cypher: `MATCH (n:${label}) WHERE ${conditions} RETURN ${returnExpr}`,
    cypherParams: matchProps,
  });
}

/**
 * Build a Cypher MATCH + SET query to update node properties.
 *
 * Match condition and set values all go in the agtype map.
 * Property keys for SET are validated and interpolated.
 */
export function buildUpdateNode(
  graphName: string,
  label: string,
  matchProps: Record<string, unknown>,
  setProps: Record<string, unknown>,
  returnExpr: string = "n",
): PreparedQuery {
  validateIdentifier(label, "label");

  const matchKeys = Object.keys(matchProps);
  const setKeys = Object.keys(setProps);

  for (const key of [...matchKeys, ...setKeys]) {
    validatePropertyKey(key);
  }

  // Use prefixed param names to avoid collisions between match and set values
  const conditions = matchKeys.map((k) => `n.${k} = $match_${k}`).join(" AND ");
  const setAssignments = setKeys.map((k) => `n.${k} = $set_${k}`).join(", ");

  const cypherParams: Record<string, unknown> = {};
  for (const k of matchKeys) {
    cypherParams[`match_${k}`] = matchProps[k];
  }
  for (const k of setKeys) {
    cypherParams[`set_${k}`] = setProps[k];
  }

  const whereClause = matchKeys.length > 0 ? ` WHERE ${conditions}` : "";

  return buildPreparedQuery({
    graphName,
    cypher: `MATCH (n:${label})${whereClause} SET ${setAssignments} RETURN ${returnExpr}`,
    cypherParams,
  });
}

/**
 * Build a Cypher query to create a relationship between two nodes.
 *
 * Relationship type is validated and interpolated. Node IDs and properties
 * go in the agtype map.
 */
export function buildCreateRelationship(
  graphName: string,
  fromLabel: string,
  toLabel: string,
  relType: string,
  fromMatchProps: Record<string, unknown>,
  toMatchProps: Record<string, unknown>,
  relProperties?: Record<string, unknown>,
): PreparedQuery {
  validateIdentifier(fromLabel, "from label");
  validateIdentifier(toLabel, "to label");
  validateIdentifier(relType, "relationship type");

  const fromKeys = Object.keys(fromMatchProps);
  const toKeys = Object.keys(toMatchProps);

  for (const key of fromKeys) {
    validatePropertyKey(key);
  }
  for (const key of toKeys) {
    validatePropertyKey(key);
  }

  const cypherParams: Record<string, unknown> = {};

  const fromConditions = fromKeys
    .map((k) => {
      cypherParams[`from_${k}`] = fromMatchProps[k];
      return `a.${k} = $from_${k}`;
    })
    .join(" AND ");

  const toConditions = toKeys
    .map((k) => {
      cypherParams[`to_${k}`] = toMatchProps[k];
      return `b.${k} = $to_${k}`;
    })
    .join(" AND ");

  let relPropsClause = "";
  if (relProperties && Object.keys(relProperties).length > 0) {
    const relKeys = Object.keys(relProperties);
    for (const key of relKeys) {
      validatePropertyKey(key);
      cypherParams[`rel_${key}`] = relProperties[key];
    }
    const relPropAssignment = relKeys.map((k) => `${k}: $rel_${k}`).join(", ");
    relPropsClause = ` {${relPropAssignment}}`;
  }

  const cypher =
    `MATCH (a:${fromLabel}), (b:${toLabel}) ` +
    `WHERE ${fromConditions} AND ${toConditions} ` +
    `CREATE (a)-[r:${relType}${relPropsClause}]->(b) RETURN r`;

  return buildPreparedQuery({
    graphName,
    cypher,
    cypherParams,
  });
}

/**
 * Build a Cypher MATCH + SET soft-delete query.
 * Sets _deleted = true and _deleted_at timestamp on the node.
 */
export function buildSoftDelete(
  graphName: string,
  label: string,
  matchProps: Record<string, unknown>,
): PreparedQuery {
  validateIdentifier(label, "label");

  const matchKeys = Object.keys(matchProps);
  for (const key of matchKeys) {
    validatePropertyKey(key);
  }

  const conditions = matchKeys.map((k) => `n.${k} = $${k}`).join(" AND ");
  const whereClause = matchKeys.length > 0 ? ` WHERE ${conditions}` : "";

  return buildPreparedQuery({
    graphName,
    cypher:
      `MATCH (n:${label})${whereClause} ` +
      `SET n._deleted = $deleted, n._deleted_at = $deleted_at ` +
      `RETURN n`,
    cypherParams: {
      ...matchProps,
      deleted: true,
      deleted_at: new Date().toISOString(),
    },
  });
}

/**
 * Build a variable-length path traversal query.
 * Depth is validated as an integer and interpolated (AGE doesn't support parameterized path lengths).
 */
export function buildTraversal(
  graphName: string,
  anchorLabel: string,
  anchorMatchProps: Record<string, unknown>,
  depth: number,
  relTypes?: string[],
  limit?: number,
): PreparedQuery {
  validateIdentifier(anchorLabel, "label");
  validateDepth(depth);

  const matchKeys = Object.keys(anchorMatchProps);
  for (const key of matchKeys) {
    validatePropertyKey(key);
  }

  if (relTypes) {
    for (const rt of relTypes) {
      validateIdentifier(rt, "relationship type");
    }
  }

  const cypherParams: Record<string, unknown> = { ...anchorMatchProps };

  const conditions = matchKeys.map((k) => `a.${k} = $${k}`).join(" AND ");
  const whereClause = matchKeys.length > 0 ? ` WHERE ${conditions}` : "";

  const relFilter = relTypes?.length
    ? `:${relTypes.join("|")}`
    : "";

  let cypher =
    `MATCH p = (a:${anchorLabel})${whereClause}-[r${relFilter}*1..${depth}]-(b) ` +
    `WHERE b._deleted IS NULL OR b._deleted <> true ` +
    `RETURN p`;

  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`Invalid limit: ${limit}. Must be a positive integer.`);
    }
    cypher += ` LIMIT ${limit}`;
  }

  return buildPreparedQuery({
    graphName,
    cypher,
    cypherParams,
    columns: [["p", "agtype"]],
  });
}
