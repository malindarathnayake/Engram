<p align="center">
  <img src="assets/banner.jpg" alt="Engram — Graph Memory for AI Agents" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/malindarathnayake/engram/actions/workflows/build.yml"><img src="https://github.com/malindarathnayake/engram/actions/workflows/build.yml/badge.svg" alt="Build & Publish" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node.js" /></a>
  <a href="#security-testing"><img src="https://img.shields.io/badge/security%20tests-26%2F26%20passed-brightgreen.svg" alt="Security: 26/26" /></a>
</p>

**Graph-based persistent memory for AI agents, built on [Apache AGE](https://age.apache.org/) and PostgreSQL.**

---

## Why This Exists

Most AI agent memory implementations fall into one of two camps:

1. **Vector stores** — shove everything into embeddings and hope semantic similarity finds what you need. Works for "find similar documents", falls apart when you need to answer "who decided to deprecate service X, and what was their rationale?"

2. **Flat key-value / JSON dumps** — fast, but no structure. Can't traverse relationships, can't version facts over time, can't answer "show me everything connected to this project within 2 hops."

Engram takes a different approach: **a typed knowledge graph** where entities have explicit relationships, facts are versioned with supersession chains, and multi-hop traversal lets the agent reason about connections — not just similarity.

It exposes 14 MCP tools that any MCP-compatible agent can use. It was designed for [OpenClaw](https://github.com/malindarathnayake/OpenClaw) bots but works with any MCP client.

### What It Actually Solves

- **Structured recall** — "What did Alice decide about the API migration?" traverses `Person → DECIDED → Decision` instead of hoping a vector search returns the right chunk
- **Fact versioning** — When information changes, `supersede_fact` creates a `SUPERSEDED_BY` chain. The agent sees current truth and can trace how it evolved
- **Relationship-aware context** — `recall_connections` walks the graph N hops deep, building a subgraph the agent can reason over
- **Schema guardrails** — Configurable entity/relationship types prevent the graph from becoming an unstructured dumping ground
- **Graceful degradation** — If the database is down, tools return structured errors instead of crashing the host agent

---

## Architecture

```
┌──────────────┐     stdio/MCP      ┌──────────┐     SQL/Cypher     ┌─────────────────────┐
│  AI Agent    │ ◄──────────────────► │  Engram  │ ◄────────────────► │  PostgreSQL 16      │
│  (OpenClaw,  │    14 MCP tools     │  Server  │   parameterized   │  + Apache AGE 1.5.0 │
│   Claude,    │                     │          │   queries only    │  + pgvector 0.7.4   │
│   any MCP)   │                     └──────────┘                   └─────────────────────┘
└──────────────┘
```

**Stack:** TypeScript (ESM) · `@modelcontextprotocol/sdk` · `pg` · Zod
**Database:** PostgreSQL 16 with Apache AGE (graph) + pgvector (embeddings)
**Transport:** stdio (MCP standard)

---

## MCP Tools

### Write (5 tools)

| Tool | Purpose |
|------|---------|
| `remember_entity` | Create or update an entity (merge properties on conflict) |
| `remember_relationship` | Create a directed, typed relationship between entities |
| `supersede_fact` | Version a fact — old fact gets `SUPERSEDED_BY` link to new |
| `forget_entity` | Soft-delete (hidden from queries, preserved in graph) |
| `merge_entities` | Consolidate duplicates — transfers relationships, soft-deletes merged |

### Read (7 tools)

| Tool | Purpose |
|------|---------|
| `recall_entity` | Look up by name or UUID, optionally include relationships |
| `recall_connections` | Multi-hop traversal with optional Mermaid diagram output |
| `recall_context` | Entity + connections + facts in one call |
| `recall_timeline` | Chronological events related to an entity |
| `find_contradictions` | Surface conflicting active facts |
| `search_entities` | Fuzzy name search with optional type filter |
| `graph_stats` | Entity/relationship counts, schema version, health status |

### Schema (2 tools)

| Tool | Purpose |
|------|---------|
| `get_memory_schema` | View current entity types, relationship types, guardrails |
| `update_memory_schema` | Add new entity types (enforces guardrails: max types, min examples, similarity dedup) |

---

## Quick Start

### Prerequisites

- Node.js >= 22
- Docker (for the database)

### 1. Build

```bash
git clone https://github.com/malindarathnayake/engram.git
cd engram
npm install
npm run build
```

### 2. Start the Database

```bash
docker build -t engram-db ./docker
docker run -d \
  --name engram-db \
  -e POSTGRES_PASSWORD=engram \
  -e POSTGRES_DB=agent_memory \
  -p 5432:5432 \
  engram-db
```

This builds a custom PostgreSQL 16 image with Apache AGE 1.5.0 and pgvector 0.7.4 compiled from source.

### 3. Run

```bash
ENGRAM_MODE=external \
ENGRAM_EXTERNAL_HOST=localhost \
ENGRAM_EXTERNAL_PASSWORD=engram \
npm start
```

---

## Using with OpenClaw

> **Full deployment guide:** See [`Documentation/deployment-guide.md`](Documentation/deployment-guide.md) for step-by-step Docker Compose setup including database password, environment variables, tool profile configuration, and troubleshooting.

There are two ways to add Engram to an existing OpenClaw bot.

### Option A: Direct MCP Registration (Recommended)

Add Engram as an MCP server in your bot's `openclaw.json`. No plugin install needed — OpenClaw talks to Engram over stdio.

**1. Install Engram globally in your bot's Docker image:**

```dockerfile
# In your bot's Dockerfile, after your existing setup:
RUN npm install -g @malindarathnayake/engram
```

**2. Add the memory database to your `docker-compose.yml`:**

```yaml
services:
  # ... your existing services ...

  memory-db:
    build:
      context: ./engram/docker  # or use the published image
    environment:
      POSTGRES_PASSWORD: ${ENGRAM_DB_PASSWORD:-engram}
      POSTGRES_DB: agent_memory
    volumes:
      - memory-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      start_period: 15s
      retries: 5

volumes:
  memory-data:
```

**3. Register in `openclaw.json`:**

```json
{
  "mcpServers": {
    "engram": {
      "command": "engram",
      "transport": "stdio",
      "env": {
        "ENGRAM_MODE": "external",
        "ENGRAM_EXTERNAL_HOST": "memory-db",
        "ENGRAM_EXTERNAL_PASSWORD": "${ENGRAM_DB_PASSWORD}",
        "ENGRAM_SCHEMA_PRESET": "dev-team"
      }
    }
  },
  "agents": {
    "defaults": {
      "systemPromptFile": "/usr/local/lib/node_modules/@malindarathnayake/engram/dist/system-prompt.md"
    }
  }
}
```

**4. Or auto-configure with `--initialize`:**

```bash
cd /path/to/your/bot
engram --initialize
```

This writes the `mcpServers` and `systemPromptFile` entries into your `openclaw.json` automatically.

### Option B: OpenClaw Native Plugin (engram-bridge)

The bridge plugin registers all 14 tools natively in OpenClaw's tool palette and manages the Engram subprocess lifecycle.

**1. Install both packages:**

```bash
# Install the engram MCP server (provides the `engram` binary)
npm install -g @malindarathnayake/engram

# Install the bridge plugin into OpenClaw's extensions directory
npx @malindarathnayake/engram-bridge install
```

The installer places the plugin at `~/.openclaw/extensions/engram-bridge/` by default. Use `--installpath` to override:

```bash
# For bind-mounted Docker deployments (./data maps to ~/.openclaw):
npx @malindarathnayake/engram-bridge install --installpath ./data/extensions/engram-bridge
```

**3. Register the plugin in `openclaw.json`:**

```json
{
  "plugins": {
    "allow": ["engram-bridge"],
    "entries": {
      "engram-bridge": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true
        },
        "config": {
          "command": "engram",
          "maxRestarts": 3
        }
      }
    }
  }
}
```

> **WARNING:** Do NOT add `mcpServers` entries when using the plugin. The bridge replaces MCP registration entirely.

The bridge plugin:
- Lazily spawns the Engram process on first tool call
- Whitelists only `ENGRAM_*`, `PATH`, `HOME` env vars to the subprocess
- Auto-restarts on failure (up to `maxRestarts` times)
- Injects memory curation instructions via `before_prompt_build` hook

---

## Configuration

All configuration is via environment variables (prefixed `ENGRAM_`):

| Variable | Default | Description |
|----------|---------|-------------|
| `ENGRAM_MODE` | `bundled` | `bundled` (sidecar) or `external` (remote PostgreSQL) |
| `ENGRAM_SCHEMA_PRESET` | `dev-team` | Schema preset: `dev-team`, `coding-agent`, `executive-assistant` |
| `ENGRAM_EXTERNAL_HOST` | — | PostgreSQL host (required for external mode) |
| `ENGRAM_EXTERNAL_PORT` | `5432` | PostgreSQL port |
| `ENGRAM_EXTERNAL_DATABASE` | `agent_memory` | Database name |
| `ENGRAM_EXTERNAL_PASSWORD` | — | Database password |
| `ENGRAM_EXTERNAL_SSL` | `true` | Enable SSL for external connections |
| `ENGRAM_GRAPH_NAME` | `engram` | Apache AGE graph name |
| `ENGRAM_MAX_ENTITY_TYPES` | `15` | Maximum allowed entity types in schema |
| `ENGRAM_MAX_DEPTH` | `3` | Default traversal depth |
| `ENGRAM_DEFAULT_LIMIT` | `50` | Default result limit |
| `ENGRAM_MAX_LIMIT` | `200` | Maximum allowed result limit |
| `ENGRAM_QUERY_TIMEOUT_MS` | `5000` | Query timeout in milliseconds |

### Schema Presets

| Preset | Entity Types | For |
|--------|-------------|-----|
| `dev-team` | Person, Company, Team, Project, Decision, Meeting, Repository, Bug, Pattern, Topic, Fact | Software teams where leadership also codes |
| `coding-agent` | Person, Repository, File, Function, Bug, Decision, Pattern, Dependency, Fact | Coding bots tracking architecture and bugs |
| `executive-assistant` | Person, Company, Team, Project, Decision, Meeting, Topic, Action, Fact | Executive assistants managing people and orgs |

---

## Security Testing

Engram ships with a containerized security test harness that runs 26 automated scenarios against a live MCP server instance. This isn't a checkbox exercise — every test proves a specific defense holds.

### Test Categories

| Category | Tests | What It Proves |
|----------|-------|----------------|
| **INJECTION** | 9 | Cypher/SQL injection blocked across all input vectors: entity names, types, relationship types, property values, property keys, fact content, search queries, schema updates. All queries use parameterized agtype maps — string interpolation is never used for user input. |
| **DISCLOSURE** | 4 | Database credentials, connection strings, canary secrets, and internal structure (table names, stack traces, Cypher syntax) never leak in error responses or stderr logs. Cross-test analysis scans all collected responses for any secret value. |
| **EXHAUSTION** | 5 | Depth limits enforced, result limits clamped, 100KB payloads handled without crash, 500KB property objects rejected, 50 concurrent requests processed without errors. |
| **ESCALATION** | 2 | Soft-deleted entities invisible to both recall and search. Merged entities properly hidden after consolidation. |
| **BYPASS** | 5 | Empty names rejected, out-of-range confidence scores rejected, schema guardrails enforced (min examples, max types), null bytes handled without crash. |
| **CONTAINER** | 1 | Environment variables (including planted canary secrets) never appear in any tool response. |

### Running the Tests

```bash
cd pentest
./run.sh
```

This builds isolated Docker containers, runs all scenarios against a fresh database, and generates a report. Exit code 0 means all pass.

### Latest Results

**26/26 passed** — [Full report](pentest/output/report.md) · [Structured results](pentest/output/results.json)

```
Engram Security Test Report
Version: 0.2.0 | Overall: PASS

Happy-Path:  8/8 passed
Security:   26/26 passed (0 failed)

Injection:   9/9  — Graph survives all payloads
Disclosure:  4/4  — No secrets in errors, logs, or cross-test analysis
Exhaustion:  5/5  — Limits enforced, oversized payloads handled
Escalation:  2/2  — Soft-delete and merge isolation confirmed
Bypass:      5/5  — Input validation holds
Container:   1/1  — Env var isolation confirmed
```

### Query Safety

All Cypher queries use parameterized agtype maps. User input is never interpolated into query strings:

```typescript
// What we do (parameterized — safe)
SELECT * FROM cypher('graph', $$ MERGE (v:Person {name: $name}) $$, $1) AS (v agtype)
-- $1 = ag_catalog.agtype_build_map('name', 'Alice')

// What we don't do (string interpolation — vulnerable)
SELECT * FROM cypher('graph', $$ MERGE (v:Person {name: '${userInput}'}) $$) AS (v agtype)
```

Entity types and relationship types are validated against `IDENTIFIER_RE` (alphanumeric + underscore, must start with letter) before they ever reach a query.

---

## Development

```bash
npm install           # Install dependencies
npm run build         # Compile TypeScript + copy system prompt
npm run build:all     # Build engram + bridge plugin
npm test              # Run all tests
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests (requires Docker)
npm run pack:all      # Build + package both tarballs
```

### Project Structure

```
src/
├── index.ts              # MCP server entry, tool registration, stdio transport
├── config.ts             # Zod config schema, env var resolution
├── system-prompt.md      # Bot memory instructions (injected into agent context)
├── db/
│   ├── connection.ts     # PostgreSQL pool, AGE bootstrap, Cypher execution
│   ├── cypher.ts         # Parameterized query builder
│   ├── agtype.ts         # AGE response parser
│   └── init.ts           # Database initialization
├── graph/
│   ├── entities.ts       # Entity CRUD
│   ├── relationships.ts  # Relationship creation and querying
│   ├── facts.ts          # Fact versioning and contradiction detection
│   ├── traversal.ts      # Multi-hop graph traversal
│   └── search.ts         # Fuzzy entity search
├── schema/
│   ├── manager.ts        # Schema validation and updates
│   └── presets.ts        # Preset loading
├── tools/
│   ├── tool-descriptions.ts  # Dynamic tool definitions
│   ├── write-tools.ts    # Write tool handlers
│   ├── read-tools.ts     # Read tool handlers
│   └── schema-tools.ts   # Schema tool handlers
└── mermaid/
    └── generator.ts      # Mermaid diagram generation

plugins/engram-bridge/    # OpenClaw native plugin
presets/                  # Schema preset JSON files
docker/                   # Custom PostgreSQL image (AGE + pgvector)
pentest/                  # Security test harness
```

---

## License

MIT
