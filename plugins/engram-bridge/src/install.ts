#!/usr/bin/env node

/**
 * engram-bridge install CLI
 *
 * Copies the plugin into OpenClaw's extensions directory and installs
 * runtime dependencies. Defaults to ~/.openclaw/extensions/engram-bridge.
 *
 * Usage:
 *   engram-bridge install
 *   engram-bridge install --installpath /custom/path/engram-bridge
 *   engram-bridge install --cleaninstall
 *   engram-bridge uninstall
 */

import { cpSync, mkdirSync, existsSync, rmSync, readFileSync, lstatSync, realpathSync } from "node:fs";
import { resolve, dirname, join, sep } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PLUGIN_ID = "engram-bridge";

// ── Arg parsing ──────────────────────────────────────────────

interface ParsedArgs {
  command: string;
  installPath: string | null;
  cleanInstall: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // skip node + script
  let command = "";
  let installPath: string | null = null;
  let cleanInstall = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--installpath" && i + 1 < args.length) {
      installPath = args[++i];
    } else if (args[i] === "--cleaninstall") {
      cleanInstall = true;
    } else if (!command && !args[i].startsWith("-")) {
      command = args[i];
    }
  }

  return { command, installPath, cleanInstall };
}

// ── Helpers ──────────────────────────────────────────────────

function log(msg: string): void {
  console.log(`  ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n  error: ${msg}\n`);
  process.exit(1);
}

// ── Safety checks ────────────────────────────────────────────

/** Directories that must never be targets of install/clean/uninstall. */
const BLOCKED_PREFIXES = [
  "/bin", "/sbin", "/usr", "/etc", "/sys", "/proc",
  "/dev", "/boot", "/lib", "/lib64", "/var/run",
  "C:\\Windows", "C:\\Program Files",
];

/**
 * Validate that a directory is safe to write to or remove.
 * Blocks dangerous paths, symlink redirects, and shallow paths.
 */
function validateTargetPath(targetDir: string, operation: string): void {
  const resolved = resolve(targetDir);

  // 1. Minimum depth — block /, /home, /Users, etc.
  const segments = resolved.split(sep).filter(Boolean);
  if (segments.length < 3) {
    fail(
      `${operation} refused: path "${resolved}" is too shallow (${segments.length} segments). ` +
      `Target must be at least 3 levels deep (e.g., ~/.openclaw/extensions/engram-bridge).`
    );
  }

  // 2. Blocked system prefixes
  const lower = resolved.toLowerCase();
  for (const prefix of BLOCKED_PREFIXES) {
    if (lower === prefix.toLowerCase() || lower.startsWith(prefix.toLowerCase() + sep)) {
      fail(`${operation} refused: "${resolved}" is inside system directory "${prefix}".`);
    }
  }

  // 3. Symlink check — if target exists, resolve the real path and ensure
  //    it hasn't been redirected to a different parent directory.
  if (existsSync(resolved)) {
    const stat = lstatSync(resolved);
    if (stat.isSymbolicLink()) {
      const realTarget = realpathSync(resolved);
      const expectedParent = resolve(dirname(resolved));
      const actualParent = dirname(realTarget);
      if (actualParent !== expectedParent) {
        fail(
          `${operation} refused: "${resolved}" is a symlink pointing to "${realTarget}" ` +
          `(outside expected parent "${expectedParent}"). Remove the symlink first.`
        );
      }
    }
  }
}

/**
 * Verify the directory is actually an engram-bridge installation.
 * Reads openclaw.plugin.json and checks the plugin ID matches.
 * This prevents --cleaninstall from nuking unrelated directories.
 */
function verifyPluginIdentity(targetDir: string): void {
  const manifestPath = join(targetDir, "openclaw.plugin.json");

  if (!existsSync(manifestPath)) {
    fail(
      `--cleaninstall refused: no openclaw.plugin.json found in "${targetDir}". ` +
      `This directory does not appear to be an engram-bridge installation.`
    );
  }

  let manifest: { id?: string };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    fail(
      `--cleaninstall refused: openclaw.plugin.json in "${targetDir}" is not valid JSON.`
    );
  }

  if (manifest.id !== PLUGIN_ID) {
    fail(
      `--cleaninstall refused: openclaw.plugin.json has id="${manifest.id}", ` +
      `expected "${PLUGIN_ID}". This is not an engram-bridge installation.`
    );
  }
}

// ── Clean logic ──────────────────────────────────────────────

function cleanTargetDir(targetDir: string): void {
  if (!existsSync(targetDir)) {
    log("target directory does not exist — nothing to clean");
    return;
  }

  // Belt: path safety
  validateTargetPath(targetDir, "clean");

  // Suspenders: identity verification
  verifyPluginIdentity(targetDir);

  log(`cleaning ${targetDir}`);
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
}

// ── Install logic ────────────────────────────────────────────

function install(targetDir: string, cleanInstall: boolean): void {
  // Validate path is safe before any filesystem operations
  validateTargetPath(targetDir, "install");

  // Source is the package root (one level up from dist/)
  const packageRoot = resolve(__dirname, "..");
  const distDir = join(packageRoot, "dist");
  const pluginManifest = join(packageRoot, "openclaw.plugin.json");
  const packageJson = join(packageRoot, "package.json");

  // Validate source files exist
  if (!existsSync(distDir)) {
    fail(`dist/ not found at ${distDir}. Build the plugin first: npm run build`);
  }
  if (!existsSync(pluginManifest)) {
    fail(`openclaw.plugin.json not found at ${pluginManifest}`);
  }

  // Clean install: wipe existing installation first
  if (cleanInstall) {
    cleanTargetDir(targetDir);
  }

  console.log(`\n  Installing engram-bridge to ${targetDir}\n`);

  // Create target directory
  mkdirSync(targetDir, { recursive: true });

  // Copy dist/
  log("copying dist/");
  cpSync(distDir, join(targetDir, "dist"), { recursive: true });

  // Copy openclaw.plugin.json
  log("copying openclaw.plugin.json");
  cpSync(pluginManifest, join(targetDir, "openclaw.plugin.json"));

  // Copy package.json (needed for npm install --production)
  log("copying package.json");
  cpSync(packageJson, join(targetDir, "package.json"));

  // Install production dependencies
  log("installing dependencies (npm install --production)");
  try {
    execSync("npm install --production --ignore-scripts", {
      cwd: targetDir,
      stdio: "pipe",
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString() || "";
    fail(`npm install failed in ${targetDir}:\n${stderr}`);
  }

  // Verify @sinclair/typebox landed
  const typeboxPath = join(targetDir, "node_modules", "@sinclair", "typebox");
  if (!existsSync(typeboxPath)) {
    fail("@sinclair/typebox was not installed. Check npm registry access.");
  }

  console.log(`\n  done. Plugin installed at ${targetDir}`);
  console.log(`\n  Next steps:`);
  console.log(`    1. Add "engram-bridge" to plugins.allow in openclaw.json`);
  console.log(`    2. Add plugin entry to plugins.entries:`);
  console.log(`       "engram-bridge": {`);
  console.log(`         "enabled": true,`);
  console.log(`         "hooks": { "allowPromptInjection": true },`);
  console.log(`         "config": { "command": "engram" }`);
  console.log(`       }`);
  console.log(`    3. Restart the gateway\n`);
}

// ── Uninstall logic ──────────────────────────────────────────

function uninstall(targetDir: string): void {
  if (!existsSync(targetDir)) {
    log(`nothing to remove — ${targetDir} does not exist`);
    return;
  }

  // Belt: path safety
  validateTargetPath(targetDir, "uninstall");

  // Suspenders: identity verification
  verifyPluginIdentity(targetDir);

  console.log(`\n  Removing engram-bridge from ${targetDir}`);
  rmSync(targetDir, { recursive: true, force: true });
  console.log(`  done.\n`);
}

// ── Main ─────────────────────────────────────────────────────

const DEFAULT_DIR = join(homedir(), ".openclaw", "extensions", "engram-bridge");

const { command, installPath, cleanInstall } = parseArgs(process.argv);
const targetDir = installPath ? resolve(installPath) : DEFAULT_DIR;

switch (command) {
  case "install":
    install(targetDir, cleanInstall);
    break;
  case "uninstall":
    if (cleanInstall) {
      fail("--cleaninstall is only valid with the install command.");
    }
    uninstall(targetDir);
    break;
  case "":
    console.log(`
  engram-bridge — OpenClaw plugin installer

  Usage:
    engram-bridge install [--installpath <dir>] [--cleaninstall]
    engram-bridge uninstall [--installpath <dir>]

  Options:
    --installpath <dir>  Override target directory
    --cleaninstall       Wipe existing installation before installing

  Default install path: ${DEFAULT_DIR}
`);
    break;
  default:
    fail(`unknown command: ${command}. Use "install" or "uninstall".`);
}
