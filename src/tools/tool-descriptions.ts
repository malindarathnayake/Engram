/**
 * Dynamic tool descriptions generated from current schema state.
 *
 * Provides rich descriptions with behavioral guidance and current
 * entity/relationship type lists from the schema manager.
 */

import type { SchemaManager } from "../schema/manager.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function entityTypeList(schema: SchemaManager): string {
  return schema.getEntityTypeNames().join(", ");
}

function relationshipTypeList(schema: SchemaManager): string {
  return schema.getRelationshipTypeNames().join(", ");
}

/**
 * Generate all tool definitions with dynamic descriptions from schema state.
 */
export function getToolDefinitions(schema: SchemaManager): ToolDefinition[] {
  const entityTypes = entityTypeList(schema);
  const relTypes = relationshipTypeList(schema);
  const guardrails = schema.getGuardrails();

  return [
    // Write tools
    {
      name: "remember_entity",
      description: `Create or update an entity in the knowledge graph. If an entity with the same name and type exists, properties are merged (new values overwrite). Current entity types: ${entityTypes}. Confidence must be ${guardrails.min_examples_per_type > 0 ? "0.0-1.0" : "any value"}.`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Entity name" },
          type: {
            type: "string",
            description: `Entity type. Must be one of: ${entityTypes}`,
          },
          properties: {
            type: "object",
            description: "Additional properties (key-value pairs)",
          },
          confidence: {
            type: "number",
            description: "Confidence score 0.0-1.0",
          },
        },
        required: ["name", "type"],
      },
    },
    {
      name: "remember_relationship",
      description: `Create a directed relationship between two entities. Entities can be specified by UUID or name (fuzzy matched). Current relationship types: ${relTypes}.`,
      inputSchema: {
        type: "object",
        properties: {
          from: {
            type: "string",
            description: "Source entity (UUID or name)",
          },
          to: {
            type: "string",
            description: "Target entity (UUID or name)",
          },
          type: {
            type: "string",
            description: `Relationship type. Must be one of: ${relTypes}`,
          },
          properties: {
            type: "object",
            description: "Additional relationship properties",
          },
        },
        required: ["from", "to", "type"],
      },
    },
    {
      name: "supersede_fact",
      description:
        "Record a new fact about an entity that supersedes an old one. Creates a SUPERSEDED_BY chain for fact versioning. Use this when information changes over time.",
      inputSchema: {
        type: "object",
        properties: {
          entity: {
            type: "string",
            description: "Entity UUID or name",
          },
          new_fact: {
            type: "string",
            description: "The new fact content",
          },
          old_fact: {
            type: "string",
            description:
              "The old fact content to supersede (optional — if omitted, creates standalone fact)",
          },
          source: {
            type: "string",
            description: "Source of the fact (e.g., conversation, document)",
          },
          confidence: {
            type: "number",
            description: "Confidence score 0.0-1.0",
          },
        },
        required: ["entity", "new_fact"],
      },
    },
    {
      name: "forget_entity",
      description:
        "Soft-delete an entity. The entity remains in the graph but is excluded from queries. Use this when information is no longer relevant.",
      inputSchema: {
        type: "object",
        properties: {
          identifier: {
            type: "string",
            description: "Entity UUID or name",
          },
        },
        required: ["identifier"],
      },
    },
    {
      name: "merge_entities",
      description:
        "Merge two entities into one. The surviving entity inherits all relationships from the merged entity. The merged entity is soft-deleted. Entities can be specified by UUID or name.",
      inputSchema: {
        type: "object",
        properties: {
          surviving: {
            type: "string",
            description: "Entity UUID or name to keep",
          },
          merged: {
            type: "string",
            description: "Entity UUID or name to merge and soft-delete",
          },
          surviving_id: {
            type: "string",
            description: "(deprecated, use 'surviving') UUID of the entity to keep",
          },
          merged_id: {
            type: "string",
            description: "(deprecated, use 'merged') UUID of the entity to merge and soft-delete",
          },
        },
        required: [],
      },
    },

    {
      name: "remember_knowledge",
      description: `Bulk create or update entities and relationships in one call. Processes entities first (for forward references), then relationships. Entities are matched by name+type. Relationships support entity resolution by name with optional type hints. Current entity types: ${entityTypes}. Current relationship types: ${relTypes}.`,
      inputSchema: {
        type: "object",
        properties: {
          entities: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Entity name" },
                type: { type: "string", description: `Entity type: ${entityTypes}` },
                properties: { type: "object", description: "Additional properties" },
              },
              required: ["name", "type"],
            },
            description: "Entities to create or update",
          },
          relationships: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string", description: "Source entity name or UUID" },
                to: { type: "string", description: "Target entity name or UUID" },
                type: { type: "string", description: `Relationship type: ${relTypes}` },
                properties: { type: "object", description: "Relationship properties" },
                from_type: { type: "string", description: "Source entity type (for disambiguation)" },
                to_type: { type: "string", description: "Target entity type (for disambiguation)" },
              },
              required: ["from", "to", "type"],
            },
            description: "Relationships to create or update (processed after entities)",
          },
        },
      },
    },

    // Read tools
    {
      name: "recall_entity",
      description:
        "Retrieve an entity by name or UUID. Returns entity properties and optionally its relationships. Use fuzzy name matching for natural language lookups.",
      inputSchema: {
        type: "object",
        properties: {
          identifier: {
            type: "string",
            description: "Entity UUID or name (fuzzy matched)",
          },
          include_relationships: {
            type: "boolean",
            description: "Include direct relationships (default: false)",
          },
        },
        required: ["identifier"],
      },
    },
    {
      name: "recall_connections",
      description: `Multi-hop graph traversal from an anchor entity. Discovers connected entities up to N hops deep. Supports relationship type filtering. Current relationship types: ${relTypes}.`,
      inputSchema: {
        type: "object",
        properties: {
          identifier: {
            type: "string",
            description: "Anchor entity UUID or name",
          },
          depth: {
            type: "number",
            description: "Maximum traversal depth (default: from config)",
          },
          limit: {
            type: "number",
            description: "Maximum results (default: from config)",
          },
          relationship_types: {
            type: "array",
            items: { type: "string" },
            description: `Filter to these relationship types: ${relTypes}`,
          },
          include_mermaid: {
            type: "boolean",
            description: "Include Mermaid diagram in response",
          },
        },
        required: ["identifier"],
      },
    },
    {
      name: "recall_context",
      description:
        "Get full context for an entity: its properties, connections, and facts. Combines recall_entity, recall_connections, and fact lookup in one call.",
      inputSchema: {
        type: "object",
        properties: {
          identifier: {
            type: "string",
            description: "Entity UUID or name",
          },
          depth: {
            type: "number",
            description: "Connection traversal depth",
          },
          limit: { type: "number", description: "Maximum connections" },
          sections: {
            type: "array",
            items: {
              type: "string",
              enum: ["entity", "connections", "facts"],
            },
            description:
              "Filter response sections to entity, connections, and/or facts",
          },
          include_mermaid: {
            type: "boolean",
            description: "Include Mermaid diagram",
          },
        },
        required: ["identifier"],
      },
    },
    {
      name: "recall_timeline",
      description:
        "Get a chronological timeline of events related to an entity. Returns facts, relationships, and property changes ordered by timestamp.",
      inputSchema: {
        type: "object",
        properties: {
          identifier: {
            type: "string",
            description: "Entity UUID or name",
          },
          last_n: {
            type: "number",
            description: "Number of most recent events to return (default: 5)",
          },
        },
        required: ["identifier"],
      },
    },
    {
      name: "find_contradictions",
      description:
        "Find potentially contradicting facts about an entity. Returns all active (non-superseded) facts for review. Useful for detecting stale or conflicting information.",
      inputSchema: {
        type: "object",
        properties: {
          identifier: {
            type: "string",
            description: "Entity UUID or name",
          },
        },
        required: ["identifier"],
      },
    },
    {
      name: "search_entities",
      description: `Fuzzy search for entities by name. Case-insensitive, supports partial matches. Filter by entity type. Current entity types: ${entityTypes}.`,
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query (fuzzy matched against entity names)",
          },
          limit: {
            type: "number",
            description: "Maximum results (default: 10)",
          },
          type_filter: {
            type: "string",
            description: `Filter to entity type: ${entityTypes}`,
          },
          exact: {
            type: "boolean",
            description: "Only return exact name matches (default: false)",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "list_entities",
      description: `List all entities in the knowledge graph, optionally filtered by type. Returns id, name, type, created_at ordered by name. Current entity types: ${entityTypes}.`,
      inputSchema: {
        type: "object",
        properties: {
          type_filter: {
            type: "string",
            description: `Filter to entity type: ${entityTypes}`,
          },
          limit: {
            type: "number",
            description: "Maximum results (default: from config)",
          },
        },
      },
    },
    {
      name: "graph_stats",
      description:
        "Get graph statistics: entity and relationship counts by type, schema info, and health status.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "export_graph",
      description: "Export the entire knowledge graph as JSONL (one JSON object per line). Supports section filtering. Uses keyset pagination for large graphs.",
      inputSchema: {
        type: "object",
        properties: {
          sections: {
            type: "array",
            items: {
              type: "string",
              enum: ["entities", "relationships", "facts"],
            },
            description: 'Sections to export (default: all). Options: "entities", "relationships", "facts"',
          },
        },
      },
    },

    // Schema tools
    {
      name: "get_memory_schema",
      description: `View the current memory schema: entity types, relationship types, and guardrails. Current types: ${entityTypes}. Max types: ${guardrails.max_entity_types}.`,
      inputSchema: {
        type: "object",
        properties: {
          compact: {
            type: "boolean",
            description:
              "Return a compact schema response without extraction hints, examples, or extended guardrails",
          },
        },
      },
    },
    {
      name: "update_memory_schema",
      description: `Add a new entity type to the schema. Requires ${guardrails.min_examples_per_type}+ examples. Type names are checked for similarity (threshold: ${guardrails.similarity_threshold}) to prevent duplicates. Max ${guardrails.max_entity_types} types. v1: add-only, no removal.`,
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["add"],
            description: 'Action (v1: only "add" supported)',
          },
          name: {
            type: "string",
            description:
              "New entity type name (PascalCase, e.g., 'CustomerTicket')",
          },
          properties: {
            type: "array",
            items: { type: "string" },
            description: "Property names for this type",
          },
          extraction_hint: {
            type: "string",
            description: "Hint for when to extract this entity type",
          },
          examples: {
            type: "array",
            items: { type: "string" },
            description: `At least ${guardrails.min_examples_per_type} example instances`,
          },
        },
        required: [
          "action",
          "name",
          "properties",
          "extraction_hint",
          "examples",
        ],
      },
    },
  ];
}
