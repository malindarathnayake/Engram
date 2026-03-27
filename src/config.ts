import { z } from "zod";

/**
 * Engram configuration schema.
 *
 * Config is resolved in order: defaults → .engram.json → environment variables.
 * Environment variables take precedence over file config.
 */

export const EngramConfigSchema = z.object({
  mode: z.enum(["bundled", "external"]).default("bundled"),
  schema_preset: z.string().default("dev-team"),
  external: z
    .object({
      host: z.string().default(""),
      port: z.coerce.number().int().min(1).max(65535).default(5432),
      database: z.string().default("agent_memory"),
      graph_name: z.string().min(1).max(31).default("engram"),
      ssl: z.boolean().default(true),
      username: z.string().default(""),
      password: z.string().default(""),
    })
    .default({}),
  guardrails: z
    .object({
      max_entity_types: z.coerce.number().int().min(1).max(50).default(15),
      similarity_threshold: z.coerce.number().min(0).max(1).default(0.7),
      min_examples_per_type: z.coerce.number().int().min(0).max(20).default(3),
      min_confidence_to_store: z.coerce.number().min(0).max(1).default(0.6),
    })
    .default({}),
  query_limits: z
    .object({
      max_depth: z.coerce.number().int().min(1).max(10).default(3),
      default_limit: z.coerce.number().int().min(1).max(1000).default(50),
      max_limit: z.coerce.number().int().min(1).max(10000).default(200),
      mermaid_max_nodes: z.coerce.number().int().min(1).max(500).default(30),
      query_timeout_ms: z.coerce
        .number()
        .int()
        .min(100)
        .max(60_000)
        .default(5000),
    })
    .default({}),
});

export type EngramConfig = z.infer<typeof EngramConfigSchema>;

/** Environment variable mappings → config paths */
const ENV_MAP: Record<string, (config: Record<string, unknown>) => void> = {
  ENGRAM_MODE: (c) => {
    c.mode = process.env.ENGRAM_MODE;
  },
  ENGRAM_SCHEMA_PRESET: (c) => {
    c.schema_preset = process.env.ENGRAM_SCHEMA_PRESET;
  },
  ENGRAM_EXTERNAL_HOST: (c) => {
    ensureExternal(c);
    (c.external as Record<string, unknown>).host =
      process.env.ENGRAM_EXTERNAL_HOST;
  },
  ENGRAM_EXTERNAL_PORT: (c) => {
    ensureExternal(c);
    (c.external as Record<string, unknown>).port =
      process.env.ENGRAM_EXTERNAL_PORT;
  },
  ENGRAM_EXTERNAL_DATABASE: (c) => {
    ensureExternal(c);
    (c.external as Record<string, unknown>).database =
      process.env.ENGRAM_EXTERNAL_DATABASE;
  },
  ENGRAM_GRAPH_NAME: (c) => {
    ensureExternal(c);
    (c.external as Record<string, unknown>).graph_name =
      process.env.ENGRAM_GRAPH_NAME;
  },
  ENGRAM_EXTERNAL_SSL: (c) => {
    ensureExternal(c);
    (c.external as Record<string, unknown>).ssl =
      process.env.ENGRAM_EXTERNAL_SSL === "true";
  },
  ENGRAM_EXTERNAL_USERNAME: (c) => {
    ensureExternal(c);
    (c.external as Record<string, unknown>).username =
      process.env.ENGRAM_EXTERNAL_USERNAME;
  },
  ENGRAM_EXTERNAL_PASSWORD: (c) => {
    ensureExternal(c);
    (c.external as Record<string, unknown>).password =
      process.env.ENGRAM_EXTERNAL_PASSWORD;
  },
  ENGRAM_DB_PASSWORD: (c) => {
    ensureExternal(c);
    (c.external as Record<string, unknown>).password =
      process.env.ENGRAM_DB_PASSWORD;
  },
  ENGRAM_MAX_ENTITY_TYPES: (c) => {
    ensureGuardrails(c);
    (c.guardrails as Record<string, unknown>).max_entity_types =
      process.env.ENGRAM_MAX_ENTITY_TYPES;
  },
  ENGRAM_SIMILARITY_THRESHOLD: (c) => {
    ensureGuardrails(c);
    (c.guardrails as Record<string, unknown>).similarity_threshold =
      process.env.ENGRAM_SIMILARITY_THRESHOLD;
  },
  ENGRAM_QUERY_TIMEOUT_MS: (c) => {
    ensureQueryLimits(c);
    (c.query_limits as Record<string, unknown>).query_timeout_ms =
      process.env.ENGRAM_QUERY_TIMEOUT_MS;
  },
  ENGRAM_MAX_DEPTH: (c) => {
    ensureQueryLimits(c);
    (c.query_limits as Record<string, unknown>).max_depth =
      process.env.ENGRAM_MAX_DEPTH;
  },
  ENGRAM_DEFAULT_LIMIT: (c) => {
    ensureQueryLimits(c);
    (c.query_limits as Record<string, unknown>).default_limit =
      process.env.ENGRAM_DEFAULT_LIMIT;
  },
  ENGRAM_MAX_LIMIT: (c) => {
    ensureQueryLimits(c);
    (c.query_limits as Record<string, unknown>).max_limit =
      process.env.ENGRAM_MAX_LIMIT;
  },
};

function ensureExternal(c: Record<string, unknown>): void {
  if (!c.external) c.external = {};
}

function ensureGuardrails(c: Record<string, unknown>): void {
  if (!c.guardrails) c.guardrails = {};
}

function ensureQueryLimits(c: Record<string, unknown>): void {
  if (!c.query_limits) c.query_limits = {};
}

/**
 * Load Engram config from optional base config + environment variable overrides.
 * Returns a validated, fully-defaulted config object.
 */
export function loadConfig(
  base: Record<string, unknown> = {},
): EngramConfig {
  const merged: Record<string, unknown> = structuredClone(base);

  // Apply environment variable overrides
  for (const [envVar, apply] of Object.entries(ENV_MAP)) {
    if (process.env[envVar] !== undefined) {
      apply(merged);
    }
  }

  return EngramConfigSchema.parse(merged);
}

/**
 * Get the effective database connection string based on config mode.
 */
export function getConnectionString(config: EngramConfig): string {
  const { external } = config;

  if (config.mode === "bundled") {
    // Bundled mode: connect to sidecar container at memory-db:5432
    const password = external.password || "engram";
    return `postgresql://postgres:${encodeURIComponent(password)}@memory-db:5432/${external.database}`;
  }

  // External mode: use full external config
  if (!external.host) {
    throw new Error(
      "ENGRAM_EXTERNAL_HOST is required when mode is 'external'",
    );
  }
  if (!external.password) {
    throw new Error(
      "ENGRAM_EXTERNAL_PASSWORD or ENGRAM_DB_PASSWORD is required",
    );
  }

  const userInfo = external.username
    ? `${encodeURIComponent(external.username)}:${encodeURIComponent(external.password)}`
    : `postgres:${encodeURIComponent(external.password)}`;

  const sslParam = external.ssl ? "?sslmode=require" : "";
  return `postgresql://${userInfo}@${external.host}:${external.port}/${external.database}${sslParam}`;
}
