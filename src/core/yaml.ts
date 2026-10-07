// ── YAML-lite parser ─────────────────────────────────────────────────────────

import type { YamlLine } from "./types";
import type { JsonRecord } from "../shared/telemetry";

export function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && line[i - 1] !== "\\") quote = quote === ch ? null : quote || ch;
    if (ch === "#" && !quote) return line.slice(0, i);
  }
  return line;
}

export function parseScalar(raw: string): any {
  const value = raw.trim();
  if (value === "") return "";
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(",").map((part) => parseScalar(part)) : [];
  }
  if (value.startsWith("{") && value.endsWith("}")) {
    return parseInlineObject(value);
  }
  return value;
}

function findUnquotedComma(text: string): number {
  let quote: string | null = null;
  let bracketDepth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === '"' || ch === "'") && text[i - 1] !== "\\") quote = quote === ch ? null : quote || ch;
    if (quote) continue;
    if (ch === "[" || ch === "{") bracketDepth++;
    else if (ch === "]" || ch === "}") bracketDepth--;
    else if (ch === "," && bracketDepth === 0) return i;
  }
  return -1;
}

function parseInlineObject(raw: string): JsonRecord {
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return {};
  const result: JsonRecord = {};
  let cursor = 0;
  while (cursor <= inner.length) {
    const idx = findUnquotedComma(inner.slice(cursor));
    if (idx < 0) {
      const part = inner.slice(cursor).trim();
      if (part) {
        const [key, value] = parseKeyValue(part);
        result[key] = value;
      }
      break;
    }
    const part = inner.slice(cursor, cursor + idx).trim();
    if (part) {
      const [key, value] = parseKeyValue(part);
      result[key] = value;
    }
    cursor += idx + 1;
  }
  return result;
}

export function findUnquotedColon(text: string): number {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ((ch === '"' || ch === "'") && text[i - 1] !== "\\") quote = quote === ch ? null : quote || ch;
    if (ch === ":" && !quote) return i;
  }
  return -1;
}

export function parseKeyValue(text: string): [string, any, boolean] {
  const idx = findUnquotedColon(text);
  if (idx < 0) return [text.trim(), "", false];
  const rawKey = text.slice(0, idx).trim();
  const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
  const rawValue = text.slice(idx + 1).trim();
  return [key, parseScalar(rawValue), rawValue === ""];
}

// Pull the raw key text (e.g., `subagent-output-limit` or `subagentOutputLimit`)
// out of a `key: value` line. Used only by the duplicate-key detection in
// parseObject/parseArray to surface the prior form in the error message;
// the canonical (camelized) key is what gets stored. Returns the trimmed
// whole text when the line has no colon (defensive — shouldn't reach the
// object parser, but matches parseKeyValue's fallback).
function extractRawKey(text: string): string {
  const idx = findUnquotedColon(text);
  return idx >= 0 ? text.slice(0, idx).trim() : text.trim();
}

// Insert `key` into `obj`, throwing if the same camelized key was already
// seen in this object. The error names BOTH forms (`subagentOutputLimit`
// canonical vs. `subagent-output-limit` original kebab) and the line number
// of the new occurrence so the user can locate it. Duplicate keys collapse
// to the same camel form under parseKeyValue's `-([a-z])` regex, so a user
// who types both spellings of the same key would otherwise get the second
// silently — the audit-flagged "lenient parser, strict upper layer" class.
function setKeyOrThrow(
  obj: JsonRecord,
  key: string,
  rawKey: string,
  value: unknown,
  line: number,
  seen: Map<string, { rawKey: string; line: number }>,
): void {
  const prior = seen.get(key);
  if (prior) {
    // Surface the OTHER spelling — i.e., the form that differs from the
    // canonical (camelized) key. If the new occurrence's raw form matches
    // the canonical (camel-spelled duplicate), fall back to the prior form
    // so the user still sees which spelling to remove. The line number
    // identifies the new occurrence either way.
    const otherForm = rawKey !== key ? rawKey : prior.rawKey;
    throw new Error(`yaml: duplicate key "${key}" (also written as "${otherForm}") at line ${line}`);
  }
  seen.set(key, { rawKey, line });
  obj[key] = value;
}

export function parseYamlLite(raw: string): any {
  // Capture the 1-based source line number BEFORE stripping/filtering so the
  // parser can point users at the original line of a duplicate key. Lines
  // that are blank, comments, or `---` document markers never reach the
  // parser, so their source numbers are skipped (which is correct: users
  // expect the number that matches their editor, not a compressed index).
  const lines: YamlLine[] = [];
  raw.split("\n").forEach((rawLine, i) => {
    const trimmed = stripComment(rawLine).trim();
    if (!trimmed || trimmed === "---") return;
    lines.push({
      line: i + 1,
      indent: rawLine.match(/^\s*/)?.[0].length || 0,
      text: trimmed,
    });
  });

  function parseBlock(index: number, indent: number): [any, number] {
    if (index >= lines.length) return [{}, index];
    return lines[index].text.startsWith("- ") ? parseArray(index, indent) : parseObject(index, indent);
  }

  function parseArray(index: number, indent: number): [any[], number] {
    const output: any[] = [];
    while (index < lines.length && lines[index].indent === indent && lines[index].text.startsWith("- ")) {
      const rest = lines[index].text.slice(2).trim();
      index++;

      if (!rest) {
        const [child, next] = parseBlock(index, indent + 2);
        output.push(child);
        index = next;
        continue;
      }

      if (findUnquotedColon(rest) >= 0) {
        const [key, value, nested] = parseKeyValue(rest);
        const item: JsonRecord = {};
        // Track per-list-item duplicates. A list item is its own object
        // (e.g., `- path: x\n  path: y` inside a `list:` block); the keys
        // across different items are NOT duplicates — only keys inside the
        // same item are. The path-bearing error matches the parseObject
        // case so users get the same diagnostic shape regardless of where
        // the duplicate appears.
        const seen = new Map<string, { rawKey: string; line: number }>();
        setKeyOrThrow(item, key, extractRawKey(rest), value, lines[index - 1].line, seen);
        if (nested) {
          const [child, next] = parseBlock(index, indent + 2);
          item[key] = child;
          index = next;
        } else {
          item[key] = value;
        }

        while (index < lines.length && lines[index].indent > indent) {
          const line = lines[index];
          if (line.indent !== indent + 2 || line.text.startsWith("- ")) break;
          const [childKey, childValue, childNested] = parseKeyValue(line.text);
          setKeyOrThrow(item, childKey, extractRawKey(line.text), childValue, line.line, seen);
          index++;
          if (childNested) {
            const [child, next] = parseBlock(index, line.indent + 2);
            item[childKey] = child;
            index = next;
          } else {
            item[childKey] = childValue;
          }
        }
        output.push(item);
      } else {
        output.push(parseScalar(rest));
      }
    }
    return [output, index];
  }

  function parseObject(index: number, indent: number): [JsonRecord, number] {
    const output: JsonRecord = {};
    // Per-object duplicate-key tracker. The parser previously silently
    // overwrote on a repeated key — a critical audit finding because the
    // upper config layer rejects the resulting shape with an opaque
    // error, making the bug (typo + correct spelling on the same line) look
    // like a schema problem rather than a parser leniency. The error names
    // both forms so the user can see immediately that `subagentOutputLimit`
    // and `subagent-output-limit` are the same key to this parser.
    const seen = new Map<string, { rawKey: string; line: number }>();
    while (index < lines.length && lines[index].indent === indent && !lines[index].text.startsWith("- ")) {
      const line = lines[index];
      const [key, value, nested] = parseKeyValue(line.text);
      setKeyOrThrow(output, key, extractRawKey(line.text), value, line.line, seen);
      index++;
      if (nested) {
        const [child, next] = parseBlock(index, indent + 2);
        output[key] = child;
        index = next;
      } else {
        output[key] = value;
      }
    }
    return [output, index];
  }

  return parseBlock(0, lines[0]?.indent || 0)[0];
}

export function parseFrontmatter(raw: string): { attrs: JsonRecord; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { attrs: {}, body: raw.trim() };
  return { attrs: parseYamlLite(match[1]) || {}, body: match[2].trim() };
}
