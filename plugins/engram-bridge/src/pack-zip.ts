#!/usr/bin/env node

/**
 * Builds a self-contained zip of engram-bridge ready for extraction.
 *
 * Output: ../../artifacts/engram-bridge-<version>.zip
 *
 * Contents (flat — no wrapper directory):
 *   dist/index.js
 *   openclaw.plugin.json
 *   package.json
 *   node_modules/@sinclair/typebox/...
 *
 * Users extract directly into their extensions directory:
 *   unzip engram-bridge-0.2.0.zip -d ~/.openclaw/extensions/engram-bridge
 */

import { cpSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const packageRoot = resolve(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf-8"));
const version: string = pkg.version;

const artifactsDir = resolve(packageRoot, "..", "..", "artifacts");
const stagingDir = resolve(artifactsDir, ".engram-bridge-staging");
const zipName = `engram-bridge-${version}.zip`;
const zipPath = join(artifactsDir, zipName);

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n  error: ${msg}\n`);
  process.exit(1);
}

// ── Validate source ──────────────────────────────────────────

const distDir = join(packageRoot, "dist");
const manifest = join(packageRoot, "openclaw.plugin.json");

if (!existsSync(join(distDir, "index.js"))) {
  fail("dist/index.js not found. Run `npm run build` first.");
}
if (!existsSync(manifest)) {
  fail("openclaw.plugin.json not found.");
}

// ── Stage files ──────────────────────────────────────────────

console.log(`\n  Packaging engram-bridge v${version}\n`);

// Clean staging area
if (existsSync(stagingDir)) {
  rmSync(stagingDir, { recursive: true, force: true });
}
mkdirSync(stagingDir, { recursive: true });

// Copy plugin files (only what OpenClaw needs at runtime)
log("staging dist/index.js");
mkdirSync(join(stagingDir, "dist"), { recursive: true });
cpSync(join(distDir, "index.js"), join(stagingDir, "dist", "index.js"));

log("staging openclaw.plugin.json");
cpSync(manifest, join(stagingDir, "openclaw.plugin.json"));

log("staging package.json");
cpSync(join(packageRoot, "package.json"), join(stagingDir, "package.json"));

// Install production deps into staging
log("installing production dependencies");
try {
  execSync("npm install --production --ignore-scripts", {
    cwd: stagingDir,
    stdio: "pipe",
  });
} catch (err) {
  const stderr = (err as { stderr?: Buffer }).stderr?.toString() || "";
  fail(`npm install failed:\n${stderr}`);
}

// Verify typebox
if (!existsSync(join(stagingDir, "node_modules", "@sinclair", "typebox"))) {
  fail("@sinclair/typebox was not installed.");
}

// Remove package-lock.json from staging (not needed at runtime)
const lockfile = join(stagingDir, "package-lock.json");
if (existsSync(lockfile)) {
  rmSync(lockfile);
}

// ── Zip ──────────────────────────────────────────────────────

mkdirSync(artifactsDir, { recursive: true });

// Remove existing zip
if (existsSync(zipPath)) {
  rmSync(zipPath);
}

log(`creating ${zipName}`);
try {
  // zip from inside staging dir so paths are relative (no wrapper directory)
  execSync(`zip -rq "${zipPath}" .`, {
    cwd: stagingDir,
    stdio: "pipe",
  });
} catch {
  // Fallback: try tar if zip isn't available (some minimal Linux installs)
  const tarName = `engram-bridge-${version}.tar.gz`;
  const tarPath = join(artifactsDir, tarName);
  log(`zip not available, falling back to ${tarName}`);
  try {
    execSync(`tar czf "${tarPath}" -C "${stagingDir}" .`, {
      stdio: "pipe",
    });
    log(`created ${tarPath}`);
  } catch {
    fail("Neither zip nor tar is available on this system.");
  }
}

// ── Cleanup ──────────────────────────────────────────────────

rmSync(stagingDir, { recursive: true, force: true });

// Report size
if (existsSync(zipPath)) {
  const stat = readFileSync(zipPath);
  const kb = Math.round(stat.length / 1024);
  console.log(`\n  done: ${zipPath} (${kb} KB)`);
  console.log(`\n  Users extract with:`);
  console.log(`    unzip ${zipName} -d ~/.openclaw/extensions/engram-bridge\n`);
}
