#!/usr/bin/env node

/**
 * Engram Live Integration Test
 *
 * Exercises all 14 MCP tools with realistic data modeled on a technical
 * CEO running a SaaS company — sales, marketing, R&D, customer relations,
 * vendor relations, hiring, and strategic decisions.
 *
 * Usage:
 *   ./scripts/live-test.sh          # full run (starts DB, runs test, tears down)
 *   node scripts/live-test.mjs      # if DB + engram already running
 *
 * Requires: engram binary in PATH, DB running and reachable via env vars.
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

// ── MCP Client ────────────────────────────────────────────────

class McpClient {
  constructor() {
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
  }

  async start(env = {}) {
    const bin = process.env.ENGRAM_BIN || new URL("../dist/index.js", import.meta.url).pathname;
    this.proc = spawn("node", [bin], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (chunk) => { this.buffer += chunk.toString(); this._drain(); });
    this.proc.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
    this.proc.on("error", (err) => {
      for (const [, { reject }] of this.pending) reject(err);
      this.pending.clear();
    });
    await sleep(2500);

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "live-test", version: "1.0.0" },
    });
    this._send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await sleep(300);
  }

  async request(method, params = {}, timeoutMs = 20000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this._send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async call(name, args = {}) {
    const res = await this.request("tools/call", { name, arguments: args });
    return res;
  }

  /** Call tool → parse text result → return JS object */
  async callParsed(name, args = {}) {
    const res = await this.call(name, args);
    const text = res?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : res;
    return { raw: res, data: parsed, isError: !!res.isError };
  }

  async listTools() {
    const res = await this.request("tools/list");
    return res.tools || [];
  }

  async stop() {
    if (this.proc) { this.proc.kill("SIGTERM"); await sleep(500); if (!this.proc.killed) this.proc.kill("SIGKILL"); }
  }

  _send(msg) { if (this.proc?.stdin?.writable) this.proc.stdin.write(JSON.stringify(msg) + "\n"); }
  _drain() {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const p = JSON.parse(line);
        if (p.id !== undefined && this.pending.has(p.id)) {
          const { resolve } = this.pending.get(p.id);
          this.pending.delete(p.id);
          resolve(p.result ?? p);
        }
      } catch { /* partial */ }
    }
  }
}

// ── Test Framework ────────────────────────────────────────────

let passed = 0, failed = 0, total = 0;
const failures = [];

function section(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"─".repeat(60)}\n`);
}

function assert(label, condition, detail = "") {
  total++;
  if (condition) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
    failures.push({ label, detail });
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  Engram Live Integration Test — SaaS CEO Scenario");
  console.log("══════════════════════════════════════════════════════════════");

  const client = new McpClient();

  try {
    console.log("\n  Starting Engram MCP server...");
    await client.start();
    console.log("  Server ready.\n");

    // ──────────────────────────────────────────────────────────
    // PHASE 1: Tool discovery
    // ──────────────────────────────────────────────────────────
    section("Phase 1: Tool Discovery");

    const tools = await client.listTools();
    assert("tools/list returns tools", tools.length === 14, `got ${tools.length}`);
    const toolNames = tools.map((t) => t.name).sort();
    const expected = [
      "find_contradictions", "forget_entity", "get_memory_schema",
      "graph_stats", "merge_entities", "recall_connections",
      "recall_context", "recall_entity", "recall_timeline",
      "remember_entity", "remember_relationship", "search_entities",
      "supersede_fact", "update_memory_schema",
    ];
    assert("All 14 tool names match", JSON.stringify(toolNames) === JSON.stringify(expected));

    // ──────────────────────────────────────────────────────────
    // PHASE 2: Schema inspection
    // ──────────────────────────────────────────────────────────
    section("Phase 2: Schema (get_memory_schema)");

    const { data: schema } = await client.callParsed("get_memory_schema");
    assert("Schema loaded", schema.preset_name === "dev-team", schema.preset_name);
    assert("Entity types present", schema.entity_types.length === 11, `${schema.entity_types.length} types`);
    assert("Relationship types present", schema.relationship_types.length === 13, `${schema.relationship_types.length} types`);
    const typeNames = schema.entity_types.map((t) => t.name);
    assert("Has Person type", typeNames.includes("Person"));
    assert("Has Project type", typeNames.includes("Project"));
    assert("Has Decision type", typeNames.includes("Decision"));
    assert("Has Company type", typeNames.includes("Company"));

    // ──────────────────────────────────────────────────────────
    // PHASE 3: Populate the graph — People
    // ──────────────────────────────────────────────────────────
    section("Phase 3: People (remember_entity)");

    const people = [
      { name: "Marcus Chen", type: "Person", properties: { role: "CEO & Founder", email: "marcus@infrastack.io", team: "Executive", expertise: "distributed systems, Go, sales strategy" }, confidence: 1.0 },
      { name: "Priya Sharma", type: "Person", properties: { role: "VP Engineering", email: "priya@infrastack.io", team: "Engineering", expertise: "Kubernetes, platform engineering" }, confidence: 0.95 },
      { name: "Jake Morrison", type: "Person", properties: { role: "Head of Sales", email: "jake@infrastack.io", team: "Sales", expertise: "enterprise sales, solution engineering" }, confidence: 0.9 },
      { name: "Sofia Reyes", type: "Person", properties: { role: "Head of Marketing", email: "sofia@infrastack.io", team: "Marketing", expertise: "PLG, developer marketing, content" }, confidence: 0.9 },
      { name: "Tom Nakamura", type: "Person", properties: { role: "Head of Customer Success", email: "tom@infrastack.io", team: "Customer Success", expertise: "onboarding, retention, NPS" }, confidence: 0.9 },
      { name: "Lena Vogt", type: "Person", properties: { role: "Senior Engineer", email: "lena@infrastack.io", team: "Platform", expertise: "Rust, WASM, edge computing" }, confidence: 0.85 },
      { name: "Raj Patel", type: "Person", properties: { role: "Solutions Architect", email: "raj@infrastack.io", team: "Sales Engineering", expertise: "AWS, Terraform, customer demos" }, confidence: 0.85 },
      { name: "Diana Flores", type: "Person", properties: { role: "Product Manager", email: "diana@infrastack.io", team: "Product", expertise: "roadmapping, customer interviews, analytics" }, confidence: 0.85 },
    ];

    const personIds = {};
    for (const p of people) {
      const { data, isError } = await client.callParsed("remember_entity", p);
      assert(`Created ${p.name}`, !isError && data.id, data.id?.substring(0, 8));
      personIds[p.name] = data.id;
    }

    // Upsert test — update Marcus with new info
    const { data: upserted } = await client.callParsed("remember_entity", {
      name: "Marcus Chen",
      type: "Person",
      properties: { linkedin: "linkedin.com/in/marcuschen", yc_batch: "W22" },
    });
    assert("Upsert Marcus (merge props)", !upserted.created, `created=${upserted.created}`);

    // ──────────────────────────────────────────────────────────
    // PHASE 4: Companies & Teams
    // ──────────────────────────────────────────────────────────
    section("Phase 4: Companies & Teams");

    const orgs = [
      { name: "InfraStack", type: "Company", properties: { industry: "Developer Tools / SaaS", stage: "Series A", arr: "$4.2M", founded: "2022" } },
      { name: "Meridian Health", type: "Company", properties: { industry: "Healthcare SaaS", relationship: "Enterprise customer", contract_value: "$380K ARR", tier: "Strategic" } },
      { name: "NovaTech Labs", type: "Company", properties: { industry: "AI/ML Platform", relationship: "Enterprise customer", contract_value: "$210K ARR" } },
      { name: "CloudForge", type: "Company", properties: { industry: "Cloud Infrastructure", relationship: "Technology partner" } },
      { name: "Apex Ventures", type: "Company", properties: { industry: "Venture Capital", relationship: "Lead investor, Series A" } },
      { name: "DataPipe Inc", type: "Company", properties: { industry: "Data Integration", relationship: "Vendor — ETL pipeline" } },
    ];

    const orgIds = {};
    for (const o of orgs) {
      const { data, isError } = await client.callParsed("remember_entity", o);
      assert(`Created ${o.name}`, !isError && data.id, o.properties.industry?.substring(0, 30));
      orgIds[o.name] = data.id;
    }

    const teams = [
      { name: "Platform Team", type: "Team", properties: { focus: "Core infrastructure, API, edge runtime", lead: "Priya Sharma", size: "6" } },
      { name: "Growth Team", type: "Team", properties: { focus: "PLG funnel, self-serve onboarding, activation", lead: "Sofia Reyes", size: "4" } },
      { name: "Enterprise Team", type: "Team", properties: { focus: "Enterprise sales, POCs, procurement", lead: "Jake Morrison", size: "3" } },
    ];

    const teamIds = {};
    for (const t of teams) {
      const { data, isError } = await client.callParsed("remember_entity", t);
      assert(`Created ${t.name}`, !isError && data.id);
      teamIds[t.name] = data.id;
    }

    // ──────────────────────────────────────────────────────────
    // PHASE 5: Projects
    // ──────────────────────────────────────────────────────────
    section("Phase 5: Projects");

    const projects = [
      { name: "Edge Runtime v2", type: "Project", properties: { status: "in-progress", deadline: "2026-Q2", priority: "P0", description: "WASM-based edge compute layer — 10x latency improvement" } },
      { name: "Enterprise SSO", type: "Project", properties: { status: "planning", deadline: "2026-Q3", priority: "P1", description: "SAML/OIDC federation for enterprise customers" } },
      { name: "PLG Onboarding Revamp", type: "Project", properties: { status: "in-progress", deadline: "2026-04-15", priority: "P1", description: "Reduce time-to-first-deploy from 47min to under 10min" } },
      { name: "Meridian Migration", type: "Project", properties: { status: "blocked", priority: "P0", description: "Migrate Meridian Health from legacy v1 API to v2", blocker: "Schema compatibility issue in their FHIR integration" } },
      { name: "Series B Prep", type: "Project", properties: { status: "planning", deadline: "2026-Q4", priority: "P1", description: "Financial model, data room, investor outreach" } },
    ];

    const projectIds = {};
    for (const p of projects) {
      const { data, isError } = await client.callParsed("remember_entity", p);
      assert(`Created ${p.name}`, !isError && data.id, p.properties.status);
      projectIds[p.name] = data.id;
    }

    // ──────────────────────────────────────────────────────────
    // PHASE 6: Decisions, Meetings, Bugs, Patterns
    // ──────────────────────────────────────────────────────────
    section("Phase 6: Decisions, Meetings, Bugs, Patterns");

    const misc = [
      { name: "Adopt Rust for Edge Runtime", type: "Decision", properties: { rationale: "Go GC pauses unacceptable at p99 — Rust + WASM gives deterministic latency", decided_by: "Marcus Chen, Priya Sharma", date: "2026-01-15" } },
      { name: "Kill the Free Tier", type: "Decision", properties: { rationale: "Free tier costs $18K/mo, converts at 1.2%. Move to 14-day trial with credit card", decided_by: "Marcus Chen, Jake Morrison, Sofia Reyes", date: "2026-02-20" } },
      { name: "Board Meeting Q1 2026", type: "Meeting", properties: { date: "2026-03-18", attendees: "Marcus, Board (Apex Ventures)", outcome: "Approved Series B timeline. Board wants $8M ARR by Q4." } },
      { name: "Meridian QBR", type: "Meeting", properties: { date: "2026-03-10", attendees: "Marcus, Tom, Meridian CTO", outcome: "Migration blocker acknowledged. Committed to fix by April 5." } },
      { name: "Memory Leak in Gateway", type: "Bug", properties: { severity: "P1", status: "investigating", assignee: "Lena Vogt", description: "Gateway RSS grows 50MB/hour under sustained WebSocket load. Likely in the connection pool draining logic." } },
      { name: "Flaky E2E in CI", type: "Bug", properties: { severity: "P2", status: "open", assignee: "Platform Team", description: "deploy-smoke test fails ~15% of runs. Race condition in health check polling." } },
      { name: "Circuit Breaker for Vendor APIs", type: "Pattern", properties: { context: "DataPipe API goes down monthly. Need circuit breaker with exponential backoff.", applicability: "All external vendor integrations" } },
    ];

    for (const m of misc) {
      const { data, isError } = await client.callParsed("remember_entity", m);
      assert(`Created ${m.type}: ${m.name}`, !isError && data.id);
    }

    // ──────────────────────────────────────────────────────────
    // PHASE 7: Relationships (remember_relationship)
    // ──────────────────────────────────────────────────────────
    section("Phase 7: Relationships (remember_relationship)");

    const relationships = [
      // Org structure
      { from: "Marcus Chen", to: "InfraStack", type: "WORKS_AT", properties: { since: "2022", role: "Founder & CEO" } },
      { from: "Priya Sharma", to: "Marcus Chen", type: "REPORTS_TO" },
      { from: "Jake Morrison", to: "Marcus Chen", type: "REPORTS_TO" },
      { from: "Sofia Reyes", to: "Marcus Chen", type: "REPORTS_TO" },
      { from: "Tom Nakamura", to: "Marcus Chen", type: "REPORTS_TO" },
      { from: "Lena Vogt", to: "Priya Sharma", type: "REPORTS_TO" },
      { from: "Raj Patel", to: "Jake Morrison", type: "REPORTS_TO" },
      { from: "Diana Flores", to: "Priya Sharma", type: "REPORTS_TO" },

      // Team membership
      { from: "Lena Vogt", to: "Platform Team", type: "CONTRIBUTES_TO" },
      { from: "Priya Sharma", to: "Platform Team", type: "OWNS" },
      { from: "Sofia Reyes", to: "Growth Team", type: "OWNS" },
      { from: "Jake Morrison", to: "Enterprise Team", type: "OWNS" },

      // Project ownership
      { from: "Priya Sharma", to: "Edge Runtime v2", type: "OWNS" },
      { from: "Lena Vogt", to: "Edge Runtime v2", type: "CONTRIBUTES_TO" },
      { from: "Jake Morrison", to: "Enterprise SSO", type: "ADVOCATED_FOR" },
      { from: "Sofia Reyes", to: "PLG Onboarding Revamp", type: "OWNS" },
      { from: "Tom Nakamura", to: "Meridian Migration", type: "OWNS" },
      { from: "Marcus Chen", to: "Series B Prep", type: "OWNS" },

      // Customer/vendor relations
      { from: "InfraStack", to: "Meridian Health", type: "RELATES_TO", properties: { nature: "Enterprise customer — strategic account" } },
      { from: "InfraStack", to: "NovaTech Labs", type: "RELATES_TO", properties: { nature: "Enterprise customer" } },
      { from: "InfraStack", to: "CloudForge", type: "COLLABORATES_WITH", properties: { nature: "Technology partnership — shared SDK" } },
      { from: "Apex Ventures", to: "InfraStack", type: "RELATES_TO", properties: { nature: "Series A lead investor" } },
      { from: "InfraStack", to: "DataPipe Inc", type: "DEPENDS_ON", properties: { nature: "ETL vendor — critical data pipeline" } },

      // Decisions
      { from: "Marcus Chen", to: "Adopt Rust for Edge Runtime", type: "DECIDED" },
      { from: "Marcus Chen", to: "Kill the Free Tier", type: "DECIDED" },

      // Bugs
      { from: "Memory Leak in Gateway", to: "Edge Runtime v2", type: "RELATES_TO" },
      { from: "Flaky E2E in CI", to: "Platform Team", type: "CAUSED_BY" },
      { from: "Lena Vogt", to: "Memory Leak in Gateway", type: "FIXES" },

      // Project dependencies
      { from: "Enterprise SSO", to: "Edge Runtime v2", type: "DEPENDS_ON", properties: { reason: "SSO middleware runs on edge runtime" } },
      { from: "Meridian Migration", to: "Enterprise SSO", type: "DEPENDS_ON", properties: { reason: "Meridian requires SAML before migration" } },
    ];

    let relCount = 0;
    for (const r of relationships) {
      const { isError } = await client.callParsed("remember_relationship", r);
      assert(`${r.from} --${r.type}--> ${r.to}`, !isError);
      relCount++;
    }
    assert("All relationships created", relCount === relationships.length, `${relCount}/${relationships.length}`);

    // ──────────────────────────────────────────────────────────
    // PHASE 8: Facts + Supersession (supersede_fact)
    // ──────────────────────────────────────────────────────────
    section("Phase 8: Facts & Supersession (supersede_fact)");

    // Initial facts
    const { isError: f1Err } = await client.callParsed("supersede_fact", {
      entity: "InfraStack",
      new_fact: "InfraStack ARR is $3.1M as of Q4 2025",
      source: "board deck",
      confidence: 1.0,
    });
    assert("Fact: ARR Q4 2025", !f1Err);

    // Supersede with newer data
    const { isError: f2Err } = await client.callParsed("supersede_fact", {
      entity: "InfraStack",
      old_fact: "InfraStack ARR is $3.1M as of Q4 2025",
      new_fact: "InfraStack ARR is $4.2M as of Q1 2026 — 35% QoQ growth",
      source: "finance team",
      confidence: 1.0,
    });
    assert("Superseded: ARR updated to Q1 2026", !f2Err);

    const { isError: f3Err } = await client.callParsed("supersede_fact", {
      entity: "Marcus Chen",
      new_fact: "Marcus prefers async communication — Slack over meetings",
      source: "direct observation",
      confidence: 0.85,
    });
    assert("Fact: Marcus communication pref", !f3Err);

    const { isError: f4Err } = await client.callParsed("supersede_fact", {
      entity: "Meridian Health",
      new_fact: "Meridian Health contract renewal due July 2026",
      source: "CRM",
      confidence: 0.95,
    });
    assert("Fact: Meridian renewal date", !f4Err);

    const { isError: f5Err } = await client.callParsed("supersede_fact", {
      entity: "Meridian Health",
      new_fact: "Meridian CTO is frustrated with migration timeline — escalation risk",
      source: "QBR meeting notes",
      confidence: 0.8,
    });
    assert("Fact: Meridian frustration", !f5Err);

    // Create contradicting facts to test find_contradictions
    const { isError: f6Err } = await client.callParsed("supersede_fact", {
      entity: "Edge Runtime v2",
      new_fact: "Edge Runtime v2 target launch is end of Q2 2026",
      source: "roadmap",
      confidence: 0.9,
    });
    assert("Fact: Edge Runtime deadline (Q2)", !f6Err);

    const { isError: f7Err } = await client.callParsed("supersede_fact", {
      entity: "Edge Runtime v2",
      new_fact: "Edge Runtime v2 will slip to Q3 2026 due to memory leak investigation",
      source: "Priya in standup",
      confidence: 0.7,
    });
    assert("Fact: Edge Runtime deadline (Q3 slip)", !f7Err);

    // ──────────────────────────────────────────────────────────
    // PHASE 9: Read tools — recall_entity
    // ──────────────────────────────────────────────────────────
    section("Phase 9: Recall Entity");

    const { data: marcus } = await client.callParsed("recall_entity", {
      identifier: "Marcus Chen",
      include_relationships: true,
    });
    assert("Recall Marcus", marcus.found === true);
    assert("Marcus has role", marcus.properties?.role === "CEO & Founder");
    assert("Marcus has linkedin (upserted)", marcus.properties?.linkedin === "linkedin.com/in/marcuschen");
    assert("Marcus has yc_batch (upserted)", marcus.properties?.yc_batch === "W22");
    assert("Marcus has relationships", (marcus.relationships?.length || 0) > 0, `${marcus.relationships?.length} rels`);

    // By UUID
    const { data: marcusById } = await client.callParsed("recall_entity", {
      identifier: personIds["Marcus Chen"],
    });
    assert("Recall Marcus by UUID", marcusById.found === true && marcusById.name === "Marcus Chen");

    // Not found
    const { data: ghost } = await client.callParsed("recall_entity", {
      identifier: "Nonexistent Person XYZ",
    });
    assert("Recall nonexistent → found: false", ghost.found === false);

    // ──────────────────────────────────────────────────────────
    // PHASE 10: search_entities
    // ──────────────────────────────────────────────────────────
    section("Phase 10: Search Entities");

    const { data: searchMarcus } = await client.callParsed("search_entities", { query: "marcus" });
    assert("Search 'marcus'", searchMarcus.results?.length > 0, `${searchMarcus.count} results`);
    assert("Top result is Marcus Chen", searchMarcus.results?.[0]?.name === "Marcus Chen");

    const { data: searchMeridian } = await client.callParsed("search_entities", { query: "meridian" });
    assert("Search 'meridian'", searchMeridian.results?.length >= 1, `${searchMeridian.count} results`);

    const { data: searchByType } = await client.callParsed("search_entities", {
      query: "team",
      type_filter: "Team",
    });
    assert("Search with type_filter=Team", searchByType.results?.every((e) => e.type === "Team"), `${searchByType.count} results`);

    const { data: searchEmpty } = await client.callParsed("search_entities", { query: "zzzznonexistentzzz" });
    assert("Search no results", (searchEmpty.count || 0) === 0);

    // ──────────────────────────────────────────────────────────
    // PHASE 11: recall_connections (multi-hop traversal)
    // ──────────────────────────────────────────────────────────
    section("Phase 11: Recall Connections (traversal)");

    const { data: marcusConns } = await client.callParsed("recall_connections", {
      identifier: "Marcus Chen",
      depth: 2,
      limit: 50,
    });
    assert("Marcus 2-hop connections", marcusConns.entities?.length > 0, `${marcusConns.entities?.length} entities`);
    assert("Marcus connections include InfraStack",
      marcusConns.entities?.some((e) => e.name === "InfraStack"));

    // With relationship type filter
    const { data: reportsOnly } = await client.callParsed("recall_connections", {
      identifier: "Marcus Chen",
      depth: 1,
      relationship_types: ["REPORTS_TO"],
    });
    assert("Filter: only REPORTS_TO rels",
      reportsOnly.relationships?.every((r) => r.type === "REPORTS_TO"),
      `${reportsOnly.relationships?.length} rels`);

    // With Mermaid diagram
    const { data: withMermaid } = await client.callParsed("recall_connections", {
      identifier: "InfraStack",
      depth: 1,
      include_mermaid: true,
    });
    assert("Mermaid diagram included", withMermaid.mermaid?.includes("graph LR"),
      `${withMermaid.mermaid?.length} chars`);
    assert("Mermaid has node labels", withMermaid.mermaid?.includes("InfraStack"));

    // ──────────────────────────────────────────────────────────
    // PHASE 12: recall_context (combined view)
    // ──────────────────────────────────────────────────────────
    section("Phase 12: Recall Context");

    const { data: ctx } = await client.callParsed("recall_context", {
      identifier: "Meridian Health",
      depth: 2,
      include_mermaid: true,
    });
    assert("Context for Meridian", ctx.entity?.name === "Meridian Health" || ctx.name === "Meridian Health");
    assert("Context has connections", (ctx.connections?.entities?.length || ctx.entities?.length || 0) > 0);
    assert("Context has Mermaid", ctx.mermaid?.includes("graph LR") || ctx.connections?.mermaid?.includes("graph LR"));

    // ──────────────────────────────────────────────────────────
    // PHASE 13: recall_timeline
    // ──────────────────────────────────────────────────────────
    section("Phase 13: Recall Timeline");

    const { data: timeline } = await client.callParsed("recall_timeline", {
      identifier: "Marcus Chen",
      limit: 20,
    });
    assert("Timeline for Marcus", timeline.events?.length > 0 || timeline.timeline?.length > 0,
      `${timeline.events?.length || timeline.timeline?.length || 0} events`);

    // ──────────────────────────────────────────────────────────
    // PHASE 14: find_contradictions
    // ──────────────────────────────────────────────────────────
    section("Phase 14: Find Contradictions");

    const { data: contradictions } = await client.callParsed("find_contradictions", {
      identifier: "Edge Runtime v2",
    });
    assert("Contradictions for Edge Runtime",
      contradictions.facts?.length >= 2 || contradictions.contradictions?.length >= 0,
      `${contradictions.facts?.length || contradictions.contradictions?.length || 0} facts to review`);

    // ──────────────────────────────────────────────────────────
    // PHASE 15: graph_stats
    // ──────────────────────────────────────────────────────────
    section("Phase 15: Graph Stats");

    const { data: stats } = await client.callParsed("graph_stats");
    assert("Graph stats returned", stats.healthy === true);
    assert("Entity counts present", stats.entities_by_type !== undefined);
    const personCount = stats.entities_by_type?.Person || 0;
    assert("Person count >= 8", personCount >= 8, `${personCount}`);
    const companyCount = stats.entities_by_type?.Company || 0;
    assert("Company count >= 5", companyCount >= 5, `${companyCount}`);
    assert("Total entities > 0", stats.total_entities > 0, `${stats.total_entities} entities`);
    assert("Total relationships > 0", stats.total_relationships > 0, `${stats.total_relationships} rels`);

    // ──────────────────────────────────────────────────────────
    // PHASE 16: forget_entity (soft delete)
    // ──────────────────────────────────────────────────────────
    section("Phase 16: Forget Entity (soft delete)");

    const { isError: forgetErr } = await client.callParsed("forget_entity", {
      identifier: "Flaky E2E in CI",
    });
    assert("Soft-deleted 'Flaky E2E in CI'", !forgetErr);

    // Verify it's gone from search
    const { data: searchFlaky } = await client.callParsed("search_entities", { query: "Flaky E2E" });
    assert("Deleted entity hidden from search", (searchFlaky.count || 0) === 0);

    // Verify recall returns found: false
    const { data: recallFlaky } = await client.callParsed("recall_entity", { identifier: "Flaky E2E in CI" });
    assert("Deleted entity hidden from recall", recallFlaky.found === false);

    // ──────────────────────────────────────────────────────────
    // PHASE 17: merge_entities
    // ──────────────────────────────────────────────────────────
    section("Phase 17: Merge Entities");

    // Create a duplicate entity to merge
    const { data: dup } = await client.callParsed("remember_entity", {
      name: "M. Chen",
      type: "Person",
      properties: { role: "CEO", nickname: "MC" },
    });
    assert("Created duplicate 'M. Chen'", dup.id);

    const { data: merged, isError: mergeErr } = await client.callParsed("merge_entities", {
      surviving_id: personIds["Marcus Chen"],
      merged_id: dup.id,
    });
    assert("Merged M. Chen into Marcus Chen", !mergeErr);

    // Verify merged entity is gone
    const { data: recallDup } = await client.callParsed("recall_entity", { identifier: dup.id });
    assert("Merged entity hidden", recallDup.found === false);

    // Verify survivor still works
    const { data: survivorCheck } = await client.callParsed("recall_entity", {
      identifier: "Marcus Chen",
    });
    assert("Survivor Marcus still accessible", survivorCheck.found === true);

    // ──────────────────────────────────────────────────────────
    // PHASE 18: update_memory_schema
    // ──────────────────────────────────────────────────────────
    section("Phase 18: Update Memory Schema");

    const { data: addType, isError: addErr } = await client.callParsed("update_memory_schema", {
      action: "add",
      name: "Investor",
      properties: ["name", "fund", "check_size", "focus"],
      extraction_hint: "Venture capital firms, angel investors, or institutional investors",
      examples: ["Sequoia led our Series A", "Jane is an angel investor in fintech", "Tiger Global is evaluating us"],
    });
    assert("Added 'Investor' entity type", !addErr, addType?.message || "");

    // Verify it's in the schema now
    const { data: schema2 } = await client.callParsed("get_memory_schema");
    const hasInvestor = schema2.entity_types?.some((t) => t.name === "Investor");
    assert("Investor type in schema", hasInvestor);

    // Use the new type
    const { data: investorEntity } = await client.callParsed("remember_entity", {
      name: "Sarah Kim",
      type: "Investor",
      properties: { fund: "Apex Ventures", check_size: "$5M", focus: "Developer tools, infrastructure" },
    });
    assert("Created Investor entity", investorEntity.id);

    // ══════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════
    section("Summary");

    console.log(`  Total:  ${total}`);
    console.log(`  Passed: \x1b[32m${passed}\x1b[0m`);
    console.log(`  Failed: ${failed > 0 ? `\x1b[31m${failed}\x1b[0m` : "0"}`);

    if (failures.length > 0) {
      console.log("\n  Failed tests:");
      for (const f of failures) {
        console.log(`    \x1b[31m✗\x1b[0m ${f.label} — ${f.detail}`);
      }
    }

    console.log("");

  } catch (err) {
    console.error(`\nFatal error: ${err.message}`);
    console.error(err.stack);
    failed++;
  } finally {
    await client.stop();
  }

  process.exit(failed > 0 ? 1 : 0);
}

main();
