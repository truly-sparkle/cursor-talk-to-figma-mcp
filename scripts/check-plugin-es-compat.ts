#!/usr/bin/env bun
/**
 * BL-059: Plugin runtime ES compatibility scanner.
 *
 * The Figma plugin sandbox doesn't support several ES2018+ syntactic forms.
 * Catching them at lint time prevents the "code.js fails to parse and the
 * whole plugin breaks" class of regressions (BL-049, BL-058).
 *
 * Run: bun run lint:plugin
 *
 * Exits non-zero on any violation. Use in pre-commit / CI.
 *
 * This is intentionally a small grep-style scanner, not a full ESLint
 * setup, so it has zero dependencies. Promote to eslint-plugin-es-x if
 * the rule set ever needs to grow beyond ~5 patterns.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_FILE = join(ROOT, "src/cursor_mcp_plugin/code.js");

interface Rule {
  name: string;
  // Per-line pattern. Must NOT have the global flag — we re-test per line.
  re: RegExp;
  fix: string;
}

const RULES: Rule[] = [
  {
    name: "?? (nullish coalescing)",
    // Match `??` not preceded by `?` (which would be `???`) and not part of
    // a comment. Simple heuristic — false positives caught by line-comment
    // check below.
    re: /[^?!&|=/]\?\?[^=]/,
    fix: "Use `a == null ? fallback : a` instead.",
  },
  {
    name: "?. (optional chaining)",
    // foo?.bar  or  foo?.[idx]  or  foo?.()
    re: /[a-zA-Z0-9_)\]]\?\.\s*[a-zA-Z_(\[]/,
    fix: "Use plain `.` access with explicit guards.",
  },
  {
    name: "{ ... } (object spread)",
    // Object literal with spread: `{ ..." → spread + property
    re: /\{\s*\.\.\.[a-zA-Z_$]/,
    fix: "Use `Object.assign({}, obj, { key: val })` instead.",
  },
  {
    name: "{ a, ...rest } (destructuring rest)",
    re: /\{[^}]*,\s*\.\.\.[a-zA-Z_$][a-zA-Z0-9_$]*\s*\}/,
    fix: "Destructure known keys then build the rest manually.",
  },
  {
    name: ".flat( / .flatMap(",
    re: /\.(flat|flatMap)\s*\(/,
    fix: "Use `[].concat(...arr)` or a manual loop.",
  },
  {
    name: "Object.fromEntries(",
    re: /Object\.fromEntries\s*\(/,
    fix: "Build the object with a `for` loop.",
  },
];

function isCommentLine(line: string): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

function main(): number {
  const src = readFileSync(PLUGIN_FILE, "utf8");
  const lines = src.split("\n");
  let violations = 0;

  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (isCommentLine(line)) continue;
      if (rule.re.test(line)) {
        violations++;
        console.error(
          `${PLUGIN_FILE}:${i + 1}  [${rule.name}]\n  ${line.trim()}\n  → ${rule.fix}`
        );
      }
    }
  }

  if (violations > 0) {
    console.error(
      `\n✗ ${violations} ES2018+ pattern(s) in plugin code.\n` +
      `See AGENTS.md → "Figma plugin runtime ES compatibility".`
    );
    return 1;
  }
  console.log("✓ Plugin ES compatibility OK.");
  return 0;
}

process.exit(main());
