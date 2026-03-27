#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# package-test.sh — Build npm package and test inside Docker
#
# Usage:
#   ./scripts/package-test.sh          # build + test
#   ./scripts/package-test.sh --shell  # build + drop into container shell
#   ./scripts/package-test.sh --clean  # remove test artifacts
# ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_DIR="$PROJECT_ROOT/.package-test"
DOCKER_IMAGE="engram-db:test"
CONTAINER_NAME="engram-package-test-db"
TEST_IMAGE="engram-package-test"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[pack]${NC} $*"; }
warn() { echo -e "${YELLOW}[pack]${NC} $*"; }
err()  { echo -e "${RED}[pack]${NC} $*" >&2; }

cleanup() {
  log "Cleaning up..."
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true
}

do_clean() {
  cleanup
  rm -rf "$BUILD_DIR"
  docker rmi "$TEST_IMAGE" 2>/dev/null || true
  docker rmi "$DOCKER_IMAGE" 2>/dev/null || true
  log "Clean complete."
  exit 0
}

# Parse args
SHELL_MODE=false
for arg in "$@"; do
  case $arg in
    --shell) SHELL_MODE=true ;;
    --clean) do_clean ;;
    *) err "Unknown arg: $arg"; exit 1 ;;
  esac
done

trap cleanup EXIT

# ── Step 1: Build the TypeScript project ──────────────────────
log "Building TypeScript project..."
cd "$PROJECT_ROOT"
npm run build

# ── Step 2: Create the npm package tarball ────────────────────
log "Packing npm package..."
mkdir -p "$BUILD_DIR"
TARBALL=$(npm pack --pack-destination "$BUILD_DIR" 2>&1 | tail -1)
TARBALL_PATH="$BUILD_DIR/$TARBALL"

if [[ ! -f "$TARBALL_PATH" ]]; then
  err "npm pack failed — tarball not found at $TARBALL_PATH"
  exit 1
fi
log "Package created: $TARBALL"

# ── Step 3: Build the database image ─────────────────────────
log "Building database image ($DOCKER_IMAGE)..."
docker build -t "$DOCKER_IMAGE" "$PROJECT_ROOT/docker"

# ── Step 4: Build the test container ──────────────────────────
log "Building test container ($TEST_IMAGE)..."
cat > "$BUILD_DIR/Dockerfile" <<'DOCKERFILE'
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl postgresql-client && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install the package FROM the tarball (not source)
COPY engram-*.tgz /tmp/engram.tgz
RUN npm install -g /tmp/engram.tgz && rm /tmp/engram.tgz

# Copy smoke test script
COPY smoke-test.mjs /app/smoke-test.mjs

CMD ["node", "/app/smoke-test.mjs"]
DOCKERFILE

# ── Step 5: Write the smoke test ──────────────────────────────
cat > "$BUILD_DIR/smoke-test.mjs" <<'SMOKE'
/**
 * Smoke test — validates that the engram package installed correctly
 * and the binary works end-to-end with a real database.
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const DB_HOST = process.env.ENGRAM_TEST_DB_HOST || "host.docker.internal";
const DB_PORT = process.env.ENGRAM_TEST_DB_PORT || "5432";
const DB_PASS = process.env.ENGRAM_TEST_DB_PASS || "test";

const checks = [];
let exitCode = 0;

function check(name, pass, detail = "") {
  checks.push({ name, pass, detail });
  const icon = pass ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m";
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!pass) exitCode = 1;
}

// ── Check 1: Binary resolves ──────────────────────────────────
console.log("\n── Package Smoke Tests ──\n");

try {
  const which = spawn("which", ["engram"]);
  const path = await new Promise((res, rej) => {
    let out = "";
    which.stdout.on("data", (d) => (out += d));
    which.on("close", (code) => (code === 0 ? res(out.trim()) : rej()));
  });
  check("Binary resolves", true, path);
} catch {
  check("Binary resolves", false, "engram not found in PATH");
}

// ── Check 2: --initialize works (dry-run) ─────────────────────
try {
  const proc = spawn("engram", ["--initialize"], { cwd: "/tmp" });
  const code = await new Promise((res) => proc.on("close", res));
  // It will exit 0 and write openclaw.json to /tmp
  check("--initialize flag", code === 0, `exit code ${code}`);
} catch (e) {
  check("--initialize flag", false, String(e));
}

// ── Check 3: MCP server starts and responds ───────────────────
try {
  const engram = spawn("engram", [], {
    env: {
      ...process.env,
      ENGRAM_MODE: "external",
      ENGRAM_EXTERNAL_HOST: DB_HOST,
      ENGRAM_EXTERNAL_PORT: DB_PORT,
      ENGRAM_EXTERNAL_DATABASE: "agent_memory",
      ENGRAM_EXTERNAL_PASSWORD: DB_PASS,
      ENGRAM_EXTERNAL_SSL: "false",
      ENGRAM_GRAPH_NAME: "smoke_test",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // Wait for server to start
  await sleep(3000);

  // Send MCP initialize request
  const initReq = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" },
    },
  });

  engram.stdin.write(initReq + "\n");

  const response = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timeout")), 10000);
    engram.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      // MCP responses are newline-delimited JSON
      const lines = buf.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1) {
            clearTimeout(timer);
            resolve(parsed);
          }
        } catch {
          // partial line, keep buffering
        }
      }
    });
    engram.stderr.on("data", () => {}); // drain stderr
  });

  const hasTools = response.result?.capabilities?.tools !== undefined;
  check("MCP server responds", true, `tools capability: ${hasTools}`);

  // Send tools/list request
  const listReq = JSON.stringify({
    jsonrpc: "2.0",
    id: 2,
    method: "notifications/initialized",
  });
  engram.stdin.write(listReq + "\n");
  await sleep(500);

  const toolsReq = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/list",
    params: {},
  });
  engram.stdin.write(toolsReq + "\n");

  const toolsResponse = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timeout")), 10000);
    engram.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 3) {
            clearTimeout(timer);
            resolve(parsed);
          }
        } catch {
          // partial
        }
      }
    });
  });

  const toolNames = (toolsResponse.result?.tools || []).map((t) => t.name);
  const expectedTools = [
    "remember_entity", "remember_relationship", "supersede_fact",
    "forget_entity", "merge_entities", "recall_entity",
    "recall_connections", "recall_context", "recall_timeline",
    "find_contradictions", "search_entities", "graph_stats",
    "get_memory_schema", "update_memory_schema",
  ];
  const allPresent = expectedTools.every((t) => toolNames.includes(t));
  check("All 14 tools registered", allPresent, `found ${toolNames.length}`);

  // Send a tool call: remember_entity
  const callReq = JSON.stringify({
    jsonrpc: "2.0",
    id: 4,
    method: "tools/call",
    params: {
      name: "remember_entity",
      arguments: { name: "Smoke Test", type: "Person", properties: { role: "test" } },
    },
  });
  engram.stdin.write(callReq + "\n");

  const callResponse = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("timeout")), 15000);
    engram.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      const lines = buf.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 4) {
            clearTimeout(timer);
            resolve(parsed);
          }
        } catch {
          // partial
        }
      }
    });
  });

  const callOk = !callResponse.result?.isError;
  check("remember_entity tool call", callOk,
    callOk ? "entity created" : JSON.stringify(callResponse.result));

  engram.kill("SIGTERM");
} catch (e) {
  check("MCP server responds", false, String(e));
}

// ── Summary ───────────────────────────────────────────────────
console.log("\n── Summary ──\n");
const passed = checks.filter((c) => c.pass).length;
const failed = checks.filter((c) => !c.pass).length;
console.log(`  ${passed} passed, ${failed} failed out of ${checks.length} checks`);

// Write JSON results for CI
const fs = await import("node:fs");
fs.writeFileSync("/tmp/smoke-results.json", JSON.stringify({ checks, passed, failed }, null, 2));

process.exit(exitCode);
SMOKE

# Copy tarball to build context
cp "$TARBALL_PATH" "$BUILD_DIR/"

docker build -t "$TEST_IMAGE" "$BUILD_DIR"

# ── Step 6: Start database container ──────────────────────────
log "Starting database container ($CONTAINER_NAME)..."
docker run -d \
  --name "$CONTAINER_NAME" \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_DB=agent_memory \
  -p 15432:5432 \
  "$DOCKER_IMAGE"

log "Waiting for database to be ready..."
for i in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" pg_isready -U postgres -q 2>/dev/null; then
    break
  fi
  if [ "$i" -eq 30 ]; then
    err "Database did not become ready in 30 seconds"
    exit 1
  fi
  sleep 1
done
log "Database ready."

# ── Step 7: Run the test container ────────────────────────────
if [ "$SHELL_MODE" = true ]; then
  log "Dropping into test container shell..."
  docker run --rm -it \
    --add-host=host.docker.internal:host-gateway \
    -e ENGRAM_TEST_DB_HOST=host.docker.internal \
    -e ENGRAM_TEST_DB_PORT=15432 \
    -e ENGRAM_TEST_DB_PASS=test \
    --entrypoint /bin/bash \
    "$TEST_IMAGE"
else
  log "Running smoke tests..."
  docker run --rm \
    --add-host=host.docker.internal:host-gateway \
    -e ENGRAM_TEST_DB_HOST=host.docker.internal \
    -e ENGRAM_TEST_DB_PORT=15432 \
    -e ENGRAM_TEST_DB_PASS=test \
    "$TEST_IMAGE"

  RESULT=$?
  if [ $RESULT -eq 0 ]; then
    log "All smoke tests passed."
  else
    err "Smoke tests failed (exit code $RESULT)."
    exit $RESULT
  fi
fi
