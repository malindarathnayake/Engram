import {
  loadPresetFromFile,
  type SchemaPreset,
  type EntityTypeDefinition,
} from "./presets.js";
import { trigramSimilarity, findMostSimilar } from "./similarity.js";
import { validateIdentifier } from "../db/cypher.js";

export interface AddEntityTypeInput {
  name: string;
  properties: string[];
  extraction_hint: string;
  examples: string[];
}

export interface AddEntityTypeResult {
  added: string;
  total_types: number;
}

export interface GuardrailConfig {
  max_entity_types: number;
  similarity_threshold: number;
  min_examples_per_type: number;
}

/**
 * Schema manager with guardrail enforcement.
 *
 * Loads a schema preset and provides type validation.
 * Supports adding new entity types with guardrails (max limit, similarity check, min examples).
 */
export class SchemaManager {
  private preset: SchemaPreset;
  private entityTypeSet: Set<string>;
  private relationshipTypeSet: Set<string>;
  private guardrails: GuardrailConfig;

  constructor(preset: SchemaPreset, guardrails?: Partial<GuardrailConfig>) {
    this.preset = preset;
    this.entityTypeSet = new Set(preset.entity_types.map((t) => t.name));
    this.relationshipTypeSet = new Set(preset.relationship_types);
    this.guardrails = {
      max_entity_types: guardrails?.max_entity_types ?? 15,
      similarity_threshold: guardrails?.similarity_threshold ?? 0.7,
      min_examples_per_type: guardrails?.min_examples_per_type ?? 3,
    };
  }

  /**
   * Create a SchemaManager by loading a named preset.
   */
  static fromPreset(
    presetName: string,
    guardrails?: Partial<GuardrailConfig>,
  ): SchemaManager {
    const preset = loadPresetFromFile(presetName);
    return new SchemaManager(preset, guardrails);
  }

  /**
   * Check if an entity type is valid in the current schema.
   */
  isValidEntityType(type: string): boolean {
    return this.entityTypeSet.has(type);
  }

  /**
   * Check if a relationship type is valid in the current schema.
   */
  isValidRelationshipType(type: string): boolean {
    return this.relationshipTypeSet.has(type);
  }

  /**
   * Get the current schema (entity types, relationship types, preset name).
   */
  getSchema(): {
    preset_name: string;
    entity_types: EntityTypeDefinition[];
    relationship_types: string[];
  } {
    return {
      preset_name: this.preset.name,
      entity_types: [...this.preset.entity_types],
      relationship_types: [...this.preset.relationship_types],
    };
  }

  /**
   * Get entity type names.
   */
  getEntityTypeNames(): string[] {
    return [...this.entityTypeSet];
  }

  /**
   * Get relationship type names.
   */
  getRelationshipTypeNames(): string[] {
    return [...this.relationshipTypeSet];
  }

  /**
   * Get the entity type definition by name.
   */
  getEntityType(name: string): EntityTypeDefinition | undefined {
    return this.preset.entity_types.find((t) => t.name === name);
  }

  /**
   * Get the total count of entity types.
   */
  getEntityTypeCount(): number {
    return this.entityTypeSet.size;
  }

  /**
   * Get the current guardrail configuration.
   */
  getGuardrails(): GuardrailConfig {
    return { ...this.guardrails };
  }

  /**
   * Get the underlying preset (for file sync).
   */
  getPreset(): SchemaPreset {
    return this.preset;
  }

  /**
   * Add a new entity type with guardrail enforcement.
   *
   * Guardrails:
   * 1. Entity type count must be < max_entity_types
   * 2. Name must not be too similar to existing types (Jaccard trigram similarity)
   * 3. Must provide min_examples_per_type examples
   * 4. Name must be a valid AGE identifier
   *
   * @throws Error if any guardrail check fails
   */
  addEntityType(input: AddEntityTypeInput): AddEntityTypeResult {
    // Validate name is a valid AGE identifier
    validateIdentifier(input.name, "entity type name");

    // Check max entity types
    if (this.entityTypeSet.size >= this.guardrails.max_entity_types) {
      throw new Error(
        `Maximum ${this.guardrails.max_entity_types} entity types reached. Cannot add "${input.name}".`,
      );
    }

    // Check for exact duplicate
    if (this.entityTypeSet.has(input.name)) {
      throw new Error(`Entity type "${input.name}" already exists.`);
    }

    // Check similarity against existing type names
    const existingNames = this.getEntityTypeNames();
    const nameMatch = findMostSimilar(input.name, existingNames);
    if (nameMatch && nameMatch.score >= this.guardrails.similarity_threshold) {
      const pct = Math.round(nameMatch.score * 100);
      throw new Error(
        `Type "${input.name}" is ${pct}% similar to existing type "${nameMatch.match}". ` +
          `Use the existing type or choose a more distinct name.`,
      );
    }

    // Check similarity against extraction hints
    const existingHints = this.preset.entity_types.map((t) => t.extraction_hint);
    const hintMatch = findMostSimilar(input.extraction_hint, existingHints);
    if (hintMatch && hintMatch.score >= this.guardrails.similarity_threshold) {
      const matchingType = this.preset.entity_types.find(
        (t) => t.extraction_hint === hintMatch.match,
      );
      const pct = Math.round(hintMatch.score * 100);
      throw new Error(
        `Extraction hint is ${pct}% similar to existing type "${matchingType?.name ?? "unknown"}". ` +
          `Consider using the existing type instead.`,
      );
    }

    // Check minimum examples
    if (input.examples.length < this.guardrails.min_examples_per_type) {
      throw new Error(
        `At least ${this.guardrails.min_examples_per_type} examples required. Got ${input.examples.length}.`,
      );
    }

    // Add the type
    const entityType: EntityTypeDefinition = {
      name: input.name,
      properties: input.properties,
      extraction_hint: input.extraction_hint,
      examples: input.examples,
    };

    this.preset.entity_types.push(entityType);
    this.entityTypeSet.add(input.name);

    return {
      added: input.name,
      total_types: this.entityTypeSet.size,
    };
  }
}
