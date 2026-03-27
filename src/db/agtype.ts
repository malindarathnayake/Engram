/**
 * AGE agtype result parser.
 *
 * AGE returns all Cypher query results as `agtype` — a PostgreSQL extension type.
 * The pg driver receives these as raw strings. This module parses them into
 * structured JavaScript objects.
 *
 * agtype wire formats:
 *   Vertex:  {"id": N, "label": "L", "properties": {...}}::vertex
 *   Edge:    {"id": N, "label": "L", "start_id": N, "end_id": N, "properties": {...}}::edge
 *   Path:    [vertex, edge, vertex, ...]::path
 *   Scalar:  "string", 42, true, false, null, [array], {object}
 */

export interface AgtypeVertex {
  type: "vertex";
  id: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface AgtypeEdge {
  type: "edge";
  id: string;
  label: string;
  start_id: string;
  end_id: string;
  properties: Record<string, unknown>;
}

export interface AgtypePath {
  type: "path";
  vertices: AgtypeVertex[];
  edges: AgtypeEdge[];
}

export interface AgtypeArray extends Array<AgtypeValue> {}
export interface AgtypeMap {
  [key: string]: AgtypeValue;
}

export type AgtypeValue =
  | AgtypeVertex
  | AgtypeEdge
  | AgtypePath
  | string
  | number
  | boolean
  | null
  | AgtypeArray
  | AgtypeMap;

/**
 * Parse a single agtype result string into a JS value.
 *
 * Handles ::vertex, ::edge, ::path suffixes and plain JSON scalars/objects/arrays.
 */
export function parseAgtype(raw: string | null | undefined): AgtypeValue {
  if (raw === null || raw === undefined || raw === "null") {
    return null;
  }

  const trimmed = raw.trim();

  // Check for typed suffixes
  if (trimmed.endsWith("::vertex")) {
    return parseVertex(trimmed.slice(0, -"::vertex".length));
  }
  if (trimmed.endsWith("::edge")) {
    return parseEdge(trimmed.slice(0, -"::edge".length));
  }
  if (trimmed.endsWith("::path")) {
    return parsePath(trimmed.slice(0, -"::path".length));
  }

  // Plain JSON value (scalar, object, or array)
  // AGE may also suffix scalars like ::numeric, ::float8, ::integer — strip those
  const typeSuffixMatch = trimmed.match(/^(.+?)::\w+$/);
  if (typeSuffixMatch) {
    return parseJsonSafe(typeSuffixMatch[1]);
  }

  return parseJsonSafe(trimmed);
}

/**
 * Parse an array of agtype result rows (each row is an array of agtype strings).
 */
export function parseAgtypeRows(rows: Array<Record<string, string>>): AgtypeValue[][] {
  return rows.map((row) =>
    Object.values(row).map((cell) => parseAgtype(cell)),
  );
}

function parseVertex(json: string): AgtypeVertex {
  const obj = JSON.parse(json);
  return {
    type: "vertex",
    id: String(obj.id),
    label: obj.label,
    properties: parseNestedProperties(obj.properties ?? {}),
  };
}

function parseEdge(json: string): AgtypeEdge {
  const obj = JSON.parse(json);
  return {
    type: "edge",
    id: String(obj.id),
    label: obj.label,
    start_id: String(obj.start_id),
    end_id: String(obj.end_id),
    properties: parseNestedProperties(obj.properties ?? {}),
  };
}

function parsePath(json: string): AgtypePath {
  const elements = JSON.parse(json) as unknown[];
  const vertices: AgtypeVertex[] = [];
  const edges: AgtypeEdge[] = [];

  for (const el of elements) {
    if (typeof el === "string") {
      // Elements within a path may themselves be agtype-encoded strings
      const parsed = parseAgtype(el);
      if (parsed && typeof parsed === "object" && "type" in parsed) {
        if (parsed.type === "vertex") vertices.push(parsed as AgtypeVertex);
        else if (parsed.type === "edge") edges.push(parsed as AgtypeEdge);
      }
    } else if (typeof el === "object" && el !== null) {
      const record = el as Record<string, unknown>;
      if ("start_id" in record && "end_id" in record) {
        edges.push({
          type: "edge",
          id: String(record.id),
          label: record.label as string,
          start_id: String(record.start_id),
          end_id: String(record.end_id),
          properties: parseNestedProperties(
            (record.properties as Record<string, unknown>) ?? {},
          ),
        });
      } else if ("label" in record) {
        vertices.push({
          type: "vertex",
          id: String(record.id),
          label: record.label as string,
          properties: parseNestedProperties(
            (record.properties as Record<string, unknown>) ?? {},
          ),
        });
      }
    }
  }

  return { type: "path", vertices, edges };
}

/**
 * Recursively parse nested property values that may contain agtype-encoded strings.
 */
function parseNestedProperties(
  props: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (typeof value === "string" && value.includes("::")) {
      try {
        result[key] = parseAgtype(value);
      } catch {
        result[key] = value;
      }
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parseJsonSafe(str: string): AgtypeValue {
  try {
    return JSON.parse(str) as AgtypeValue;
  } catch {
    // Return as plain string if not valid JSON
    return str;
  }
}
