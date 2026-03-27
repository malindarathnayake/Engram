# engram-bridge

OpenClaw plugin that exposes [Engram](../../) graph memory tools as native agent tools.

> **Full deployment guide:** See [`Documentation/deployment-guide.md`](../../Documentation/deployment-guide.md) for end-to-end Docker Compose setup.

## What it does

- Registers 14 Engram tools (`remember_entity`, `recall_connections`, etc.) as native tools in the LLM's tool palette
- Injects memory curation instructions into every session via `before_prompt_build` hook
- Spawns the `engram` MCP server as a child process on first tool call (lazy start)
- Handles subprocess lifecycle: restart with backoff, graceful degradation when DB is down

## Requirements

- OpenClaw `2026.3.22+`
- `@malindarathnayake/engram` installed globally in the container (`npm install -g @malindarathnayake/engram`)
- `memory-db` sidecar running (PostgreSQL 16 + Apache AGE)

## Install

### Option A: With Node.js on the host

```bash
npx @malindarathnayake/engram-bridge install

# Or to a custom path (e.g., bind-mounted data directory):
npx @malindarathnayake/engram-bridge install --installpath ./data/extensions/engram-bridge

# Clean reinstall (wipes existing installation first):
npx @malindarathnayake/engram-bridge install --cleaninstall
```

To uninstall:

```bash
npx @malindarathnayake/engram-bridge uninstall
```

### Option B: Zip extraction (no Node.js required on host)

Download `engram-bridge-<version>.zip` from [releases](https://github.com/malindarathnayake/engram/releases) and extract:

```bash
# Linux/macOS
mkdir -p ~/.openclaw/extensions/engram-bridge
unzip engram-bridge-0.2.0.zip -d ~/.openclaw/extensions/engram-bridge

# Windows (PowerShell)
Expand-Archive engram-bridge-0.2.0.zip -DestinationPath "$env:USERPROFILE\.openclaw\extensions\engram-bridge"

# For bind-mounted Docker deployments:
unzip engram-bridge-0.2.0.zip -d ./data/extensions/engram-bridge
```

The zip is self-contained — includes `node_modules/` so no `npm install` step is needed.

### Then enable in openclaw.json

```json
{
  "plugins": {
    "allow": ["engram-bridge"],
    "entries": {
      "engram-bridge": {
        "enabled": true,
        "hooks": { "allowPromptInjection": true },
        "config": { "command": "engram" }
      }
    }
  }
}
```

Restart the gateway after enabling.

## Docker deployment

Two approaches depending on whether you bind-mount the data directory.

### Baked into the image

Install both the engram binary and the bridge plugin in the Dockerfile:

```dockerfile
RUN npm install -g @malindarathnayake/engram
RUN npx @malindarathnayake/engram-bridge install
```

This installs the plugin to `/home/node/.openclaw/extensions/engram-bridge/` (or wherever `$HOME` resolves inside the image).

### Bind-mounted data directory

When using `docker-compose.yml` with `./data:/home/node/.openclaw`, install the plugin on the host:

```bash
npx @malindarathnayake/engram-bridge install --installpath ./data/extensions/engram-bridge
```

This maps to `/home/node/.openclaw/extensions/engram-bridge/` inside the container, which is the path OpenClaw scans for plugins. The Dockerfile only needs the engram binary:

```dockerfile
RUN npm install -g @malindarathnayake/engram
```

> **Note:** On startup you will see a log line like:
> `loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records`
> This is expected and harmless. OpenClaw logs this because the plugin was loaded from the extensions directory (bind-mounted or manually extracted) rather than from an npm install record. It is already trusted via `plugins.allow` in `openclaw.json`. The plugin will also register once per configured agent — seeing multiple "registered 14 tools" lines is normal.

## Build from source

```bash
cd plugins/engram-bridge
npm install
npm run build
npm pack --pack-destination ../../artifacts/   # npm tarball
npm run pack:zip                               # self-contained zip
```

Or from the repo root: `npm run pack:all` builds both packages and the zip.

## Config

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `command` | string | `"engram"` | Path to engram binary |
| `maxRestarts` | number | `3` | Max subprocess restart attempts |

Set via `plugins.entries.engram-bridge.config` in `openclaw.json`.

## Environment Variables

The plugin spawns engram with a whitelisted env (only `ENGRAM_*` vars + `PATH` + `HOME`). Set these on the gateway container:

| Variable | Required | Description |
|----------|----------|-------------|
| `ENGRAM_MODE` | yes | `bundled` (sidecar) or `external` |
| `ENGRAM_DB_PASSWORD` | yes | PostgreSQL password |
| `ENGRAM_SCHEMA_PRESET` | no | Default: `dev-team` |
