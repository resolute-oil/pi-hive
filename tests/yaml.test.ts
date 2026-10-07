import assert from "node:assert/strict";
import { test } from "node:test";
import { findUnquotedColon, parseYamlLite } from "../src/core/yaml.ts";

test("findUnquotedColon ignores colons inside quoted scalars", () => {
  assert.equal(findUnquotedColon('path: value'), 4);
  assert.equal(findUnquotedColon('"inline: context"'), -1);
  assert.equal(findUnquotedColon("'inline: context'"), -1);
  assert.equal(findUnquotedColon('name: "inline: context"'), 4);
});

test("parseYamlLite keeps quoted list items containing colons as strings", () => {
  const parsed = parseYamlLite(`
shared_context:
  - "iMed is HIPAA-regulated: no TODOs, no placeholders"
  - 'Another inline note: still text'
`);

  assert.deepEqual(parsed.shared_context, [
    "iMed is HIPAA-regulated: no TODOs, no placeholders",
    "Another inline note: still text",
  ]);
});

test("parseYamlLite still parses unquoted list mappings", () => {
  const parsed = parseYamlLite(`
context:
  - path: .pi/hive/knowledge/foo.md
    use-when: Always
`);

  assert.deepEqual(parsed.context, [
    { path: ".pi/hive/knowledge/foo.md", useWhen: "Always" },
  ]);
});

test("parseYamlLite parses flow-style mappings", () => {
  const parsed = parseYamlLite(`
a: { cap: 100 }
b: { cost-usd: 0.5 }
c: { include: [a, b] }
d: { tokens: { cap: 1 } }
e: { percent: 35 }
f: {}
g: { cap : 100 , depth : 4 }
h: { hint: "a, b" }
`);

  assert.deepEqual(parsed.a, { cap: 100 });
  assert.deepEqual(parsed.b, { costUsd: 0.5 });
  assert.deepEqual(parsed.c, { include: ["a", "b"] });
  assert.deepEqual(parsed.d, { tokens: { cap: 1 } });
  assert.deepEqual(parsed.e, { percent: 35 });
  assert.deepEqual(parsed.f, {});
  assert.deepEqual(parsed.g, { cap: 100, depth: 4 });
  assert.deepEqual(parsed.h, { hint: "a, b" });
});

test("parseYamlLite handles the user's flow-style budgets config", () => {
  const parsed = parseYamlLite(`
settings:
  subagent-output-limit: 12000
  default-tools: read, grep, find, ls
  budgets:
    defaults-enabled: true
    per-worker:
      runs:      { cap: 100 }
      depth:     { cap: 4 }
      context:   { percent: 35 }
    strategies:
      on-token-exhaustion:   { action: abort }
      on-context-exhaustion: { action: compact }
      summary:               { max-tokens: 5000 }
`);

  assert.equal(typeof parsed.settings.budgets.perWorker.runs, "object");
  assert.deepEqual(parsed.settings.budgets.perWorker.runs, { cap: 100 });
  assert.deepEqual(parsed.settings.budgets.perWorker.context, { percent: 35 });
  assert.deepEqual(parsed.settings.budgets.strategies.summary, { maxTokens: 5000 });
});
