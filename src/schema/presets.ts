import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface EntityTypeDefinition {
  name: string;
  properties: string[];
  extraction_hint: string;
  examples: string[];
}

export interface SchemaPreset {
  name: string;
  description: string;
  entity_types: EntityTypeDefinition[];
  relationship_types: string[];
}

const VALID_PRESETS = ["dev-team", "executive-assistant", "coding-agent"] as const;
export type PresetName = (typeof VALID_PRESETS)[number];

/**
 * Resolve the presets directory. Works both in source (src/) and compiled (dist/) layouts.
 */
function getPresetsDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = dirname(thisFile);

  // In compiled layout: dist/schema/presets.js → ../../presets/
  // In source layout:   src/schema/presets.ts → ../../presets/
  return resolve(thisDir, "..", "..", "presets");
}

/**
 * Load a schema preset by name.
 *
 * @throws Error if the preset name is invalid or the file cannot be read.
 */
export function loadPresetFromFile(name: string): SchemaPreset {
  if (!VALID_PRESETS.includes(name as PresetName)) {
    throw new Error(
      `Unknown schema preset: "${name}". Valid presets: ${VALID_PRESETS.join(", ")}`,
    );
  }

  const presetsDir = getPresetsDir();
  const filePath = resolve(presetsDir, `${name}.json`);

  try {
    const raw = readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as SchemaPreset;
  } catch (err) {
    throw new Error(
      `Failed to load preset "${name}" from ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Get the list of valid preset names.
 */
export function getValidPresetNames(): readonly string[] {
  return VALID_PRESETS;
}
