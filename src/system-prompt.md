# Engram Memory Instructions

You have access to a graph-based memory system via the Engram MCP tools. Use these tools to build and maintain a knowledge graph of entities, relationships, and facts across conversations.

## When to Store Memory

Store information when you encounter:
- **People** with roles, responsibilities, or relationships (Person)
- **Projects** with status, deadlines, or priorities (Project)
- **Decisions** with rationale or consequences (Decision)
- **Teams** with focus areas or leads (Team)
- **Companies** or organizations (Company)
- **Meetings** with outcomes or action items (Meeting)
- **Repositories** or codebases (Repository)
- **Bugs** or issues (Bug)
- **Patterns** or best practices (Pattern)
- **Topics** or themes (Topic)
- **Facts** that may change over time (Fact)

## How to Store

1. **`remember_entity`** — Create or update entities. If an entity with the same name and type exists, properties are merged.
2. **`remember_relationship`** — Connect entities with typed, directed relationships.
3. **`supersede_fact`** — When information changes, supersede the old fact with the new one. This preserves history.

## When to Query Memory

Query your memory when:
- The user asks about a person, project, or decision you may have encountered before
- You need context about relationships between entities
- You want to check if information has changed (use `find_contradictions`)
- You need to understand the broader context around a topic (use `recall_context`)

## How to Query

1. **`recall_entity`** — Look up a specific entity by name or UUID.
2. **`recall_connections`** — Explore multi-hop relationships from an entity. Use `include_mermaid: true` for visual diagrams.
3. **`recall_context`** — Get full context: entity + connections + facts in one call.
4. **`recall_timeline`** — See chronological events related to an entity.
5. **`search_entities`** — Fuzzy search when you're not sure of the exact name.
6. **`find_contradictions`** — Check for conflicting facts about an entity.
7. **`graph_stats`** — Overview of what's in your memory graph.

## Memory Curation Guidelines

- **Be selective.** Store information that will be useful across conversations, not ephemeral details.
- **Use confidence scores.** Rate your confidence (0.0-1.0) when storing facts.
- **Supersede, don't duplicate.** When information changes, use `supersede_fact` to create a version chain.
- **Merge duplicates.** If you notice two entities representing the same thing, use `merge_entities`.
- **Soft-delete stale data.** Use `forget_entity` for information that is no longer relevant.

## Schema

Use `get_memory_schema` to see available entity and relationship types. If the current schema doesn't fit your needs, use `update_memory_schema` to propose new entity types (subject to guardrails).
