import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig, getConnectionString, EngramConfigSchema } from "../../src/config.js";

// Snapshot and restore env vars to avoid test pollution
const ENGRAM_ENVS = Object.keys(process.env).filter((k) =>
  k.startsWith("ENGRAM_"),
);

function clearEngramEnvs(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("ENGRAM_")) {
      delete process.env[key];
    }
  }
}

describe("EngramConfigSchema", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save current ENGRAM_ vars
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("ENGRAM_")) {
        savedEnv[key] = process.env[key];
      }
    }
    clearEngramEnvs();
  });

  afterEach(() => {
    // Restore
    clearEngramEnvs();
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val !== undefined) process.env[key] = val;
    }
  });

  describe("defaults", () => {
    it("returns fully-defaulted config with no input", () => {
      const config = loadConfig();

      expect(config.mode).toBe("bundled");
      expect(config.schema_preset).toBe("dev-team");
      expect(config.external.host).toBe("");
      expect(config.external.port).toBe(5432);
      expect(config.external.database).toBe("agent_memory");
      expect(config.external.graph_name).toBe("engram");
      expect(config.external.ssl).toBe(true);
      expect(config.external.username).toBe("");
      expect(config.external.password).toBe("");
      expect(config.guardrails.max_entity_types).toBe(15);
      expect(config.guardrails.similarity_threshold).toBe(0.7);
      expect(config.guardrails.min_examples_per_type).toBe(3);
      expect(config.guardrails.min_confidence_to_store).toBe(0.6);
      expect(config.query_limits.max_depth).toBe(3);
      expect(config.query_limits.default_limit).toBe(50);
      expect(config.query_limits.max_limit).toBe(200);
      expect(config.query_limits.mermaid_max_nodes).toBe(30);
      expect(config.query_limits.query_timeout_ms).toBe(5000);
    });
  });

  describe("base config override", () => {
    it("accepts partial base config", () => {
      const config = loadConfig({
        mode: "external",
        external: { host: "db.example.com", password: "secret" },
      });

      expect(config.mode).toBe("external");
      expect(config.external.host).toBe("db.example.com");
      expect(config.external.password).toBe("secret");
      // Defaults still applied for unset fields
      expect(config.external.port).toBe(5432);
      expect(config.external.graph_name).toBe("engram");
    });

    it("accepts custom graph_name", () => {
      const config = loadConfig({
        external: { graph_name: "my_graph" },
      });

      expect(config.external.graph_name).toBe("my_graph");
    });
  });

  describe("environment variable overrides", () => {
    it("ENGRAM_MODE overrides base", () => {
      process.env.ENGRAM_MODE = "external";
      const config = loadConfig({ mode: "bundled" });

      expect(config.mode).toBe("external");
    });

    it("ENGRAM_SCHEMA_PRESET overrides base", () => {
      process.env.ENGRAM_SCHEMA_PRESET = "coding-agent";
      const config = loadConfig();

      expect(config.schema_preset).toBe("coding-agent");
    });

    it("ENGRAM_EXTERNAL_HOST sets external.host", () => {
      process.env.ENGRAM_EXTERNAL_HOST = "remote-db.example.com";
      const config = loadConfig();

      expect(config.external.host).toBe("remote-db.example.com");
    });

    it("ENGRAM_DB_PASSWORD sets external.password", () => {
      process.env.ENGRAM_DB_PASSWORD = "super-secret";
      const config = loadConfig();

      expect(config.external.password).toBe("super-secret");
    });

    it("ENGRAM_GRAPH_NAME sets external.graph_name", () => {
      process.env.ENGRAM_GRAPH_NAME = "custom_graph";
      const config = loadConfig();

      expect(config.external.graph_name).toBe("custom_graph");
    });

    it("ENGRAM_EXTERNAL_PORT coerces to number", () => {
      process.env.ENGRAM_EXTERNAL_PORT = "5433";
      const config = loadConfig();

      expect(config.external.port).toBe(5433);
    });

    it("ENGRAM_EXTERNAL_SSL parses boolean", () => {
      process.env.ENGRAM_EXTERNAL_SSL = "true";
      const config = loadConfig({ external: { ssl: false } });

      expect(config.external.ssl).toBe(true);
    });

    it("ENGRAM_MAX_DEPTH overrides query_limits", () => {
      process.env.ENGRAM_MAX_DEPTH = "5";
      const config = loadConfig();

      expect(config.query_limits.max_depth).toBe(5);
    });

    it("ENGRAM_QUERY_TIMEOUT_MS overrides query_limits", () => {
      process.env.ENGRAM_QUERY_TIMEOUT_MS = "10000";
      const config = loadConfig();

      expect(config.query_limits.query_timeout_ms).toBe(10000);
    });

    it("env vars override base config (env wins)", () => {
      process.env.ENGRAM_EXTERNAL_HOST = "env-host";
      const config = loadConfig({
        external: { host: "base-host" },
      });

      expect(config.external.host).toBe("env-host");
    });
  });

  describe("validation errors", () => {
    it("rejects invalid mode", () => {
      expect(() => loadConfig({ mode: "invalid" })).toThrow();
    });

    it("rejects port out of range", () => {
      expect(() =>
        loadConfig({ external: { port: 0 } }),
      ).toThrow();
    });

    it("rejects port above 65535", () => {
      expect(() =>
        loadConfig({ external: { port: 70000 } }),
      ).toThrow();
    });

    it("rejects max_depth out of range", () => {
      expect(() =>
        loadConfig({ query_limits: { max_depth: 0 } }),
      ).toThrow();
    });

    it("rejects max_depth above 10", () => {
      expect(() =>
        loadConfig({ query_limits: { max_depth: 11 } }),
      ).toThrow();
    });

    it("rejects similarity_threshold above 1", () => {
      expect(() =>
        loadConfig({ guardrails: { similarity_threshold: 1.5 } }),
      ).toThrow();
    });

    it("rejects negative similarity_threshold", () => {
      expect(() =>
        loadConfig({ guardrails: { similarity_threshold: -0.1 } }),
      ).toThrow();
    });

    it("rejects empty graph_name", () => {
      expect(() =>
        loadConfig({ external: { graph_name: "" } }),
      ).toThrow();
    });
  });
});

describe("getConnectionString", () => {
  it("returns bundled connection string", () => {
    const config = loadConfig();
    config.external.password = "mypass";
    const connStr = getConnectionString(config);

    expect(connStr).toBe(
      "postgresql://postgres:mypass@memory-db:5432/agent_memory",
    );
  });

  it("returns bundled connection string with default password", () => {
    const config = loadConfig();
    const connStr = getConnectionString(config);

    expect(connStr).toBe(
      "postgresql://postgres:engram@memory-db:5432/agent_memory",
    );
  });

  it("encodes special characters in password", () => {
    const config = loadConfig();
    config.external.password = "p@ss/w0rd";
    const connStr = getConnectionString(config);

    expect(connStr).toContain(encodeURIComponent("p@ss/w0rd"));
  });

  it("returns external connection string with SSL", () => {
    const config = loadConfig({
      mode: "external",
      external: {
        host: "db.example.com",
        port: 5433,
        database: "mydb",
        username: "admin",
        password: "secret",
        ssl: true,
      },
    });
    const connStr = getConnectionString(config);

    expect(connStr).toBe(
      "postgresql://admin:secret@db.example.com:5433/mydb?sslmode=require",
    );
  });

  it("returns external connection string without SSL", () => {
    const config = loadConfig({
      mode: "external",
      external: {
        host: "db.example.com",
        password: "secret",
        ssl: false,
      },
    });
    const connStr = getConnectionString(config);

    expect(connStr).toBe(
      "postgresql://postgres:secret@db.example.com:5432/agent_memory",
    );
    expect(connStr).not.toContain("sslmode");
  });

  it("throws when external mode has no host", () => {
    const config = loadConfig({
      mode: "external",
      external: { password: "secret" },
    });

    expect(() => getConnectionString(config)).toThrow(
      "ENGRAM_EXTERNAL_HOST is required",
    );
  });

  it("throws when external mode has no password", () => {
    const config = loadConfig({
      mode: "external",
      external: { host: "db.example.com" },
    });

    expect(() => getConnectionString(config)).toThrow(
      "ENGRAM_EXTERNAL_PASSWORD or ENGRAM_DB_PASSWORD is required",
    );
  });
});
