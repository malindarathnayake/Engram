import { describe, it, expect } from "vitest";
import {
  parseAgtype,
  parseAgtypeRows,
  type AgtypeVertex,
  type AgtypeEdge,
  type AgtypePath,
} from "../../src/db/agtype.js";

describe("parseAgtype", () => {
  describe("null handling", () => {
    it("parses null input", () => {
      expect(parseAgtype(null)).toBeNull();
    });

    it("parses undefined input", () => {
      expect(parseAgtype(undefined)).toBeNull();
    });

    it('parses "null" string', () => {
      expect(parseAgtype("null")).toBeNull();
    });
  });

  describe("scalar values", () => {
    it("parses string", () => {
      expect(parseAgtype('"hello"')).toBe("hello");
    });

    it("parses integer", () => {
      expect(parseAgtype("42")).toBe(42);
    });

    it("parses float", () => {
      expect(parseAgtype("3.14")).toBe(3.14);
    });

    it("parses boolean true", () => {
      expect(parseAgtype("true")).toBe(true);
    });

    it("parses boolean false", () => {
      expect(parseAgtype("false")).toBe(false);
    });

    it("parses typed scalar (::numeric)", () => {
      expect(parseAgtype("42::numeric")).toBe(42);
    });

    it("parses typed scalar (::float8)", () => {
      expect(parseAgtype("3.14::float8")).toBe(3.14);
    });

    it("parses typed string (::text)", () => {
      // AGE doesn't usually emit ::text, but handle gracefully
      expect(parseAgtype('"hello"::text')).toBe("hello");
    });
  });

  describe("vertex", () => {
    it("parses a vertex", () => {
      const raw = `{"id": 844424930131969, "label": "Person", "properties": {"name": "Alice", "uuid": "abc-123"}}::vertex`;
      const result = parseAgtype(raw) as AgtypeVertex;

      expect(result.type).toBe("vertex");
      expect(result.id).toBe("844424930131969");
      expect(result.label).toBe("Person");
      expect(result.properties.name).toBe("Alice");
      expect(result.properties.uuid).toBe("abc-123");
    });

    it("parses vertex with empty properties", () => {
      const raw = `{"id": 1, "label": "Empty", "properties": {}}::vertex`;
      const result = parseAgtype(raw) as AgtypeVertex;

      expect(result.type).toBe("vertex");
      expect(result.label).toBe("Empty");
      expect(result.properties).toEqual({});
    });

    it("parses vertex with numeric properties", () => {
      const raw = `{"id": 1, "label": "Metric", "properties": {"score": 0.95, "count": 42}}::vertex`;
      const result = parseAgtype(raw) as AgtypeVertex;

      expect(result.properties.score).toBe(0.95);
      expect(result.properties.count).toBe(42);
    });
  });

  describe("edge", () => {
    it("parses an edge", () => {
      const raw = `{"id": 1125899906842625, "label": "KNOWS", "start_id": 844424930131969, "end_id": 844424930131970, "properties": {"since": "2024"}}::edge`;
      const result = parseAgtype(raw) as AgtypeEdge;

      expect(result.type).toBe("edge");
      expect(result.id).toBe("1125899906842625");
      expect(result.label).toBe("KNOWS");
      expect(result.start_id).toBe("844424930131969");
      expect(result.end_id).toBe("844424930131970");
      expect(result.properties.since).toBe("2024");
    });

    it("parses edge with empty properties", () => {
      const raw = `{"id": 1, "label": "RELATED", "start_id": 2, "end_id": 3, "properties": {}}::edge`;
      const result = parseAgtype(raw) as AgtypeEdge;

      expect(result.type).toBe("edge");
      expect(result.label).toBe("RELATED");
      expect(result.properties).toEqual({});
    });
  });

  describe("path", () => {
    it("parses a path with vertices and edges", () => {
      const raw = `[{"id": 1, "label": "Person", "properties": {"name": "Alice"}}, {"id": 10, "label": "KNOWS", "start_id": 1, "end_id": 2, "properties": {}}, {"id": 2, "label": "Person", "properties": {"name": "Bob"}}]::path`;
      const result = parseAgtype(raw) as AgtypePath;

      expect(result.type).toBe("path");
      expect(result.vertices).toHaveLength(2);
      expect(result.edges).toHaveLength(1);
      expect(result.vertices[0].properties.name).toBe("Alice");
      expect(result.vertices[1].properties.name).toBe("Bob");
      expect(result.edges[0].label).toBe("KNOWS");
    });

    it("parses empty path", () => {
      const raw = `[]::path`;
      const result = parseAgtype(raw) as AgtypePath;

      expect(result.type).toBe("path");
      expect(result.vertices).toHaveLength(0);
      expect(result.edges).toHaveLength(0);
    });
  });

  describe("JSON values", () => {
    it("parses a JSON array", () => {
      const raw = '[1, 2, 3]';
      const result = parseAgtype(raw);

      expect(result).toEqual([1, 2, 3]);
    });

    it("parses a JSON object", () => {
      const raw = '{"key": "value"}';
      const result = parseAgtype(raw);

      expect(result).toEqual({ key: "value" });
    });
  });

  describe("edge cases", () => {
    it("handles whitespace around value", () => {
      expect(parseAgtype("  42  ")).toBe(42);
    });

    it("handles non-JSON string gracefully", () => {
      // Should return as-is if not parseable
      expect(parseAgtype("not-json")).toBe("not-json");
    });
  });
});

describe("parseAgtypeRows", () => {
  it("parses multiple rows with multiple columns", () => {
    const rows = [
      { v: `{"id": 1, "label": "Person", "properties": {"name": "Alice"}}::vertex` },
      { v: `{"id": 2, "label": "Person", "properties": {"name": "Bob"}}::vertex` },
    ];

    const result = parseAgtypeRows(rows);

    expect(result).toHaveLength(2);
    expect((result[0][0] as AgtypeVertex).properties.name).toBe("Alice");
    expect((result[1][0] as AgtypeVertex).properties.name).toBe("Bob");
  });

  it("handles empty rows", () => {
    expect(parseAgtypeRows([])).toEqual([]);
  });
});
