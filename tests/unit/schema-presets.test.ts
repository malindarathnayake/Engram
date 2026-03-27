import { describe, it, expect } from "vitest";
import { loadPresetFromFile, getValidPresetNames } from "../../src/schema/presets.js";
import { SchemaManager } from "../../src/schema/manager.js";

describe("presets", () => {
  it("lists valid preset names", () => {
    const names = getValidPresetNames();
    expect(names).toContain("dev-team");
    expect(names).toContain("executive-assistant");
    expect(names).toContain("coding-agent");
  });

  it("rejects unknown preset name", () => {
    expect(() => loadPresetFromFile("unknown")).toThrow(
      'Unknown schema preset: "unknown"',
    );
  });

  describe("dev-team preset", () => {
    it("loads successfully", () => {
      const preset = loadPresetFromFile("dev-team");
      expect(preset.name).toBe("dev-team");
      expect(preset.entity_types.length).toBeGreaterThan(0);
      expect(preset.relationship_types.length).toBeGreaterThan(0);
    });

    it("includes Fact entity type", () => {
      const preset = loadPresetFromFile("dev-team");
      const factType = preset.entity_types.find((t) => t.name === "Fact");
      expect(factType).toBeDefined();
      expect(factType!.examples.length).toBeGreaterThanOrEqual(3);
    });

    it("includes SUPERSEDED_BY relationship type", () => {
      const preset = loadPresetFromFile("dev-team");
      expect(preset.relationship_types).toContain("SUPERSEDED_BY");
    });

    it("includes expected entity types", () => {
      const preset = loadPresetFromFile("dev-team");
      const names = preset.entity_types.map((t) => t.name);
      expect(names).toContain("Person");
      expect(names).toContain("Project");
      expect(names).toContain("Decision");
      expect(names).toContain("Repository");
      expect(names).toContain("Bug");
      expect(names).toContain("Pattern");
    });
  });

  describe("executive-assistant preset", () => {
    it("loads successfully", () => {
      const preset = loadPresetFromFile("executive-assistant");
      expect(preset.name).toBe("executive-assistant");
    });

    it("includes Action entity type", () => {
      const preset = loadPresetFromFile("executive-assistant");
      const names = preset.entity_types.map((t) => t.name);
      expect(names).toContain("Action");
    });

    it("includes Fact and SUPERSEDED_BY", () => {
      const preset = loadPresetFromFile("executive-assistant");
      expect(preset.entity_types.map((t) => t.name)).toContain("Fact");
      expect(preset.relationship_types).toContain("SUPERSEDED_BY");
    });
  });

  describe("coding-agent preset", () => {
    it("loads successfully", () => {
      const preset = loadPresetFromFile("coding-agent");
      expect(preset.name).toBe("coding-agent");
    });

    it("includes code-specific entity types", () => {
      const preset = loadPresetFromFile("coding-agent");
      const names = preset.entity_types.map((t) => t.name);
      expect(names).toContain("Repository");
      expect(names).toContain("File");
      expect(names).toContain("Function");
      expect(names).toContain("Dependency");
    });

    it("includes Fact and SUPERSEDED_BY", () => {
      const preset = loadPresetFromFile("coding-agent");
      expect(preset.entity_types.map((t) => t.name)).toContain("Fact");
      expect(preset.relationship_types).toContain("SUPERSEDED_BY");
    });
  });
});

describe("SchemaManager", () => {
  describe("fromPreset", () => {
    it("creates manager from dev-team preset", () => {
      const manager = SchemaManager.fromPreset("dev-team");
      expect(manager.getEntityTypeCount()).toBeGreaterThan(0);
    });

    it("throws for unknown preset", () => {
      expect(() => SchemaManager.fromPreset("nonexistent")).toThrow();
    });
  });

  describe("type validation", () => {
    const manager = SchemaManager.fromPreset("dev-team");

    it("validates known entity types", () => {
      expect(manager.isValidEntityType("Person")).toBe(true);
      expect(manager.isValidEntityType("Project")).toBe(true);
      expect(manager.isValidEntityType("Fact")).toBe(true);
    });

    it("rejects unknown entity types", () => {
      expect(manager.isValidEntityType("Unknown")).toBe(false);
      expect(manager.isValidEntityType("")).toBe(false);
      expect(manager.isValidEntityType("person")).toBe(false); // case-sensitive
    });

    it("validates known relationship types", () => {
      expect(manager.isValidRelationshipType("WORKS_AT")).toBe(true);
      expect(manager.isValidRelationshipType("SUPERSEDED_BY")).toBe(true);
    });

    it("rejects unknown relationship types", () => {
      expect(manager.isValidRelationshipType("UNKNOWN")).toBe(false);
      expect(manager.isValidRelationshipType("works_at")).toBe(false); // case-sensitive
    });
  });

  describe("getSchema", () => {
    it("returns full schema with preset name", () => {
      const manager = SchemaManager.fromPreset("dev-team");
      const schema = manager.getSchema();

      expect(schema.preset_name).toBe("dev-team");
      expect(schema.entity_types.length).toBeGreaterThan(0);
      expect(schema.relationship_types.length).toBeGreaterThan(0);
    });

    it("returns defensive copies", () => {
      const manager = SchemaManager.fromPreset("dev-team");
      const schema1 = manager.getSchema();
      const schema2 = manager.getSchema();

      // Should be equal but not the same reference
      expect(schema1.entity_types).toEqual(schema2.entity_types);
      expect(schema1.entity_types).not.toBe(schema2.entity_types);
    });
  });

  describe("getEntityType", () => {
    const manager = SchemaManager.fromPreset("dev-team");

    it("returns entity type definition", () => {
      const person = manager.getEntityType("Person");
      expect(person).toBeDefined();
      expect(person!.name).toBe("Person");
      expect(person!.extraction_hint).toBeTruthy();
      expect(person!.examples.length).toBeGreaterThanOrEqual(3);
    });

    it("returns undefined for unknown type", () => {
      expect(manager.getEntityType("Unknown")).toBeUndefined();
    });
  });

  describe("all presets have required structure", () => {
    for (const presetName of getValidPresetNames()) {
      it(`${presetName}: all entity types have 3+ examples`, () => {
        const manager = SchemaManager.fromPreset(presetName);
        const schema = manager.getSchema();

        for (const entityType of schema.entity_types) {
          expect(
            entityType.examples.length,
            `${presetName}/${entityType.name} has fewer than 3 examples`,
          ).toBeGreaterThanOrEqual(3);
        }
      });

      it(`${presetName}: all entity types have extraction_hint`, () => {
        const manager = SchemaManager.fromPreset(presetName);
        const schema = manager.getSchema();

        for (const entityType of schema.entity_types) {
          expect(
            entityType.extraction_hint,
            `${presetName}/${entityType.name} missing extraction_hint`,
          ).toBeTruthy();
        }
      });

      it(`${presetName}: includes Fact type and SUPERSEDED_BY`, () => {
        const manager = SchemaManager.fromPreset(presetName);
        expect(manager.isValidEntityType("Fact")).toBe(true);
        expect(manager.isValidRelationshipType("SUPERSEDED_BY")).toBe(true);
      });
    }
  });
});
