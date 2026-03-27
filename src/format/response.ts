import type { ToolResult } from "../tools/write-tools.js";
import type { RelationshipResult } from "../graph/relationships.js";

type EntityWithProperties =
  | {
      id?: unknown;
      properties?: Record<string, unknown> | null;
    }
  | null
  | undefined;

const RESERVED_DISPLAY_KEYS = new Set(["type", "from", "to"]);

export function textResult(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
  };
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

export function stripDuplicateId<T extends EntityWithProperties>(entity: T): T {
  if (!entity?.properties || typeof entity.properties !== "object") {
    return entity;
  }

  if (entity.properties.id !== entity.id) {
    return entity;
  }

  const { id: _duplicateId, ...properties } = entity.properties;
  return { ...entity, properties } as T;
}

export function formatRelationship(
  rel: RelationshipResult,
  nameMap: Map<string, string>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    type: rel.type,
    from: nameMap.get(rel.from_id) ?? rel.from_id,
    to: nameMap.get(rel.to_id) ?? rel.to_id,
  };

  // Hoist user properties to top level, skipping internal fields
  if (rel.properties) {
    for (const [key, value] of Object.entries(rel.properties)) {
      // Skip internal/system fields
      if (key === "id" || key === "created_at" || key === "updated_at") {
        continue;
      }
      // Handle legacy collision: user property named same as reserved display key
      const outputKey = RESERVED_DISPLAY_KEYS.has(key) ? `prop_${key}` : key;
      result[outputKey] = value;
    }
  }

  return result;
}

export function rawTextResult(text: string): ToolResult {
  return {
    content: [{ type: "text", text }],
  };
}
