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

test("parseYamlLite rejects duplicate keys with a line-aware path-bearing error", () => {
  // Critical audit finding: pre-fixup parseYamlLite silently overwrote when
  // the same key appeared twice (e.g., the user typed both `subagentOutputLimit: 1`
  // and `subagent-output-limit: 2`). The strict upper-layer validator then
  // rejected the resulting config with an opaque "must be positive integer"
  // error that pointed at the wrong line and hid the real cause. The parser
  // now rejects the duplicate at parse time and names BOTH forms so the user
  // can see immediately that `subagentOutputLimit` and
  // `subagent-output-limit` are the same key to this parser.
  assert.throws(
    () => parseYamlLite("subagentOutputLimit: 1\nsubagent-output-limit: 2\n"),
    /yaml: duplicate key "subagentOutputLimit" \(also written as "subagent-output-limit"\) at line 2/,
    "duplicate keys across kebab/camel spellings surface as a parser error",
  );
  // Same spelling twice (the other common typo) is also caught, with the
  // prior form identical to the new one — the message still includes it so
  // the user knows which prior line to delete.
  assert.throws(
    () => parseYamlLite("foo: 1\nfoo: 2\n"),
    /yaml: duplicate key "foo" \(also written as "foo"\) at line 2/,
    "literal same-spelling duplicates are also rejected",
  );
  // Nested objects are tracked independently — a key in the parent does not
  // collide with the same key in a nested child.
  assert.doesNotThrow(() =>
    parseYamlLite("a:\n  foo: 1\nb:\n  foo: 2\n"),
    "the same key in two separate child objects is not a duplicate",
  );
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
