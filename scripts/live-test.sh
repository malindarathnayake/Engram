#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────
# live-test.sh — Build, pack, spin up DB, run all 14 tools,
#                save versioned artifact to artifacts/
#
# Usage:
#   ./scripts/live-test.sh           # full run
#   ./scripts/live-test.sh --keep    # leave DB running after test
#   ./scripts/live-test.sh --skip-db # skip DB (already running)
# ──────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ARTIFACTS_DIR="$PROJECT_ROOT/artifacts"
CONTAINER_NAME="engram-live-test-db"
DOCKER_IMAGE="engram-db:live-test"
DB_PORT=15433
DB_PASS="live_test_pass"
KEEP=false
SKIP_DB=false

for arg in "$@"; do
  case $arg in
    --keep) KEEP=true ;;
    --skip-db) SKIP_DB=true ;;
  esac
done

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

cleanup() {
  if [ "$KEEP" = false ] && [ "$SKIP_DB" = false ]; then
    echo -e "\n${GREEN}[live-test]${NC} Cleaning up..."
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
  else
    echo -e "\n${GREEN}[live-test]${NC} DB left running at localhost:$DB_PORT (container: $CONTAINER_NAME)"
  fi
}
trap cleanup EXIT

# ── Step 1: Build ─────────────────────────────────────────────
echo -e "${GREEN}[live-test]${NC} Building project..."
cd "$PROJECT_ROOT"
npm run build

# ── Step 2: Pack + version into artifacts/ ────────────────────
echo -e "${GREEN}[live-test]${NC} Packing npm package..."
mkdir -p "$ARTIFACTS_DIR"

# Read version from package.json
PKG_VERSION=$(node -e "console.log(require('./package.json').version)")
PKG_NAME=$(node -e "console.log(require('./package.json').name)")
BUILD_TS=$(date -u +"%Y%m%d-%H%M%S")
GIT_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "nogit")

# Pack to temp, then copy with versioned name
TARBALL=$(npm pack 2>&1 | tail -1)

if [[ ! -f "$TARBALL" ]]; then
  echo -e "${RED}[live-test]${NC} npm pack failed — $TARBALL not found"
  exit 1
fi

# Versioned filename: @openclaw/engram → openclaw-engram-0.1.0-20260324-143012-abc1234.tgz
SAFE_NAME=$(echo "$PKG_NAME" | sed 's/@//g; s/\//-/g')
VERSIONED_NAME="${SAFE_NAME}-${PKG_VERSION}-${BUILD_TS}-${GIT_SHA}.tgz"
LATEST_NAME="${SAFE_NAME}-${PKG_VERSION}-latest.tgz"

mv "$TARBALL" "$ARTIFACTS_DIR/$VERSIONED_NAME"
cp "$ARTIFACTS_DIR/$VERSIONED_NAME" "$ARTIFACTS_DIR/$LATEST_NAME"

echo -e "${GREEN}[live-test]${NC} Package saved:"
echo -e "  ${YELLOW}artifacts/${VERSIONED_NAME}${NC}"
echo -e "  ${YELLOW}artifacts/${LATEST_NAME}${NC} (symlink-like copy)"
echo -e "  Version: ${PKG_VERSION}  Git: ${GIT_SHA}  Built: ${BUILD_TS}"

# ── Step 3: Build DB image ────────────────────────────────────
if [ "$SKIP_DB" = false ]; then
  echo -e "${GREEN}[live-test]${NC} Building database image..."
  docker build -q -t "$DOCKER_IMAGE" docker/

  # Stop any existing container
  docker stop "$CONTAINER_NAME" 2>/dev/null || true
  docker rm "$CONTAINER_NAME" 2>/dev/null || true

  # Start DB
  echo -e "${GREEN}[live-test]${NC} Starting database..."
  docker run -d \
    --name "$CONTAINER_NAME" \
    -e POSTGRES_PASSWORD="$DB_PASS" \
    -e POSTGRES_DB=agent_memory \
    -p "$DB_PORT":5432 \
    "$DOCKER_IMAGE" > /dev/null

  # Wait for DB
  echo -e "${GREEN}[live-test]${NC} Waiting for database..."
  for i in $(seq 1 30); do
    if docker exec "$CONTAINER_NAME" pg_isready -U postgres -q 2>/dev/null; then
      break
    fi
    if [ "$i" -eq 30 ]; then
      echo -e "${RED}[live-test]${NC} Database failed to start in 30s"
      exit 1
    fi
    sleep 1
  done
  echo -e "${GREEN}[live-test]${NC} Database ready."
fi

# ── Step 4: Run the live test ─────────────────────────────────
echo -e "${GREEN}[live-test]${NC} Running live integration test...\n"
ENGRAM_MODE=external \
ENGRAM_EXTERNAL_HOST=localhost \
ENGRAM_EXTERNAL_PORT=$DB_PORT \
ENGRAM_EXTERNAL_DATABASE=agent_memory \
ENGRAM_EXTERNAL_PASSWORD=$DB_PASS \
ENGRAM_EXTERNAL_SSL=false \
ENGRAM_GRAPH_NAME=live_test \
ENGRAM_SCHEMA_PRESET=dev-team \
  node "$SCRIPT_DIR/live-test.mjs"

TEST_EXIT=$?

# ── Step 5: Print artifact summary ────────────────────────────
echo ""
echo -e "${GREEN}[live-test]${NC} ── Artifacts ──"
ls -lh "$ARTIFACTS_DIR"/*.tgz 2>/dev/null | while read -r line; do
  echo -e "  $line"
done

echo ""
if [ $TEST_EXIT -eq 0 ]; then
  echo -e "${GREEN}[live-test]${NC} All tests passed. Package ready at:"
  echo -e "  ${YELLOW}artifacts/${VERSIONED_NAME}${NC}"
else
  echo -e "${RED}[live-test]${NC} Tests FAILED. Package built but not verified."
fi

exit $TEST_EXIT
