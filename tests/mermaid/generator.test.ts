import { describe, it, expect } from "vitest";
import {
  generateMermaid,
  type MermaidInput,
} from "../../src/mermaid/generator.js";
import type { TraversalEntity } from "../../src/graph/traversal.js";
import type { RelationshipResult } from "../../src/graph/relationships.js";

function makeEntity(
  id: string,
  name: string,
  type: string
): TraversalEntity {
  return { id, name, type, properties: {} };
}

function makeRel(
  id: string,
  from_id: string,
  to_id: string,
  type: string
): RelationshipResult {
  return { id, from_id, to_id, type, properties: {} };
}

describe("generateMermaid", () => {
  describe("empty input", () => {
    it("returns placeholder for empty entities", () => {
      const result = generateMermaid({ entities: [], relationships: [] });
      expect(result.mermaid).toContain("graph LR");
      expect(result.mermaid).toContain("No entities found");
      expect(result.truncated).toBe(false);
      expect(result.node_count).toBe(0);
      expect(result.edge_count).toBe(0);
    });
  });

  describe("node shapes", () => {
    it("uses round shape for Person type", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "Alice", "Person")],
        relationships: [],
      });
      expect(result.mermaid).toContain("(Alice)");
      expect(result.node_count).toBe(1);
    });

    it("uses square shape for Project type", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "MyProject", "Project")],
        relationships: [],
      });
      expect(result.mermaid).toContain("[MyProject]");
    });

    it("uses diamond shape for Decision type", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "Use AGE", "Decision")],
        relationships: [],
      });
      expect(result.mermaid).toContain("{Use AGE}");
    });

    it("uses double-bracket shape for Event type", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "Sprint Review", "Event")],
        relationships: [],
      });
      expect(result.mermaid).toContain("[[Sprint Review]]");
    });

    it("uses curly braces for Concept type", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "GraphDB", "Concept")],
        relationships: [],
      });
      expect(result.mermaid).toContain("{{GraphDB}}");
    });

    it("uses default square shape for unknown types", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "Custom", "UnknownType")],
        relationships: [],
      });
      expect(result.mermaid).toContain("[Custom]");
    });

    it("uses asymmetric shape for Fact type", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "Sky is blue", "Fact")],
        relationships: [],
      });
      expect(result.mermaid).toContain(">Sky is blue]");
    });
  });

  describe("edge labels", () => {
    it("renders edges with relationship type labels", () => {
      const entities = [
        makeEntity("uuid-1", "Alice", "Person"),
        makeEntity("uuid-2", "ProjectX", "Project"),
      ];
      const relationships = [
        makeRel("rel-1", "uuid-1", "uuid-2", "WORKS_ON"),
      ];
      const result = generateMermaid({ entities, relationships });
      expect(result.mermaid).toContain("-->|WORKS_ON|");
      expect(result.edge_count).toBe(1);
    });

    it("renders multiple edges", () => {
      const entities = [
        makeEntity("uuid-1", "Alice", "Person"),
        makeEntity("uuid-2", "Bob", "Person"),
        makeEntity("uuid-3", "ProjectX", "Project"),
      ];
      const relationships = [
        makeRel("rel-1", "uuid-1", "uuid-3", "WORKS_ON"),
        makeRel("rel-2", "uuid-2", "uuid-3", "WORKS_ON"),
        makeRel("rel-3", "uuid-1", "uuid-2", "KNOWS"),
      ];
      const result = generateMermaid({ entities, relationships });
      expect(result.edge_count).toBe(3);
      expect(result.node_count).toBe(3);
    });
  });

  describe("special character escaping", () => {
    it("escapes names with brackets", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "Array[String]", "Concept")],
        relationships: [],
      });
      // Should be wrapped in quotes since brackets are special
      expect(result.mermaid).toContain('"Array[String]"');
    });

    it("escapes names with parentheses", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "func(x)", "Concept")],
        relationships: [],
      });
      expect(result.mermaid).toMatch(/"func\(x\)"/);
    });

    it("escapes names with double quotes", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", 'He said "hello"', "Person")],
        relationships: [],
      });
      expect(result.mermaid).toContain("#quot;");
    });

    it("handles ampersands and semicolons", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "A & B; C", "Concept")],
        relationships: [],
      });
      expect(result.mermaid).toContain('"A & B; C"');
    });
  });

  describe("label truncation", () => {
    it("truncates names longer than 40 characters", () => {
      const longName = "A".repeat(50);
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", longName, "Person")],
        relationships: [],
      });
      expect(result.mermaid).toContain("...");
      expect(result.mermaid).not.toContain(longName);
    });

    it("does not truncate names at exactly 40 characters", () => {
      const name = "A".repeat(40);
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", name, "Person")],
        relationships: [],
      });
      expect(result.mermaid).toContain(name);
      expect(result.mermaid).not.toContain("...");
    });
  });

  describe("node truncation (maxNodes)", () => {
    it("truncates when entities exceed maxNodes", () => {
      const entities = Array.from({ length: 10 }, (_, i) =>
        makeEntity(`uuid-${i}`, `Entity${i}`, "Person")
      );
      const result = generateMermaid({
        entities,
        relationships: [],
        maxNodes: 5,
      });
      expect(result.truncated).toBe(true);
      expect(result.node_count).toBe(5);
      expect(result.mermaid).toContain("showing 5 of 10 nodes");
    });

    it("does not truncate when entities equal maxNodes", () => {
      const entities = Array.from({ length: 5 }, (_, i) =>
        makeEntity(`uuid-${i}`, `Entity${i}`, "Person")
      );
      const result = generateMermaid({
        entities,
        relationships: [],
        maxNodes: 5,
      });
      expect(result.truncated).toBe(false);
      expect(result.node_count).toBe(5);
      expect(result.mermaid).not.toContain("Truncated");
    });

    it("filters relationships to only visible nodes when truncated", () => {
      const entities = Array.from({ length: 10 }, (_, i) =>
        makeEntity(`uuid-${i}`, `Entity${i}`, "Person")
      );
      const relationships = [
        makeRel("rel-1", "uuid-0", "uuid-1", "KNOWS"), // both visible
        makeRel("rel-2", "uuid-0", "uuid-8", "KNOWS"), // uuid-8 truncated
        makeRel("rel-3", "uuid-7", "uuid-9", "KNOWS"), // both truncated
      ];
      const result = generateMermaid({
        entities,
        relationships,
        maxNodes: 5,
      });
      expect(result.edge_count).toBe(1); // only rel-1 survives
    });

    it("defaults maxNodes to 30", () => {
      const entities = Array.from({ length: 31 }, (_, i) =>
        makeEntity(`uuid-${i}`, `Entity${i}`, "Person")
      );
      const result = generateMermaid({ entities, relationships: [] });
      expect(result.truncated).toBe(true);
      expect(result.node_count).toBe(30);
    });
  });

  describe("safe node IDs", () => {
    it("converts UUIDs to valid Mermaid IDs", () => {
      const result = generateMermaid({
        entities: [
          makeEntity(
            "550e8400-e29b-41d4-a716-446655440000",
            "Alice",
            "Person"
          ),
        ],
        relationships: [],
      });
      expect(result.mermaid).toContain("n_550e8400_e29b_41d4_a716_446655440000");
      expect(result.mermaid).not.toContain("550e8400-e29b");
    });
  });

  describe("valid Mermaid syntax", () => {
    it("starts with graph LR", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "Alice", "Person")],
        relationships: [],
      });
      expect(result.mermaid).toMatch(/^graph LR/);
    });

    it("produces complete graph with nodes and edges", () => {
      const entities = [
        makeEntity("uuid-1", "Alice", "Person"),
        makeEntity("uuid-2", "ProjectX", "Project"),
        makeEntity("uuid-3", "Use TypeScript", "Decision"),
      ];
      const relationships = [
        makeRel("rel-1", "uuid-1", "uuid-2", "WORKS_ON"),
        makeRel("rel-2", "uuid-2", "uuid-3", "DECIDED"),
      ];
      const result = generateMermaid({ entities, relationships });

      const lines = result.mermaid.split("\n");
      expect(lines[0]).toBe("graph LR");
      // 3 node lines + 2 edge lines = 5 content lines
      expect(lines.length).toBe(6); // header + 3 nodes + 2 edges
      expect(result.node_count).toBe(3);
      expect(result.edge_count).toBe(2);
    });
  });

  describe("Team and Organization shapes", () => {
    it("uses round shape for Team", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "Backend Team", "Team")],
        relationships: [],
      });
      expect(result.mermaid).toContain("(Backend Team)");
    });

    it("uses round shape for Organization", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "Acme Corp", "Organization")],
        relationships: [],
      });
      expect(result.mermaid).toContain("(Acme Corp)");
    });
  });

  describe("Technology and Skill shapes", () => {
    it("uses hexagon shape for Technology", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "PostgreSQL", "Technology")],
        relationships: [],
      });
      expect(result.mermaid).toContain("{{PostgreSQL}}");
    });

    it("uses hexagon shape for Skill", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "TypeScript", "Skill")],
        relationships: [],
      });
      expect(result.mermaid).toContain("{{TypeScript}}");
    });
  });

  describe("Repository and Codebase shapes", () => {
    it("uses square shape for Repository", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "engram", "Repository")],
        relationships: [],
      });
      expect(result.mermaid).toContain("[engram]");
    });
  });

  describe("Meeting shape", () => {
    it("uses double-bracket shape for Meeting", () => {
      const result = generateMermaid({
        entities: [makeEntity("uuid-1", "Standup", "Meeting")],
        relationships: [],
      });
      expect(result.mermaid).toContain("[[Standup]]");
    });
  });

  describe("edge rendering regression", () => {
    it("renders edges between entities when both endpoints are visible", () => {
      // Regression test: edges must appear when from_id/to_id match entity IDs
      const entities = [
        makeEntity("uuid-alice", "Alice", "Person"),
        makeEntity("uuid-bob", "Bob", "Person"),
        makeEntity("uuid-project", "Project Atlas", "Project"),
      ];
      const relationships = [
        makeRel("rel-1", "uuid-alice", "uuid-bob", "REPORTS_TO"),
        makeRel("rel-2", "uuid-alice", "uuid-project", "OWNS"),
      ];
      const result = generateMermaid({ entities, relationships });

      expect(result.edge_count).toBe(2);
      expect(result.mermaid).toContain("-->|REPORTS_TO|");
      expect(result.mermaid).toContain("-->|OWNS|");
      // Verify edge lines reference correct node IDs
      expect(result.mermaid).toContain("n_uuid_alice");
      expect(result.mermaid).toContain("n_uuid_bob");
      expect(result.mermaid).toContain("n_uuid_project");
    });
  });
});
