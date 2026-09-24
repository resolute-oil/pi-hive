// Regression tests for the bug where `tools:` as a YAML list in agent
// frontmatter reaches `normalizeTools` / `normalizeWorkerTools` and the
// function calls `.split(",")` on the array — `tools || fallback` is
// truthy when `tools` is an array, so `.split` throws
// `TypeError: tools.split is not a function`.
//
// Pre-fix behavior: an agent with `tools: [read, grep, find, ls, bash,
// team_conversation]` in its .md frontmatter (a valid YAML list) would
// parse to an array at the YAML boundary, propagate through
// `AgentConfig.tools` as `runtime.config.tools`, and reach
// `normalizeWorkerTools` in `src/engine/dispatch.ts:256` as an array.
// The function's `(tools || fallback || "...").split(",")` would then
// throw `TypeError`. The dispatch flow would never reach
// `createSession`.
//
// Post-fix behavior: both functions accept `string | string[] | undefined`
// for the tools arg and `string | string[]` for the fallback. They route
// through `normalizeStringList` (which already accepts both shapes) and
// return the same comma-separated string the original string path
// produced. Behavior for string inputs is unchanged; arrays are now
// handled without throwing.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeStringList,
  normalizeTools,
  normalizeWorkerTools,
} from "../src/core/normalize.ts";

// ── normalizeTools: string inputs (unchanged behavior) ────────────────────

test("normalizeTools: string input — split on commas, trim, drop empties", () => {
  assert.equal(normalizeTools("read, grep , find, ,ls", ""), "read,grep,find,ls");
});

test("normalizeTools: string input — undefined falls through to fallback", () => {
  assert.equal(normalizeTools(undefined, "read,grep"), "read,grep");
});

test("normalizeTools: string input — undefined and empty fallback uses built-in default", () => {
  assert.equal(normalizeTools(undefined, ""), "read,grep,find,ls");
});

// ── normalizeTools: array inputs (the regression) ─────────────────────────

test("normalizeTools: array input — stringified as comma-joined list", () => {
  assert.equal(
    normalizeTools(["read", "grep", "find", "ls", "bash", "team_conversation"], ""),
    "read,grep,find,ls,bash,team_conversation",
  );
});

test("normalizeTools: array input — each element trimmed of whitespace", () => {
  assert.equal(normalizeTools([" read ", "grep", " find"], ""), "read,grep,find");
});

test("normalizeTools: array input — empty strings filtered out", () => {
  assert.equal(normalizeTools(["read", "", "grep", "  "], ""), "read,grep");
});

test("normalizeTools: array input — does not throw TypeError on .split", () => {
  // The exact symptom from the bug report: passing an array used to throw
  // `TypeError: tools.split is not a function` because
  // `tools || fallback` returns the array (truthy) and `.split(",")` is
  // called on it.
  assert.doesNotThrow(() => normalizeTools(["read", "grep"], ""));
});

test("normalizeTools: array fallback — used when tools is undefined", () => {
  assert.equal(
    normalizeTools(undefined, ["read", "grep", "find"]),
    "read,grep,find",
  );
});

test("normalizeTools: array fallback — used when tools is empty string", () => {
  assert.equal(
    normalizeTools("", ["read", "grep"]),
    "read,grep",
  );
});

test("normalizeTools: array fallback — string fallback still works alongside array fallback", () => {
  // Sanity check: passing a string fallback alongside a string tools
  // input is the original path. The widened fallback type must not
  // regress that.
  assert.equal(normalizeTools("read,grep", "find,ls"), "read,grep");
});

// ── normalizeWorkerTools: applies the load_skill filter on both shapes ────

test("normalizeWorkerTools: array input — load_skill filtered out", () => {
  assert.equal(
    normalizeWorkerTools(["read", "grep", "load_skill", "find"], ""),
    "read,grep,find",
  );
});

test("normalizeWorkerTools: string input — load_skill filtered out (unchanged behavior)", () => {
  assert.equal(
    normalizeWorkerTools("read,grep,load_skill,find", ""),
    "read,grep,find",
  );
});

test("normalizeWorkerTools: undefined input — uses fallback and filters load_skill", () => {
  assert.equal(
    normalizeWorkerTools(undefined, ["read", "load_skill", "grep"]),
    "read,grep",
  );
});

// ── Cross-helper sanity: normalizeStringList is what makes this work ──────

test("normalizeStringList: array input returns mapped string array", () => {
  assert.deepEqual(normalizeStringList(["a", "b", "c"]), ["a", "b", "c"]);
});

test("normalizeStringList: string input splits on commas and trims", () => {
  assert.deepEqual(normalizeStringList("a, b ,c"), ["a", "b", "c"]);
});
