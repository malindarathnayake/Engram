import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig, type EngramConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";
import type { ToolDeps } from "../../src/tools/write-tools.js";
import { handleRememberEntity, handleRememberRelationship } from "../../src/tools/write-tools.js";
import {
  handleRecallEntity,
  handleRecallConnections,
  handleRecallContext,
  handleRecallTimeline,
  handleFindContradictions,
  handleSearchEntities,
  handleListEntities,
  handleExportGraph,
  handleGraphStats,
} from "../../src/tools/read-tools.js";
import { handleSupersedeFact } from "../../src/tools/write-tools.js";

describe("read tools", () => {
  let pool: EngramPool;
  let schema: SchemaManager;
  let config: EngramConfig;
  let deps: ToolDeps;
  const graphName = "read_tools_test";

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

    // Seed data for read tests
    await handleRememberEntity(deps, { name: "RT_Alice", type: "Person" });
    await handleRememberEntity(deps, { name: "RT_Bob", type: "Person" });
    await handleRememberEntity(deps, { name: "RT_ProjectX", type: "Project" });
    await handleRememberRelationship(deps, {
      from: "RT_Alice",
      to: "RT_ProjectX",
      type: "WORKS_AT",
    });
    await handleRememberRelationship(deps, {
      from: "RT_Bob",
      to: "RT_ProjectX",
      type: "WORKS_AT",
    });
    await handleRememberRelationship(deps, {
      from: "RT_Alice",
      to: "RT_Bob",
      type: "COLLABORATES_WITH",
    });
    for (let index = 1; index <= 6; index += 1) {
      await handleRememberEntity(deps, {
        name: `RT_TimelineProject_${index}`,
        type: "Project",
      });
      await handleRememberRelationship(deps, {
        from: "RT_Alice",
        to: `RT_TimelineProject_${index}`,
        type: "WORKS_AT",
      });
    }
    await handleSupersedeFact(deps, {
      entity: "RT_Alice",
      new_fact: "Works at Acme Corp",
    });
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`SELECT drop_graph('${graphName}', true)`);
      } catch {}
      await pool.close();
    }
  });

  describe("handleRecallEntity", () => {
    it("retrieves an entity by name", async () => {
      const result = await handleRecallEntity(deps, {
        identifier: "RT_Alice",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.found).toBe(true);
      expect(data.name).toBe("RT_Alice");
      expect(data.type).toBe("Person");
      expect(data.properties.id).toBeUndefined();
    });

    it("retrieves an entity with relationships", async () => {
      const result = await handleRecallEntity(deps, {
        identifier: "RT_Alice",
        include_relationships: true,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.found).toBe(true);
      expect(data.relationships).toBeDefined();
      expect(data.relationships.length).toBeGreaterThan(0);
    });

    it("returns relationships in flat format with entity names", async () => {
      const result = await handleRecallEntity(deps, {
        identifier: "RT_Alice",
        include_relationships: true,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.relationships.length).toBeGreaterThan(0);

      // Verify flat format — has "from"/"to" names, no "from_id"/"to_id"
      const rel = data.relationships[0];
      expect(rel.from).toBeDefined();
      expect(rel.to).toBeDefined();
      expect(rel.type).toBeDefined();
      expect(rel.from_id).toBeUndefined();
      expect(rel.to_id).toBeUndefined();
      expect(rel.id).toBeUndefined();

      // Verify the anchor entity name appears (not UUID)
      const allNames = data.relationships.map((r: Record<string, unknown>) => [r.from, r.to]).flat();
      expect(allNames).toContain("RT_Alice");
    });

    it("returns not-found for nonexistent entity", async () => {
      const result = await handleRecallEntity(deps, {
        identifier: "RT_Nonexistent_xyz",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.found).toBe(false);
    });

    it("returns error for missing identifier", async () => {
      const result = await handleRecallEntity(deps, { identifier: "" });
      expect(result.isError).toBe(true);
    });
  });

  describe("handleRecallConnections", () => {
    it("traverses from an entity", async () => {
      const result = await handleRecallConnections(deps, {
        identifier: "RT_Alice",
        depth: 2,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.anchor.name).toBe("RT_Alice");
      expect(data.entities.length).toBeGreaterThan(0);
      expect(data.relationships.length).toBeGreaterThan(0);
      expect(data.anchor.properties.id).toBeUndefined();
      expect(data.entities[0].properties.id).toBeUndefined();
    });

    it("returns relationships in flat format", async () => {
      const result = await handleRecallConnections(deps, {
        identifier: "RT_Alice",
        depth: 1,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);

      const rel = data.relationships[0];
      expect(rel.from).toBeDefined();
      expect(rel.to).toBeDefined();
      expect(rel.type).toBeDefined();
      expect(rel.from_id).toBeUndefined();
      expect(rel.to_id).toBeUndefined();
    });

    it("includes mermaid when requested", async () => {
      const result = await handleRecallConnections(deps, {
        identifier: "RT_Alice",
        include_mermaid: true,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.mermaid).toBeDefined();
      expect(data.mermaid).toContain("graph LR");
    });

    it("does not leak entity_names into JSON response", async () => {
      const result = await handleRecallConnections(deps, {
        identifier: "RT_Alice",
        depth: 1,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.entity_names).toBeUndefined();
    });

    it("filters by relationship type", async () => {
      const result = await handleRecallConnections(deps, {
        identifier: "RT_Alice",
        relationship_types: ["COLLABORATES_WITH"],
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      // Should only find Bob via COLLABORATES_WITH
      const relTypes = data.relationships.map(
        (r: { type: string }) => r.type
      );
      for (const t of relTypes) {
        expect(t).toBe("COLLABORATES_WITH");
      }
    });

    it("returns error for missing identifier", async () => {
      const result = await handleRecallConnections(deps, {
        identifier: "",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("handleRecallContext", () => {
    it("returns entity, connections, and facts", async () => {
      const result = await handleRecallContext(deps, {
        identifier: "RT_Alice",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.entity.name).toBe("RT_Alice");
      expect(data.connections).toBeDefined();
      expect(data.facts).toBeDefined();
      expect(data.entity.properties.id).toBeUndefined();
      expect(data.connections.anchor.properties.id).toBeUndefined();
      expect(data.connections.entities[0].properties.id).toBeUndefined();
    });

    it("returns connections with flat relationship format", async () => {
      const result = await handleRecallContext(deps, {
        identifier: "RT_Alice",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.connections.relationships.length).toBeGreaterThan(0);

      const rel = data.connections.relationships[0];
      expect(rel.from).toBeDefined();
      expect(rel.to).toBeDefined();
      expect(rel.type).toBeDefined();
      expect(rel.from_id).toBeUndefined();
      expect(rel.to_id).toBeUndefined();
      expect(rel.id).toBeUndefined();
    });

    it("does not leak entity_names into JSON response", async () => {
      const result = await handleRecallContext(deps, {
        identifier: "RT_Alice",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.connections.entity_names).toBeUndefined();
    });

    it("returns only entity and facts when sections are filtered", async () => {
      const result = await handleRecallContext(deps, {
        identifier: "RT_Alice",
        sections: ["entity", "facts"],
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.entity.name).toBe("RT_Alice");
      expect(data.facts).toBeDefined();
      expect(data.connections).toBeUndefined();
    });

    it("returns only entity and connections when sections are filtered", async () => {
      const result = await handleRecallContext(deps, {
        identifier: "RT_Alice",
        sections: ["entity", "connections"],
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.entity.name).toBe("RT_Alice");
      expect(data.connections).toBeDefined();
      expect(data.facts).toBeUndefined();
    });

    it("includes mermaid when requested", async () => {
      const result = await handleRecallContext(deps, {
        identifier: "RT_Alice",
        include_mermaid: true,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.mermaid).toContain("graph LR");
    });

    it("returns error for invalid section", async () => {
      const result = await handleRecallContext(deps, {
        identifier: "RT_Alice",
        sections: ["entity", "invalid"],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Invalid section: "invalid"');
    });

    it("returns error for empty sections", async () => {
      const result = await handleRecallContext(deps, {
        identifier: "RT_Alice",
        sections: [],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("At least one section required");
    });

    it("returns error for missing identifier", async () => {
      const result = await handleRecallContext(deps, { identifier: "" });
      expect(result.isError).toBe(true);
    });
  });

  describe("handleRecallTimeline", () => {
    it("returns the 5 most recent timeline events by default", async () => {
      const result = await handleRecallTimeline(deps, {
        identifier: "RT_Alice",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.entity_name).toBe("RT_Alice");
      expect(data.events).toBeDefined();
      expect(data.events.length).toBe(5);
      expect(data.showing).toBe(5);
      expect(data.total_events).toBeGreaterThan(5);

      for (let index = 1; index < data.events.length; index += 1) {
        expect(data.events[index - 1].timestamp >= data.events[index].timestamp).toBe(true);
      }
    });

    it("returns the requested last_n event count", async () => {
      const result = await handleRecallTimeline(deps, {
        identifier: "RT_Alice",
        last_n: 2,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.events.length).toBe(2);
      expect(data.showing).toBe(2);
      expect(data.total_events).toBeGreaterThan(2);
    });

    it("clamps non-positive last_n to 1", async () => {
      const result = await handleRecallTimeline(deps, {
        identifier: "RT_Alice",
        last_n: 0,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.events.length).toBe(1);
      expect(data.showing).toBe(1);
    });

    it("returns error for missing identifier", async () => {
      const result = await handleRecallTimeline(deps, { identifier: "" });
      expect(result.isError).toBe(true);
    });
  });

  describe("handleFindContradictions", () => {
    it("returns facts for contradiction analysis", async () => {
      const result = await handleFindContradictions(deps, {
        identifier: "RT_Alice",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.entity_name).toBe("RT_Alice");
      expect(data.facts).toBeDefined();
    });

    it("returns error for missing identifier", async () => {
      const result = await handleFindContradictions(deps, {
        identifier: "",
      });
      expect(result.isError).toBe(true);
    });
  });

  describe("handleSearchEntities", () => {
    it("searches entities by name", async () => {
      const result = await handleSearchEntities(deps, {
        query: "RT_Alice",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBeGreaterThan(0);
      expect(data.results[0].name).toBe("RT_Alice");
      expect(data.results[0].properties.id).toBeUndefined();
    });

    it("filters by entity type", async () => {
      const result = await handleSearchEntities(deps, {
        query: "RT_",
        type_filter: "Project",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      for (const r of data.results) {
        expect(r.type).toBe("Project");
      }
    });

    it("returns empty results for no match", async () => {
      const result = await handleSearchEntities(deps, {
        query: "ZZZZZZNOTFOUND",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(0);
    });

    it("returns error for missing query", async () => {
      const result = await handleSearchEntities(deps, { query: "" });
      expect(result.isError).toBe(true);
    });

    it("clamps limit to config max_limit", async () => {
      const limitedDeps: ToolDeps = {
        ...deps,
        config: {
          ...deps.config,
          query_limits: {
            ...deps.config.query_limits,
            max_limit: 2,
          },
        },
      };

      const result = await handleSearchEntities(limitedDeps, {
        query: "RT_",
        limit: 999,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.results.length).toBe(2);
    });

    it("returns only exact matches when exact flag is true", async () => {
      const result = await handleSearchEntities(deps, {
        query: "RT_Alice",
        exact: true,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(1);
      expect(data.results[0].name).toBe("RT_Alice");
    });

    it("returns empty results for non-exact partial match with exact flag", async () => {
      const result = await handleSearchEntities(deps, {
        query: "RT_A",
        exact: true,
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(0);
    });
  });

  describe("handleListEntities", () => {
    it("lists entities of a specific type", async () => {
      const result = await handleListEntities(deps, {
        type_filter: "Person",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBeGreaterThanOrEqual(2);
      for (const e of data.entities) {
        expect(e.type).toBe("Person");
        expect(e.id).toBeDefined();
        expect(e.name).toBeDefined();
        expect(e.created_at).toBeDefined();
      }
      // Verify ordered by name
      for (let i = 1; i < data.entities.length; i++) {
        expect(data.entities[i - 1].name.localeCompare(data.entities[i].name)).toBeLessThanOrEqual(0);
      }
    });

    it("lists all entities when no type filter", async () => {
      const result = await handleListEntities(deps, {});
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      // Should include both Person and Project entities
      const types = new Set(data.entities.map((e: { type: string }) => e.type));
      expect(types.size).toBeGreaterThan(1);
    });

    it("respects limit parameter", async () => {
      const result = await handleListEntities(deps, { limit: 2 });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.count).toBe(2);
      expect(data.entities.length).toBe(2);
    });

    it("returns empty results for type with no entities", async () => {
      const result = await handleListEntities(deps, {
        type_filter: "Decision",
      });
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.entities).toEqual([]);
      expect(data.count).toBe(0);
    });
  });

  describe("handleExportGraph", () => {
    it("exports all sections as JSONL", async () => {
      const result = await handleExportGraph(deps, {});
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      // Should not be empty — we have seeded data
      expect(text.length).toBeGreaterThan(0);

      // Parse each line as JSON
      const lines = text.split("\n").filter(l => l.length > 0);
      expect(lines.length).toBeGreaterThan(0);

      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(["entities", "relationships", "facts"]).toContain(parsed.section);
        expect(parsed.data).toBeDefined();
      }

      // Should have entity lines
      const entityLines = lines.filter(l => JSON.parse(l).section === "entities");
      expect(entityLines.length).toBeGreaterThan(0);
    });

    it("filters to requested sections", async () => {
      const result = await handleExportGraph(deps, {
        sections: ["entities"],
      });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      const lines = text.split("\n").filter(l => l.length > 0);

      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed.section).toBe("entities");
      }
    });

    it("returns empty output for empty graph sections", async () => {
      // Facts section should be mostly empty in this test graph (only 1 fact seeded)
      const result = await handleExportGraph(deps, {
        sections: ["facts"],
      });
      expect(result.isError).toBeUndefined();
      // May have 1 fact from the seeded data, or possibly 0
      // Either way, should not error
    });

    it("returns raw text, not JSON-wrapped", async () => {
      const result = await handleExportGraph(deps, {
        sections: ["entities"],
      });
      expect(result.isError).toBeUndefined();
      const text = result.content[0].text;
      // Should NOT be a JSON string wrapper. Each line should parse individually.
      // If it were JSON-wrapped, JSON.parse(text) would return a string, not throw on first attempt.
      const firstLine = text.split("\n")[0];
      const parsed = JSON.parse(firstLine);
      expect(typeof parsed).toBe("object");
      expect(parsed.section).toBe("entities");
    });

    it("returns error for invalid section", async () => {
      const result = await handleExportGraph(deps, {
        sections: ["invalid"],
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Invalid section");
    });
  });

  describe("handleGraphStats", () => {
    it("returns graph statistics", async () => {
      const result = await handleGraphStats(deps);
      expect(result.isError).toBeUndefined();
      const data = JSON.parse(result.content[0].text);
      expect(data.healthy).toBe(true);
      expect(data.total_entities).toBeGreaterThan(0);
      expect(data.entities_by_type).toBeDefined();
      expect(data.relationships_by_type).toBeDefined();
      expect(data.schema_preset).toBe("dev-team");
    });
  });
});
