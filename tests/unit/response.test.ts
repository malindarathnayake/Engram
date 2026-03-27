import { describe, expect, it } from "vitest";
import { stripDuplicateId, formatRelationship, rawTextResult } from "../../src/format/response.js";

describe("stripDuplicateId", () => {
  it("removes matching properties.id", () => {
    const entity = {
      id: "entity-123",
      name: "Alice",
      properties: {
        id: "entity-123",
        role: "engineer",
      },
    };

    expect(stripDuplicateId(entity)).toEqual({
      id: "entity-123",
      name: "Alice",
      properties: {
        role: "engineer",
      },
    });
  });

  it("preserves non-matching properties.id", () => {
    const entity = {
      id: "entity-123",
      properties: {
        id: "different-id",
        role: "engineer",
      },
    };

    expect(stripDuplicateId(entity)).toEqual(entity);
  });

  it("handles missing properties", () => {
    const entity = {
      id: "entity-123",
      name: "Alice",
    };

    expect(stripDuplicateId(entity)).toEqual(entity);
  });

  it("handles null and undefined input", () => {
    expect(stripDuplicateId(null)).toBeNull();
    expect(stripDuplicateId(undefined)).toBeUndefined();
  });
});

describe("formatRelationship", () => {
  it("produces flat output with entity names", () => {
    const rel = {
      id: "rel-1",
      from_id: "uuid-alice",
      to_id: "uuid-bob",
      type: "WORKS_WITH",
      properties: { id: "rel-1", created_at: "2024-01-01", role: "lead" },
    };
    const nameMap = new Map([
      ["uuid-alice", "Alice"],
      ["uuid-bob", "Bob"],
    ]);

    const result = formatRelationship(rel, nameMap);

    expect(result.type).toBe("WORKS_WITH");
    expect(result.from).toBe("Alice");
    expect(result.to).toBe("Bob");
    expect(result.role).toBe("lead");
    // Internal fields stripped
    expect(result.id).toBeUndefined();
    expect(result.created_at).toBeUndefined();
    expect(result.from_id).toBeUndefined();
    expect(result.to_id).toBeUndefined();
  });

  it("falls back to UUID when name not in map", () => {
    const rel = {
      id: "rel-2",
      from_id: "uuid-alice",
      to_id: "uuid-unknown",
      type: "KNOWS",
      properties: {},
    };
    const nameMap = new Map([["uuid-alice", "Alice"]]);

    const result = formatRelationship(rel, nameMap);

    expect(result.from).toBe("Alice");
    expect(result.to).toBe("uuid-unknown");
  });

  it("prefixes legacy collision keys with prop_", () => {
    const rel = {
      id: "rel-3",
      from_id: "uuid-a",
      to_id: "uuid-b",
      type: "HAS",
      properties: { type: "custom-type", from: "origin", role: "admin" },
    };
    const nameMap = new Map<string, string>();

    const result = formatRelationship(rel, nameMap);

    // "type" collides with rel.type → becomes prop_type
    expect(result.prop_type).toBe("custom-type");
    // "from" collides with the from field → becomes prop_from
    expect(result.prop_from).toBe("origin");
    // "role" doesn't collide → stays as-is
    expect(result.role).toBe("admin");
    // The structural fields are still set correctly
    expect(result.type).toBe("HAS");
  });
});

describe("rawTextResult", () => {
  it("returns plain text without JSON.stringify", () => {
    const result = rawTextResult("hello world");

    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toBe("hello world");
    expect(result.isError).toBeUndefined();
  });
});
