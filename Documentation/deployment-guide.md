# Deploying Engram with OpenClaw

Step-by-step guide for adding Engram graph memory to an OpenClaw bot running on Docker Compose.

**Prerequisites:**
- OpenClaw bot running via Docker Compose
- Docker Desktop (or Docker Engine on Linux)
- The engram Docker image build context (the `docker/` directory from this repo)

---

## 1. Install Engram in the Docker Image

Add the engram binary to your bot's Dockerfile:

```dockerfile
# Install Engram — graph-based memory MCP server
COPY artifacts/engram-latest.tgz /tmp/engram.tgz
RUN npm install -g /tmp/engram.tgz && rm /tmp/engram.tgz
```

Copy the tarball into your image build directory:

```bash
# From the engram repo
npm run pack:all
cp artifacts/malindarathnayake-engram-0.2.0.tgz <your-image-dir>/artifacts/engram-latest.tgz
```

Rebuild the image:

```bash
docker build -t openclaw-bot:latest <your-image-dir>
```

Verify the binary is available:

```bash
docker run --rm openclaw-bot:latest which engram
# Expected: /usr/local/bin/engram
```

---

## 2. Deploy the Bridge Plugin

The bridge plugin must be at `~/.openclaw/extensions/engram-bridge/` inside the container. For bind-mounted data directories (`./data:/home/node/.openclaw`), install on the host.

### Option A: Installer CLI (requires Node.js on host)

```bash
# From the engram repo (after npm run build:all)
cd plugins/engram-bridge
node dist/install.js install --installpath <your-bot>/data/extensions/engram-bridge

# Or clean reinstall (wipes existing installation first):
node dist/install.js install --cleaninstall --installpath <your-bot>/data/extensions/engram-bridge
```

If the package is published to GitHub Packages:

```bash
npx @malindarathnayake/engram-bridge install --installpath <your-bot>/data/extensions/engram-bridge
```

### Option B: Zip extraction (no Node.js required on host)

Download `engram-bridge-<version>.zip` from [releases](https://github.com/malindarathnayake/engram/releases) and extract:

```bash
# Linux/macOS
mkdir -p <your-bot>/data/extensions/engram-bridge
unzip engram-bridge-0.2.0.zip -d <your-bot>/data/extensions/engram-bridge

# Windows (PowerShell)
Expand-Archive engram-bridge-0.2.0.zip -DestinationPath <your-bot>\data\extensions\engram-bridge
```

The zip is self-contained — includes `node_modules/` so no `npm install` step is needed.

### Option C: Baked into the image (no bind mount)

If you don't bind-mount the data directory, install directly in the Dockerfile:

```dockerfile
RUN npm install -g @malindarathnayake/engram
RUN npx @malindarathnayake/engram-bridge install
```

### Verify the plugin directory

Whichever method you use, the result should be:

```
data/extensions/engram-bridge/
├── dist/
│   └── index.js
├── node_modules/          # must include @sinclair/typebox
├── openclaw.plugin.json
└── package.json
```

---

## 3. Generate a Database Password

```bash
openssl rand -base64 24
```

Add it to your bot's `.env` file (same directory as `docker-compose.yml`):

```env
ENGRAM_DB_PASSWORD=<your-generated-password>
```

---

## 4. Docker Compose Changes

### 4a. Add the memory-db service

```yaml
memory-db:
  build:
    context: ./engram/docker
  container_name: ${BOT_NAME}-memory-db
  restart: unless-stopped
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
  deploy:
    resources:
      limits:
        memory: 512m
        cpus: "1.0"
      reservations:
        memory: 128m
        cpus: "0.25"
  logging:
    driver: json-file
    options:
      max-size: "20m"
      max-file: "3"
  networks:
    - openclaw-net
```

### 4b. Add the memory-data volume

Under the top-level `volumes:` section:

```yaml
volumes:
  memory-data:
```

### 4c. Update the gateway service environment

Add these environment variables to the `openclaw-gateway` service:

```yaml
environment:
  # ... existing vars ...
  ENGRAM_MODE: bundled
  ENGRAM_DB_HOST: memory-db
  ENGRAM_DB_PORT: "5432"
  ENGRAM_DB_NAME: agent_memory
  ENGRAM_DB_USER: postgres
  ENGRAM_DB_PASSWORD: ${ENGRAM_DB_PASSWORD:-engram}
  ENGRAM_SCHEMA_PRESET: dev-team
```

All six `ENGRAM_*` variables are required. The bridge plugin whitelists only `ENGRAM_*` prefixed environment variables when spawning the engram subprocess — any DB connection details without this prefix will not be passed through.

### 4d. Add gateway dependency on memory-db

```yaml
openclaw-gateway:
  depends_on:
    memory-db:
      condition: service_healthy
```

---

## 5. OpenClaw Configuration (`openclaw.json`)

The config file lives at `data/openclaw.json` (mounted as `~/.openclaw/openclaw.json` inside the container).

### 5a. Allow the plugin

Add `engram-bridge` to the plugins allow list:

```json
{
  "plugins": {
    "allow": ["engram-bridge"]
  }
}
```

### 5b. Add the plugin entry

Under `plugins.entries`:

```json
{
  "plugins": {
    "entries": {
      "engram-bridge": {
        "enabled": true,
        "hooks": {
          "allowPromptInjection": true
        },
        "config": {
          "command": "engram"
        }
      }
    }
  }
}
```

| Key | Purpose |
|-----|---------|
| `enabled` | Activates the plugin |
| `hooks.allowPromptInjection` | Allows the plugin to inject graph memory instructions into the agent's system prompt via the `before_prompt_build` hook |
| `config.command` | Path to the `engram` binary. Use `"engram"` if it's on PATH, or a full path if installed elsewhere |

### 5c. Configure tool access

The default `coding` tool profile restricts the agent to built-in tools only. Plugin-registered tools are not included in any predefined profile group. To make Engram's 14 tools available:

**Option 1 — Full profile (simplest):**

```json
{
  "tools": {
    "profile": "full"
  }
}
```

All other security controls (sandbox, elevated, deny rules) still apply.

**Option 2 — Explicit allow (more granular):**

Keep your existing profile and add Engram tools to the allow list. The allow list is **additive** to the profile's base set:

```json
{
  "tools": {
    "profile": "coding",
    "allow": [
      "remember_entity",
      "remember_relationship",
      "forget_entity",
      "merge_entities",
      "supersede_fact",
      "recall_entity",
      "recall_connections",
      "recall_context",
      "recall_timeline",
      "search_entities",
      "find_contradictions",
      "graph_stats",
      "get_memory_schema",
      "update_memory_schema"
    ]
  }
}
```

> **WARNING:** Do NOT add `mcpServers` entries to `openclaw.json` when using the bridge plugin. The bridge replaces MCP registration entirely. Adding `mcpServers` will crash the gateway.

---

## 6. Start

```bash
docker compose up -d
```

Or bring up the database first, then the gateway:

```bash
docker compose up -d memory-db
docker compose up -d openclaw-gateway
```

---

## 7. Verify

### Check plugin registration

```bash
docker compose logs openclaw-gateway 2>&1 | grep engram
```

Expected:

```
Engram bridge registered 14 tools (command: engram)
```

You will also see a provenance warning — this is expected and harmless:

```
engram-bridge: loaded without install/load-path provenance; treat as untracked local code
```

OpenClaw logs this because the plugin was loaded from the extensions directory (bind-mounted or manually extracted) rather than from an npm install record. It is already trusted via `plugins.allow` in `openclaw.json`. The plugin registers once per configured agent, so seeing multiple "registered 14 tools" lines is normal.

### Check the database

```bash
docker exec <bot-name>-memory-db psql -U postgres -d agent_memory \
  -c "SELECT * FROM ag_catalog.ag_graph;"
```

Expected: a row with `name = "engram"`.

### Test via CLI

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"graph_stats","arguments":{}}}' | \
  docker compose exec -T openclaw-gateway engram
```

### Test from the agent

Send your bot a message asking it to run `graph_stats`. Expected response: a JSON object with `healthy: true`, entity/relationship counts, and `schema_preset: "dev-team"`.

---

## 8. Troubleshooting

### "Engram failed to start: Engram MCP server not ready"

The bridge plugin couldn't complete the MCP handshake with the engram subprocess.

1. **Database reachable?** — `docker compose ps memory-db` should show healthy
2. **Environment variables present?** — `docker compose exec openclaw-gateway env | grep ENGRAM | sort` — all six vars must be present (`MODE`, `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`)
3. **Binary exists?** — `docker compose exec openclaw-gateway which engram` should return `/usr/local/bin/engram`

### Tools registered but not callable by the agent

The tool profile restricts which tools the agent can use.

1. Check `tools.profile` in `openclaw.json` — if set to `"coding"`, plugin tools are excluded
2. Change to `"full"` or add explicit allows (see section 5c)
3. Restart the gateway after config changes

### `Cannot find module '@sinclair/typebox'`

The plugin's `node_modules/` is missing or incomplete.

```bash
# If using bind mount — reinstall on host:
cd <your-bot>/data/extensions/engram-bridge && npm install --production

# Or re-extract the zip (includes node_modules/)
```

### Plugin loads but no tools appear

Verify `openclaw.plugin.json` exists in the extensions directory and contains `"id": "engram-bridge"`.

### Gateway crashes with "Unrecognized key: mcpServers"

Remove `mcpServers` from `openclaw.json`. The bridge plugin replaces MCP registration — these two approaches are mutually exclusive.

---

## Architecture

```
┌────────────────────────────────────────────────┐
│  OpenClaw Gateway Container                     │
│                                                 │
│  ┌─────────────┐    ┌────────────────────────┐ │
│  │ Agent Loop   │───▶│ engram-bridge plugin    │ │
│  │ (native tool │◀───│                        │ │
│  │  calls)      │    │ spawns engram binary   │ │
│  └─────────────┘    │ via stdio MCP          │ │
│                      └──────────┬─────────────┘ │
│                                 │ ENGRAM_* env   │
│                                 ▼                │
│                      ┌──────────────────────┐   │
│                      │ engram subprocess     │   │
│                      │ (MCP server on stdio) │   │
│                      └──────────┬────────────┘  │
│                                 │ TCP :5432      │
└─────────────────────────────────┼────────────────┘
                                  │
                    ┌─────────────▼─────────────┐
                    │ memory-db container        │
                    │ PostgreSQL 16 + Apache AGE │
                    │ + pgvector                 │
                    └───────────────────────────┘
```

**Data flow:**
1. Agent makes a native tool call (e.g., `remember_entity`)
2. Bridge plugin routes the call to the engram subprocess via MCP stdio
3. Engram executes the graph query against PostgreSQL/AGE
4. Result flows back through MCP → bridge → agent

**Security:** The bridge only passes `ENGRAM_*` prefixed vars plus `PATH`, `NODE_PATH`, and `HOME` to the subprocess. The engram process does not inherit the full gateway environment.

---

## Updating Engram

```bash
# 1. Build the new version
cd <engram-repo>
git pull && npm run pack:all

# 2. Update the Docker image
cp artifacts/malindarathnayake-engram-0.2.0.tgz <your-image-dir>/artifacts/engram-latest.tgz
cd <your-image-dir> && docker build -t openclaw-bot:latest .

# 3. Update the bridge plugin (pick one)
# Installer:
node plugins/engram-bridge/dist/install.js install --cleaninstall \
  --installpath <your-bot>/data/extensions/engram-bridge
# Or zip:
unzip -o artifacts/engram-bridge-0.2.0.zip -d <your-bot>/data/extensions/engram-bridge

# 4. Restart
cd <your-bot> && docker compose up -d
```

The database volume (`memory-data`) persists across updates — graph data is safe.
