import { describe, it, expect } from "vitest";
import {
  validateIdentifier,
  validatePropertyKey,
  validateDepth,
  buildPreparedQuery,
  buildCreateNode,
  buildMatchNode,
  buildUpdateNode,
  buildCreateRelationship,
  buildSoftDelete,
  buildTraversal,
} from "../../src/db/cypher.js";

describe("validateIdentifier", () => {
  it("accepts valid identifiers", () => {
    expect(() => validateIdentifier("Person", "label")).not.toThrow();
    expect(() => validateIdentifier("WORKS_AT", "rel type")).not.toThrow();
    expect(() => validateIdentifier("name", "property")).not.toThrow();
    expect(() => validateIdentifier("Ab", "label")).not.toThrow();
    expect(() => validateIdentifier("A1_test_name", "label")).not.toThrow();
  });

  it("rejects single character identifiers", () => {
    expect(() => validateIdentifier("A", "label")).toThrow("Invalid label");
  });

  it("rejects identifiers starting with a number", () => {
    expect(() => validateIdentifier("1Person", "label")).toThrow("Invalid label");
  });

  it("rejects identifiers starting with underscore (labels/rel types)", () => {
    expect(() => validateIdentifier("_deleted", "label")).toThrow("Invalid label");
  });

  it("rejects identifiers with spaces", () => {
    expect(() => validateIdentifier("My Person", "label")).toThrow("Invalid label");
  });

  it("rejects identifiers with special characters", () => {
    expect(() => validateIdentifier("Person;DROP", "label")).toThrow("Invalid label");
    expect(() => validateIdentifier("Person'", "label")).toThrow("Invalid label");
    expect(() => validateIdentifier("Person\"", "label")).toThrow("Invalid label");
  });

  it("rejects empty string", () => {
    expect(() => validateIdentifier("", "label")).toThrow("Invalid label");
  });

  it("rejects identifiers longer than 31 characters", () => {
    const long = "A" + "b".repeat(31); // 32 chars
    expect(() => validateIdentifier(long, "label")).toThrow("Invalid label");
  });

  it("accepts identifiers at max length (31 chars)", () => {
    const maxLen = "A" + "b".repeat(30); // 31 chars
    expect(() => validateIdentifier(maxLen, "label")).not.toThrow();
  });

  // === INJECTION PAYLOADS ===

  it("rejects Cypher injection via label - MERGE attack", () => {
    expect(() =>
      validateIdentifier("Person MERGE (x:Admin)", "label"),
    ).toThrow("Invalid label");
  });

  it("rejects Cypher injection via label - DELETE attack", () => {
    expect(() =>
      validateIdentifier("Person DELETE n", "label"),
    ).toThrow("Invalid label");
  });

  it("rejects Cypher injection via label - backtick escape", () => {
    expect(() =>
      validateIdentifier("Person`--", "label"),
    ).toThrow("Invalid label");
  });

  it("rejects SQL injection via label - semicolon", () => {
    expect(() =>
      validateIdentifier("Person;DROP GRAPH engram;--", "label"),
    ).toThrow("Invalid label");
  });
});

describe("validatePropertyKey", () => {
  it("accepts standard identifiers", () => {
    expect(() => validatePropertyKey("name")).not.toThrow();
    expect(() => validatePropertyKey("role")).not.toThrow();
  });

  it("accepts underscore-prefixed internal keys", () => {
    expect(() => validatePropertyKey("_deleted")).not.toThrow();
    expect(() => validatePropertyKey("_deleted_at")).not.toThrow();
    expect(() => validatePropertyKey("_merged_from")).not.toThrow();
  });

  it("rejects empty string", () => {
    expect(() => validatePropertyKey("")).toThrow("Invalid property key");
  });

  it("rejects keys with spaces", () => {
    expect(() => validatePropertyKey("bad key")).toThrow("Invalid property key");
  });

  it("rejects keys with special characters", () => {
    expect(() => validatePropertyKey("key;DROP")).toThrow("Invalid property key");
  });

  it("rejects double-underscore-only prefix", () => {
    expect(() => validatePropertyKey("__")).toThrow("Invalid property key");
  });
});

describe("validateDepth", () => {
  it("accepts valid depths", () => {
    expect(() => validateDepth(1)).not.toThrow();
    expect(() => validateDepth(3)).not.toThrow();
    expect(() => validateDepth(10)).not.toThrow();
  });

  it("rejects zero", () => {
    expect(() => validateDepth(0)).toThrow("Invalid depth");
  });

  it("rejects negative numbers", () => {
    expect(() => validateDepth(-1)).toThrow("Invalid depth");
  });

  it("rejects values > 10", () => {
    expect(() => validateDepth(11)).toThrow("Invalid depth");
  });

  it("rejects non-integers", () => {
    expect(() => validateDepth(1.5)).toThrow("Invalid depth");
    expect(() => validateDepth(NaN)).toThrow("Invalid depth");
    expect(() => validateDepth(Infinity)).toThrow("Invalid depth");
  });
});

describe("buildPreparedQuery", () => {
  it("builds query without params", () => {
    const result = buildPreparedQuery({
      graphName: "engram",
      cypher: "MATCH (n) RETURN n",
    });

    expect(result.sql).toBe(
      "SELECT * FROM cypher('engram', $$ MATCH (n) RETURN n $$) AS (result agtype)",
    );
    expect(result.params).toEqual([]);
  });

  it("builds query with agtype map params", () => {
    const result = buildPreparedQuery({
      graphName: "engram",
      cypher: "MATCH (n:Person) WHERE n.name = $name RETURN n",
      cypherParams: { name: "Alice" },
    });

    expect(result.sql).toBe(
      `SELECT * FROM cypher('engram', $$ MATCH (n:Person) WHERE n.name = $name RETURN n $$, $1) AS (result agtype)`,
    );
    expect(result.params).toEqual(['{"name":"Alice"}']);
  });

  it("builds query with custom column definitions", () => {
    const result = buildPreparedQuery({
      graphName: "engram",
      cypher: "MATCH (a)-[r]->(b) RETURN a, r, b",
      columns: [
        ["a", "agtype"],
        ["r", "agtype"],
        ["b", "agtype"],
      ],
    });

    expect(result.sql).toContain("AS (a agtype, r agtype, b agtype)");
    expect(result.params).toEqual([]);
  });

  it("rejects invalid graph name", () => {
    expect(() =>
      buildPreparedQuery({
        graphName: "engram'; DROP TABLE users; --",
        cypher: "MATCH (n) RETURN n",
      }),
    ).toThrow("Invalid graph name");
  });

  it("handles empty params object", () => {
    const result = buildPreparedQuery({
      graphName: "engram",
      cypher: "MATCH (n) RETURN n",
      cypherParams: {},
    });
    expect(result.params).toEqual([]);
  });

  it("serializes complex param values in agtype map", () => {
    const result = buildPreparedQuery({
      graphName: "engram",
      cypher: "CREATE (n:Person {name: $name, age: $age, active: $active}) RETURN n",
      cypherParams: { name: "Alice", age: 30, active: true },
    });

    const parsed = JSON.parse(result.params[0] as string);
    expect(parsed).toEqual({ name: "Alice", age: 30, active: true });
  });

  // === VALUE INJECTION PREVENTION (agtype map) ===

  it("prevents SQL injection via param values - DROP attack", () => {
    const result = buildPreparedQuery({
      graphName: "engram",
      cypher: "MATCH (n:Person) WHERE n.name = $name RETURN n",
      cypherParams: { name: "'; DROP GRAPH engram; --" },
    });

    // Value is safely in the agtype map, not interpolated into SQL
    expect(result.sql).not.toContain("DROP");
    expect(result.sql).toContain("$1");
    const parsed = JSON.parse(result.params[0] as string);
    expect(parsed.name).toBe("'; DROP GRAPH engram; --");
  });

  it("prevents SQL injection via param values - DELETE attack", () => {
    const result = buildPreparedQuery({
      graphName: "engram",
      cypher: "MATCH (n:Person) WHERE n.name = $name RETURN n",
      cypherParams: {
        name: 'test"); DELETE FROM ag_catalog.ag_graph; --',
      },
    });

    expect(result.sql).not.toContain("DELETE");
    expect(result.params).toHaveLength(1);
    const parsed = JSON.parse(result.params[0] as string);
    expect(parsed.name).toContain("DELETE");
  });

  it("prevents Cypher injection via param values - MERGE attack", () => {
    const result = buildPreparedQuery({
      graphName: "engram",
      cypher: "CREATE (n:Person {name: $name}) RETURN n",
      cypherParams: { name: "Alice' MERGE (x:Admin {level: 'super'})" },
    });

    expect(result.sql).not.toContain("MERGE");
    expect(result.sql).not.toContain("Admin");
  });
});

describe("buildCreateNode", () => {
  it("builds a CREATE node with properties", () => {
    const result = buildCreateNode("engram", "Person", {
      id: "uuid-1",
      name: "Alice",
    });

    expect(result.sql).toContain("CREATE (n:Person");
    expect(result.sql).toContain("id: $id, name: $name");
    expect(result.sql).toContain("RETURN n");
    expect(result.params).toHaveLength(1);

    const parsed = JSON.parse(result.params[0] as string);
    expect(parsed.id).toBe("uuid-1");
    expect(parsed.name).toBe("Alice");
  });

  it("builds a CREATE node without properties", () => {
    const result = buildCreateNode("engram", "Person", {});

    expect(result.sql).toContain("CREATE (n:Person)");
    expect(result.params).toEqual([]);
  });

  it("rejects invalid label", () => {
    expect(() =>
      buildCreateNode("engram", "Bad Label!", { name: "test" }),
    ).toThrow("Invalid label");
  });

  it("rejects invalid property key (spaces)", () => {
    expect(() =>
      buildCreateNode("engram", "Person", { "bad key": "test" }),
    ).toThrow("Invalid property key");
  });

  it("accepts underscore-prefixed property keys", () => {
    const result = buildCreateNode("engram", "Person", {
      name: "test",
      _deleted: true,
    });
    expect(result.sql).toContain("_deleted: $_deleted");
  });
});

describe("buildMatchNode", () => {
  it("builds a MATCH node with conditions", () => {
    const result = buildMatchNode("engram", "Person", { id: "uuid-1" });

    expect(result.sql).toContain("MATCH (n:Person)");
    expect(result.sql).toContain("WHERE n.id = $id");
    expect(result.sql).toContain("RETURN n");
  });

  it("builds a MATCH node without conditions", () => {
    const result = buildMatchNode("engram", "Person", {});

    expect(result.sql).toContain("MATCH (n:Person) RETURN n");
    expect(result.params).toEqual([]);
  });

  it("supports custom return expression", () => {
    const result = buildMatchNode("engram", "Person", { name: "Alice" }, "n.name");

    expect(result.sql).toContain("RETURN n.name");
  });

  it("builds multiple match conditions with AND", () => {
    const result = buildMatchNode("engram", "Person", {
      name: "Alice",
      type: "developer",
    });

    expect(result.sql).toContain("n.name = $name AND n.type = $type");
  });
});

describe("buildUpdateNode", () => {
  it("builds a MATCH + SET query", () => {
    const result = buildUpdateNode(
      "engram",
      "Person",
      { id: "uuid-1" },
      { name: "Bob", age: 31 },
    );

    expect(result.sql).toContain("MATCH (n:Person)");
    expect(result.sql).toContain("WHERE n.id = $match_id");
    expect(result.sql).toContain("SET n.name = $set_name, n.age = $set_age");
    expect(result.sql).toContain("RETURN n");

    const parsed = JSON.parse(result.params[0] as string);
    expect(parsed.match_id).toBe("uuid-1");
    expect(parsed.set_name).toBe("Bob");
    expect(parsed.set_age).toBe(31);
  });

  it("uses prefixed params to avoid collisions", () => {
    const result = buildUpdateNode(
      "engram",
      "Person",
      { name: "Alice" },
      { name: "Bob" },
    );

    const parsed = JSON.parse(result.params[0] as string);
    expect(parsed.match_name).toBe("Alice");
    expect(parsed.set_name).toBe("Bob");
  });
});

describe("buildCreateRelationship", () => {
  it("builds a relationship creation query", () => {
    const result = buildCreateRelationship(
      "engram",
      "Person",
      "Project",
      "WORKS_ON",
      { id: "uuid-1" },
      { id: "uuid-2" },
    );

    expect(result.sql).toContain("MATCH (a:Person), (b:Project)");
    expect(result.sql).toContain("a.id = $from_id");
    expect(result.sql).toContain("b.id = $to_id");
    expect(result.sql).toContain("CREATE (a)-[r:WORKS_ON]->(b)");
    expect(result.sql).toContain("RETURN r");
  });

  it("includes relationship properties", () => {
    const result = buildCreateRelationship(
      "engram",
      "Person",
      "Project",
      "WORKS_ON",
      { id: "uuid-1" },
      { id: "uuid-2" },
      { since: "2024-01-01", role: "lead" },
    );

    expect(result.sql).toContain("WORKS_ON {since: $rel_since, role: $rel_role}");
    const parsed = JSON.parse(result.params[0] as string);
    expect(parsed.rel_since).toBe("2024-01-01");
    expect(parsed.rel_role).toBe("lead");
  });

  it("rejects invalid relationship type", () => {
    expect(() =>
      buildCreateRelationship(
        "engram",
        "Person",
        "Project",
        "BAD TYPE!",
        { id: "1" },
        { id: "2" },
      ),
    ).toThrow("Invalid relationship type");
  });

  it("rejects invalid from label", () => {
    expect(() =>
      buildCreateRelationship(
        "engram",
        "Bad Label",
        "Project",
        "WORKS_ON",
        { id: "1" },
        { id: "2" },
      ),
    ).toThrow("Invalid from label");
  });
});

describe("buildSoftDelete", () => {
  it("builds a soft-delete query", () => {
    const result = buildSoftDelete("engram", "Person", { id: "uuid-1" });

    expect(result.sql).toContain("MATCH (n:Person)");
    expect(result.sql).toContain("WHERE n.id = $id");
    expect(result.sql).toContain("SET n._deleted = $deleted, n._deleted_at = $deleted_at");
    expect(result.sql).toContain("RETURN n");

    const parsed = JSON.parse(result.params[0] as string);
    expect(parsed.id).toBe("uuid-1");
    expect(parsed.deleted).toBe(true);
    expect(parsed.deleted_at).toBeDefined();
  });
});

describe("buildTraversal", () => {
  it("builds a variable-length path query", () => {
    const result = buildTraversal(
      "engram",
      "Person",
      { id: "uuid-1" },
      3,
    );

    expect(result.sql).toContain("MATCH p = (a:Person)");
    expect(result.sql).toContain("*1..3");
    expect(result.sql).toContain("RETURN p");
    expect(result.sql).toContain("AS (p agtype)");
  });

  it("applies relationship type filter", () => {
    const result = buildTraversal(
      "engram",
      "Person",
      { id: "uuid-1" },
      2,
      ["WORKS_ON", "MANAGES"],
    );

    expect(result.sql).toContain(":WORKS_ON|MANAGES*1..2");
  });

  it("applies limit", () => {
    const result = buildTraversal(
      "engram",
      "Person",
      { id: "uuid-1" },
      3,
      undefined,
      50,
    );

    expect(result.sql).toContain("LIMIT 50");
  });

  it("rejects invalid depth", () => {
    expect(() =>
      buildTraversal("engram", "Person", { id: "1" }, 0),
    ).toThrow("Invalid depth");

    expect(() =>
      buildTraversal("engram", "Person", { id: "1" }, 11),
    ).toThrow("Invalid depth");
  });

  it("rejects invalid limit", () => {
    expect(() =>
      buildTraversal("engram", "Person", { id: "1" }, 3, undefined, 0),
    ).toThrow("Invalid limit");

    expect(() =>
      buildTraversal("engram", "Person", { id: "1" }, 3, undefined, -1),
    ).toThrow("Invalid limit");
  });

  it("filters out soft-deleted nodes", () => {
    const result = buildTraversal(
      "engram",
      "Person",
      { id: "uuid-1" },
      3,
    );

    expect(result.sql).toContain("b._deleted IS NULL OR b._deleted <> true");
  });
});

describe("injection prevention - comprehensive", () => {
  it("value: SQL DROP via agtype map is safe", () => {
    const result = buildCreateNode("engram", "Person", {
      name: "'; DROP GRAPH engram; --",
      bio: 'test"); DELETE FROM ag_catalog.ag_graph; --',
    });

    // Injection strings are in the agtype map, not in SQL
    expect(result.sql).not.toContain("DROP");
    expect(result.sql).not.toContain("DELETE");
    expect(result.sql).toContain("$1");

    const parsed = JSON.parse(result.params[0] as string);
    expect(parsed.name).toBe("'; DROP GRAPH engram; --");
    expect(parsed.bio).toContain("DELETE");
  });

  it("value: Cypher injection via property values is safe", () => {
    const result = buildCreateNode("engram", "Person", {
      name: "Alice' MERGE (x:Admin {level: 'super'})",
    });

    expect(result.sql).not.toContain("MERGE");
    expect(result.sql).not.toContain("Admin");
  });

  it("label: rejects MERGE injection in label position", () => {
    expect(() =>
      buildCreateNode("engram", "Person MERGE (x:Admin)", { name: "test" }),
    ).toThrow("Invalid label");
  });

  it("label: rejects backtick escape in label position", () => {
    expect(() =>
      buildCreateNode("engram", "Person`--", { name: "test" }),
    ).toThrow("Invalid label");
  });

  it("property key: rejects injection in property key", () => {
    expect(() =>
      buildCreateNode("engram", "Person", { "name; DROP": "test" }),
    ).toThrow("Invalid property key");
  });

  it("graph name: rejects injection in graph name", () => {
    expect(() =>
      buildCreateNode("engram'; DROP TABLE users; --", "Person", {
        name: "test",
      }),
    ).toThrow("Invalid graph name");
  });

  it("relationship type: rejects injection in relationship type", () => {
    expect(() =>
      buildCreateRelationship(
        "engram",
        "Person",
        "Person",
        "KNOWS; DELETE",
        { id: "1" },
        { id: "2" },
      ),
    ).toThrow("Invalid relationship type");
  });

  it("depth: rejects non-integer depth injection", () => {
    expect(() =>
      buildTraversal("engram", "Person", { id: "1" }, 1.5),
    ).toThrow("Invalid depth");
  });
});
