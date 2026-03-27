import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createPool, type EngramPool } from "../../src/db/connection.js";
import { initializeDatabase } from "../../src/db/init.js";
import { loadConfig } from "../../src/config.js";
import { SchemaManager } from "../../src/schema/manager.js";
import {
  generateSchemaMarkdown,
  writeSchemaFile,
  readSchemaFile,
  parseSchemaMarkdown,
  reconcileSchema,
} from "../../src/schema/file-sync.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("file-sync", () => {
  let pool: EngramPool;
  const graphName = "filesync_test";
  let tempDir: string;

  beforeAll(async () => {
    const testDb = process.env.ENGRAM_TEST_DB;
    if (!testDb) throw new Error("ENGRAM_TEST_DB not set");

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
        graph_name: graphName,
      },
    });

    pool = await createPool(config);
    await initializeDatabase(pool);
    tempDir = mkdtempSync(join(tmpdir(), "engram-filesync-"));
  });

  afterAll(async () => {
    if (pool) {
      try {
        await pool.query(`SELECT drop_graph('${graphName}', true)`);
      } catch { /* ignore */ }
      await pool.close();
    }
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true });
    }
  });

  describe("generateSchemaMarkdown", () => {
    it("generates valid markdown from preset", () => {
      const schema = SchemaManager.fromPreset("dev-team");
      const markdown = generateSchemaMarkdown(schema.getPreset());

      expect(markdown).toContain("# Memory Schema");
      expect(markdown).toContain("Preset: **dev-team**");
      expect(markdown).toContain("## Entity Types");
      expect(markdown).toContain("### Person");
      expect(markdown).toContain("### Project");
      expect(markdown).toContain("## Relationship Types");
      expect(markdown).toContain("`WORKS_AT`");
      expect(markdown).toContain("`REPORTS_TO`");
    });

    it("includes properties and hints", () => {
      const schema = SchemaManager.fromPreset("dev-team");
      const markdown = generateSchemaMarkdown(schema.getPreset());

      expect(markdown).toContain("**Properties:**");
      expect(markdown).toContain("**Extraction hint:**");
      expect(markdown).toContain("**Examples:**");
    });
  });

  describe("writeSchemaFile + readSchemaFile", () => {
    it("roundtrips schema file", () => {
      const schema = SchemaManager.fromPreset("dev-team");
      const filePath = join(tempDir, "MEMORY_SCHEMA.md");

      writeSchemaFile(filePath, schema.getPreset());
      const result = readSchemaFile(filePath);

      expect(result).not.toBeNull();
      expect(result!.entityTypes).toContain("Person");
      expect(result!.entityTypes).toContain("Project");
      expect(result!.entityTypes).toContain("Decision");
      expect(result!.relationshipTypes).toContain("WORKS_AT");
      expect(result!.relationshipTypes).toContain("REPORTS_TO");
    });

    it("returns null for non-existent file", () => {
      const result = readSchemaFile(join(tempDir, "nonexistent.md"));
      expect(result).toBeNull();
    });

    it("preserves all entity types", () => {
      const schema = SchemaManager.fromPreset("dev-team");
      const filePath = join(tempDir, "MEMORY_SCHEMA_full.md");

      writeSchemaFile(filePath, schema.getPreset());
      const result = readSchemaFile(filePath);

      const expected = schema.getEntityTypeNames();
      expect(result!.entityTypes.sort()).toEqual(expected.sort());
    });

    it("preserves all relationship types", () => {
      const schema = SchemaManager.fromPreset("dev-team");
      const filePath = join(tempDir, "MEMORY_SCHEMA_rels.md");

      writeSchemaFile(filePath, schema.getPreset());
      const result = readSchemaFile(filePath);

      const expected = schema.getRelationshipTypeNames();
      expect(result!.relationshipTypes.sort()).toEqual(expected.sort());
    });
  });

  describe("parseSchemaMarkdown", () => {
    it("parses entity types from markdown", () => {
      const markdown = `# Memory Schema

## Entity Types

### Person

- **Properties:** name, role
- **Extraction hint:** People
- **Examples:**
  - Alice is a person

### Project

- **Properties:** name, status
- **Extraction hint:** Projects
- **Examples:**
  - Project X

## Relationship Types

- \`WORKS_AT\`
- \`OWNS\`
`;

      const result = parseSchemaMarkdown(markdown);
      expect(result.entityTypes).toEqual(["Person", "Project"]);
      expect(result.relationshipTypes).toEqual(["WORKS_AT", "OWNS"]);
    });

    it("handles empty markdown", () => {
      const result = parseSchemaMarkdown("");
      expect(result.entityTypes).toEqual([]);
      expect(result.relationshipTypes).toEqual([]);
    });
  });

  describe("reconcileSchema", () => {
    it("identifies types only in file", () => {
      const result = reconcileSchema(
        ["Person", "Project", "Custom"],
        ["Person", "Project"],
      );

      expect(result.onlyInFile).toEqual(["Custom"]);
      expect(result.onlyInAge).toEqual([]);
      expect(result.common.sort()).toEqual(["Person", "Project"]);
    });

    it("identifies types only in AGE", () => {
      const result = reconcileSchema(
        ["Person"],
        ["Person", "Project"],
      );

      expect(result.onlyInFile).toEqual([]);
      expect(result.onlyInAge).toEqual(["Project"]);
    });

    it("handles identical sets", () => {
      const types = ["Person", "Project", "Bug"];
      const result = reconcileSchema(types, types);

      expect(result.onlyInFile).toEqual([]);
      expect(result.onlyInAge).toEqual([]);
      expect(result.common.sort()).toEqual(types.sort());
    });

    it("handles empty sets", () => {
      const result = reconcileSchema([], []);
      expect(result.onlyInFile).toEqual([]);
      expect(result.onlyInAge).toEqual([]);
      expect(result.common).toEqual([]);
    });
  });
});
