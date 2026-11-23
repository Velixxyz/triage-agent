// Local manifest validator — the checks `forge lint` would run, minus the
// parts that need a Forge login (lint requires auth; this does not).
// Run via `npm test`.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";

const root = new URL("..", import.meta.url).pathname;
const manifest = parseYaml(readFileSync(`${root}/manifest.yml`, "utf8"));
const indexSrc = readFileSync(`${root}/src/index.js`, "utf8");

const modules = manifest.modules || {};
const actions = Object.fromEntries((modules.action || []).map((a) => [a.key, a]));
const functions = Object.fromEntries((modules.function || []).map((f) => [f.key, f]));
const skills = Object.fromEntries((modules["rovo:skill"] || []).map((s) => [s.key, s]));
const agents = modules["rovo:agent"] || [];
const mcps = modules["rovo:mcp"] || [];

test("manifest parses and has app id + runtime", () => {
  assert.match(manifest.app.id, /^ari:cloud:ecosystem::app\/[0-9a-f-]{36}$/);
  assert.equal(manifest.app.runtime.name, "nodejs24.x");
});

test("all module keys match the required pattern", () => {
  const keys = [
    ...agents.map((a) => a.key),
    ...mcps.map((m) => m.key),
    ...Object.keys(actions),
    ...Object.keys(functions),
    ...Object.keys(skills),
  ];
  for (const k of keys) assert.match(k, /^[a-zA-Z0-9_-]+$/, `bad key: ${k}`);
});

test("agent references resolve: actions, skills, prompt resource", () => {
  assert.equal(agents.length, 1);
  const agent = agents[0];
  assert.ok(agent.name.length <= 30, "agent name must be <= 30 chars");
  for (const key of agent.actions) assert.ok(actions[key], `agent action missing: ${key}`);
  for (const key of agent.skills) assert.ok(skills[key], `agent skill missing: ${key}`);
  const m = String(agent.prompt).match(/^resource:([^;]+);(.+)$/);
  assert.ok(m, "prompt must be a resource reference");
  const resKey = (manifest.resources || []).find((r) => r.key === m[1]);
  assert.ok(resKey, `prompt resource missing: ${m[1]}`);
  assert.ok(existsSync(`${root}/${resKey.path}/${m[2]}`), `prompt file missing: ${resKey.path}/${m[2]}`);
});

test("every action has a function with a matching exported handler", () => {
  for (const [key, a] of Object.entries(actions)) {
    assert.ok(functions[a.function], `action ${key} references missing function ${a.function}`);
    const handler = functions[a.function].handler;
    assert.match(handler, /^index\.[A-Za-z]+$/);
    const fnName = handler.split(".")[1];
    assert.ok(new RegExp(`export async function ${fnName}\\b`).test(indexSrc), `handler missing in src/index.js: ${fnName}`);
    assert.ok(["GET", "CREATE", "UPDATE", "DELETE", "TRIGGER"].includes(a.actionVerb), `bad actionVerb: ${a.actionVerb}`);
    assert.ok(typeof a.description === "string" && a.description.length > 0, `action ${key} needs a description`);
    assert.ok(a.inputs && typeof a.inputs === "object", `action ${key} needs inputs`);
    for (const [name, input] of Object.entries(a.inputs)) {
      assert.ok(input.title, `input ${key}.${name} needs title`);
      assert.ok(["string", "integer", "number", "boolean"].includes(input.type), `input ${key}.${name} bad type`);
      assert.equal(typeof input.required, "boolean", `input ${key}.${name} required must be boolean`);
      assert.ok(input.description, `input ${key}.${name} needs description`);
    }
  }
});

test("at most one rovo:mcp module; tools are existing read-only actions", () => {
  assert.ok(mcps.length <= 1, "an app can have at most one rovo:mcp module");
  if (mcps.length === 0) return;
  const mcp = mcps[0];
  assert.ok(mcp.name.length <= 30, "MCP name must be <= 30 chars");
  assert.ok(Array.isArray(mcp.tools) && mcp.tools.length > 0);
  for (const key of mcp.tools) {
    assert.ok(actions[key], `MCP tool missing: ${key}`);
    assert.notEqual(actions[key].actionVerb, "UPDATE", `write action ${key} must not be an MCP tool`);
    assert.ok(key.length < 64, "MCP tool key must be under 64 chars");
  }
  assert.ok(mcp.tools.length <= 50);
});

test("skills: source dir + SKILL.md frontmatter + tool dependencies resolve", () => {
  for (const [key, skill] of Object.entries(skills)) {
    const dir = skill.source?.dir;
    assert.ok(dir, `skill ${key} needs source.dir`);
    assert.ok(existsSync(`${root}/${dir}/SKILL.md`), `skill ${key} missing SKILL.md`);
    const raw = readFileSync(`${root}/${dir}/SKILL.md`, "utf8");
    const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(fm, `skill ${key} SKILL.md needs YAML frontmatter`);
    const front = parseYaml(fm[1]);
    const dirName = dir.split("/").pop();
    assert.equal(front.name, dirName, `skill name must match directory: ${dirName}`);
    assert.match(front.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(front.description && front.description.length >= 50 && front.description.length <= 1024, "skill description must be 50-1024 chars");
    const body = raw.slice(fm[0].length);
    assert.ok(body.split("\n").length <= 500, "SKILL.md body must be <= 500 lines");
    const deps = skill.dependencies?.tools || [];
    for (const tool of deps) assert.ok(actions[tool], `skill ${key} dependency missing: ${tool}`);
    if (front["allowed-tools"]) {
      const allowed = String(front["allowed-tools"]).split(/\s+/).filter(Boolean);
      for (const tool of deps) assert.ok(allowed.includes(tool), `allowed-tools must include dependency ${tool}`);
    }
  }
});

test("scopes cover everything the actions call", () => {
  const scopes = new Set(manifest.permissions?.scopes || []);
  for (const s of ["read:jira-work", "read:jira-user", "write:jira-work"]) {
    assert.ok(scopes.has(s), `missing scope: ${s}`);
  }
  for (const s of [
    "read:graph:issue:jira",
    "read:graph:issue-status:jira",
    "read:graph:issue-comment:jira",
    "read:graph:user:atlassian",
    "read:graph:team:atlassian",
  ]) {
    assert.ok(scopes.has(s), `missing Teamwork Graph scope: ${s}`);
  }
  assert.ok(scopes.size <= 50, "Forge caps an app at 50 scopes");
});

test("every function module key is used by at least one action", () => {
  const used = new Set(Object.values(actions).map((a) => a.function));
  for (const key of Object.keys(functions)) assert.ok(used.has(key), `unused function: ${key}`);
});
