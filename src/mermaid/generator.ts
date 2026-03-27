/**
 * Mermaid diagram generation from graph traversal results.
 *
 * Converts entities and relationships into Mermaid `graph LR` syntax
 * with type-based node shapes, edge labels, truncation, and special
 * character escaping.
 */

import type { TraversalEntity } from "../graph/traversal.js";
import type { RelationshipResult } from "../graph/relationships.js";

/** Node shape mapping by entity type */
const TYPE_SHAPES: Record<string, { open: string; close: string }> = {
  Person: { open: "(", close: ")" },
  Team: { open: "(", close: ")" },
  Organization: { open: "(", close: ")" },
  Project: { open: "[", close: "]" },
  Repository: { open: "[", close: "]" },
  Codebase: { open: "[", close: "]" },
  Decision: { open: "{", close: "}" },
  Meeting: { open: "[[", close: "]]" },
  Event: { open: "[[", close: "]]" },
  Fact: { open: ">", close: "]" },
  Concept: { open: "{{", close: "}}" },
  Skill: { open: "{{", close: "}}" },
  Technology: { open: "{{", close: "}}" },
};

const DEFAULT_SHAPE = { open: "[", close: "]" };

export interface MermaidInput {
  entities: TraversalEntity[];
  relationships: RelationshipResult[];
  maxNodes?: number;
}

export interface MermaidOutput {
  mermaid: string;
  truncated: boolean;
  node_count: number;
  edge_count: number;
}

/**
 * Escape special characters for Mermaid node labels.
 * Mermaid uses quotes for labels with special chars.
 */
function escapeLabel(text: string): string {
  // Truncate long labels
  const label = text.length > 40 ? text.slice(0, 37) + "..." : text;
  // If label contains special Mermaid chars, wrap in quotes
  if (/["\[\](){}|<>\/\\#&;]/.test(label)) {
    return `"${label.replace(/"/g, "#quot;")}"`;
  }
  return label;
}

/**
 * Create a safe Mermaid node ID from a UUID.
 * Mermaid IDs must start with a letter and contain only alphanumerics/underscores.
 */
function safeId(id: string): string {
  return "n_" + id.replace(/-/g, "_");
}

/**
 * Get the Mermaid shape delimiters for an entity type.
 */
function getShape(type: string): { open: string; close: string } {
  return TYPE_SHAPES[type] ?? DEFAULT_SHAPE;
}

/**
 * Generate a Mermaid diagram from traversal entities and relationships.
 */
export function generateMermaid(input: MermaidInput): MermaidOutput {
  const { entities, relationships, maxNodes = 30 } = input;

  if (entities.length === 0) {
    return {
      mermaid: "graph LR\n  empty[No entities found]",
      truncated: false,
      node_count: 0,
      edge_count: 0,
    };
  }

  const truncated = entities.length > maxNodes;
  const visibleEntities = truncated ? entities.slice(0, maxNodes) : entities;
  const visibleIds = new Set(visibleEntities.map((e) => e.id));

  // Filter relationships to only include edges between visible nodes
  const visibleRelationships = relationships.filter(
    (r) => visibleIds.has(r.from_id) && visibleIds.has(r.to_id)
  );

  const lines: string[] = ["graph LR"];

  // Node definitions
  for (const entity of visibleEntities) {
    const shape = getShape(entity.type);
    const label = escapeLabel(entity.name);
    lines.push(`  ${safeId(entity.id)}${shape.open}${label}${shape.close}`);
  }

  // Edge definitions
  for (const rel of visibleRelationships) {
    const label = escapeLabel(rel.type);
    lines.push(
      `  ${safeId(rel.from_id)} -->|${label}| ${safeId(rel.to_id)}`
    );
  }

  // Truncation comment
  if (truncated) {
    lines.push(
      `  %% Truncated: showing ${maxNodes} of ${entities.length} nodes`
    );
  }

  return {
    mermaid: lines.join("\n"),
    truncated,
    node_count: visibleEntities.length,
    edge_count: visibleRelationships.length,
  };
}
