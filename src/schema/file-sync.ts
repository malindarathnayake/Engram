/**
 * MEMORY_SCHEMA.md file sync.
 *
 * The schema file is the canonical source for relationship types, extraction hints,
 * and examples. AGE labels store entity type names. This module syncs between them.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { EntityTypeDefinition, SchemaPreset } from "./presets.js";

/**
 * Generate MEMORY_SCHEMA.md content from a schema preset.
 */
export function generateSchemaMarkdown(preset: SchemaPreset): string {
  const lines: string[] = [
    "# Memory Schema",
    "",
    `> Preset: **${preset.name}** — ${preset.description}`,
    ">",
    "> This file is the canonical source for schema metadata.",
    "> Entity type names are also stored as AGE labels in the graph database.",
    "",
    "## Entity Types",
    "",
  ];

  for (const entityType of preset.entity_types) {
    lines.push(`### ${entityType.name}`);
    lines.push("");
    lines.push(`- **Properties:** ${entityType.properties.join(", ")}`);
    lines.push(`- **Extraction hint:** ${entityType.extraction_hint}`);
    lines.push(`- **Examples:**`);
    for (const example of entityType.examples) {
      lines.push(`  - ${example}`);
    }
    lines.push("");
  }

  lines.push("## Relationship Types");
  lines.push("");
  for (const relType of preset.relationship_types) {
    lines.push(`- \`${relType}\``);
  }
  lines.push("");

  return lines.join("\n");
}

/**
 * Write MEMORY_SCHEMA.md to a file path.
 */
export function writeSchemaFile(filePath: string, preset: SchemaPreset): void {
  const content = generateSchemaMarkdown(preset);
  writeFileSync(filePath, content, "utf-8");
}

/**
 * Read and parse MEMORY_SCHEMA.md from a file path.
 * Returns the entity type names and relationship types found in the file.
 */
export function readSchemaFile(filePath: string): {
  entityTypes: string[];
  relationshipTypes: string[];
} | null {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, "utf-8");
  return parseSchemaMarkdown(content);
}

/**
 * Parse MEMORY_SCHEMA.md content into entity type names and relationship types.
 */
export function parseSchemaMarkdown(content: string): {
  entityTypes: string[];
  relationshipTypes: string[];
} {
  const entityTypes: string[] = [];
  const relationshipTypes: string[] = [];

  let inEntityTypes = false;
  let inRelationshipTypes = false;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "## Entity Types") {
      inEntityTypes = true;
      inRelationshipTypes = false;
      continue;
    }
    if (trimmed === "## Relationship Types") {
      inEntityTypes = false;
      inRelationshipTypes = true;
      continue;
    }
    if (trimmed.startsWith("## ") && trimmed !== "## Entity Types" && trimmed !== "## Relationship Types") {
      inEntityTypes = false;
      inRelationshipTypes = false;
      continue;
    }

    if (inEntityTypes && trimmed.startsWith("### ")) {
      entityTypes.push(trimmed.slice(4).trim());
    }

    if (inRelationshipTypes && trimmed.startsWith("- `")) {
      const match = trimmed.match(/^- `(.+?)`/);
      if (match) {
        relationshipTypes.push(match[1]);
      }
    }
  }

  return { entityTypes, relationshipTypes };
}

/**
 * Reconcile schema file with current schema state.
 * Returns types that exist in AGE but not in the file, and vice versa.
 */
export function reconcileSchema(
  fileTypes: string[],
  ageTypes: string[],
): {
  onlyInFile: string[];
  onlyInAge: string[];
  common: string[];
} {
  const fileSet = new Set(fileTypes);
  const ageSet = new Set(ageTypes);

  const onlyInFile: string[] = [];
  const onlyInAge: string[] = [];
  const common: string[] = [];

  for (const t of fileTypes) {
    if (ageSet.has(t)) {
      common.push(t);
    } else {
      onlyInFile.push(t);
    }
  }

  for (const t of ageTypes) {
    if (!fileSet.has(t)) {
      onlyInAge.push(t);
    }
  }

  return { onlyInFile, onlyInAge, common };
}
