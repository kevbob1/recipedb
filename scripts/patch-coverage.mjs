#!/usr/bin/env node
/**
 * Patch coverage gate — measure line coverage of the lines this change touches,
 * instead of the whole repo. Reads the V8 report written by `vitest --coverage`
 * (coverage/lcov.info) and intersects it with the changed lines in `app/`.
 *
 * "Changed" means: unstaged + staged changes against a base ref (default HEAD),
 * plus untracked files (every countable line counts as changed).
 *
 * Usage:
 *   npm run test:patch                  # coverage run + this gate
 *   node scripts/patch-coverage.mjs     # reuse an existing coverage/lcov.info
 *
 * Environment:
 *   PATCH_COVERAGE_MIN    minimum changed-line coverage, percent (default 95)
 *   PATCH_COVERAGE_BASE   git ref to diff against (default HEAD)
 *
 * Exit codes: 0 pass (or nothing changed to measure), 1 below threshold,
 * 2 missing lcov.info / git failure.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const LCOV_PATH = path.join(ROOT, "coverage", "lcov.info");
const MIN = Number(process.env.PATCH_COVERAGE_MIN ?? "95");
const BASE = process.env.PATCH_COVERAGE_BASE ?? "HEAD";
const APP_PREFIX = "app/";

function fail(message) {
  console.error(`patch-coverage: ${message}`);
  process.exit(2);
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    fail(`git ${args.join(" ")} failed: ${error.message}`);
  }
}

if (!Number.isFinite(MIN) || MIN < 0 || MIN > 100) {
  fail(`PATCH_COVERAGE_MIN must be a number 0-100, got ${process.env.PATCH_COVERAGE_MIN}`);
}

if (!existsSync(LCOV_PATH)) {
  console.error(
    "patch-coverage: coverage/lcov.info not found.\n" +
      "Run `npm run test:coverage` first (needs the v8 lcov reporter).",
  );
  process.exit(1);
}

/* ---------------------------------------------------------------- lcov --- */

/** @type {Map<string, Map<number, number>>} repo-relative path -> line -> hits */
const coverage = new Map();

{
  const text = readFileSync(LCOV_PATH, "utf8");
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.startsWith("SF:")) {
      const sf = raw.slice(3).trim();
      const abs = path.isAbsolute(sf) ? sf : path.resolve(ROOT, sf);
      const rel = path.relative(ROOT, abs).split(path.sep).join("/");
      current = rel.startsWith("..") ? null : rel;
      if (current && !coverage.has(current)) coverage.set(current, new Map());
    } else if (raw.startsWith("DA:") && current) {
      const [line, hits] = raw.slice(3).split(",");
      const lineNo = Number(line);
      const hitCount = Number(hits);
      if (Number.isFinite(lineNo) && Number.isFinite(hitCount)) {
        const lines = coverage.get(current);
        // A line can appear once per DA record; keep the best result.
        lines.set(lineNo, Math.max(lines.get(lineNo) ?? 0, hitCount));
      }
    } else if (raw === "end_of_record") {
      current = null;
    }
  }
}

/* ------------------------------------------------------------- changes --- */

/** @type {Map<string, Set<number>>} repo-relative path -> changed line numbers */
const changed = new Map();

function addLines(file, lines) {
  if (!lines.size) return;
  const existing = changed.get(file);
  if (existing) {
    for (const line of lines) existing.add(line);
  } else {
    changed.set(file, new Set(lines));
  }
}

// Tracked modifications (staged + unstaged) against the base ref.
{
  const diff = git(["diff", "-U0", "--no-color", BASE, "--"]);
  let file = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
    } else if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      file =
        target === "/dev/null"
          ? null
          : target.startsWith("b/")
            ? target.slice(2)
            : target;
    } else if (file && line.startsWith("@@")) {
      const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) continue;
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      const lines = new Set();
      for (let i = 0; i < count; i += 1) lines.add(start + i);
      addLines(file, lines);
    }
  }
}

// Untracked files: every countable line is a changed line.
{
  const status = git(["status", "--porcelain", "-z", "--untracked-files=all"]);
  const entries = status.split("\0").filter(Boolean);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const state = entry.slice(0, 2);
    if (state === "??") {
      const file = entry.slice(3).split(path.sep).join("/");
      const abs = path.join(ROOT, file);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs, "utf8");
      const all = content.split("\n");
      if (content.endsWith("\n")) all.pop();
      const lines = new Set();
      all.forEach((text, index) => {
        if (isCountableSourceLine(text)) lines.add(index + 1);
      });
      addLines(file, lines);
    } else if (state[0] === "R" || state[0] === "C") {
      // -z rename/copy entries carry the source path as the next record.
      i += 1;
    }
  }
}

/** Blank lines and pure comment lines never carry a DA record. */
function isCountableSourceLine(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return !/^(\/\/|\/\*|\*|\*\/|<!--)/.test(trimmed);
}

/* -------------------------------------------------------------- report --- */

const isCoverable = (file) =>
  file.startsWith(APP_PREFIX) &&
  /\.[cm]?[jt]sx?$/.test(file) &&
  !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) &&
  !/\.d\.[cm]?ts$/.test(file);

const rows = [];
let covered = 0;
let total = 0;

for (const [file, lines] of [...changed].sort(([a], [b]) => a.localeCompare(b))) {
  if (!isCoverable(file)) continue;

  const fileCoverage = coverage.get(file);
  let fileCovered = 0;
  let fileTotal = 0;

  for (const line of lines) {
    const hits = fileCoverage?.get(line);
    if (hits === undefined) {
      // No instrumented record. For files the coverage run never saw (brand-new
      // source, or code excluded from the report) every changed line is uncovered.
      if (!fileCoverage) {
        fileTotal += 1;
      }
      continue;
    }
    fileTotal += 1;
    if (hits > 0) fileCovered += 1;
  }

  if (!fileTotal) continue;
  rows.push({ file, covered: fileCovered, total: fileTotal });
  covered += fileCovered;
  total += fileTotal;
}

const percent = (part, whole) => (whole === 0 ? 100 : (part / whole) * 100);

console.log(`Patch coverage: changed lines under ${APP_PREFIX} vs ${BASE} (min ${MIN}%)`);

if (!rows.length) {
  console.log("  no changed app/ lines with coverage data — nothing to measure.");
  console.log("PASS: patch coverage gate vacuous (no changed app lines).");
  process.exit(0);
}

const width = Math.max(...rows.map((row) => row.file.length), "TOTAL".length);
for (const row of rows) {
  const pct = percent(row.covered, row.total);
  console.log(
    `  ${row.file.padEnd(width)}  ${String(row.covered).padStart(4)}/${String(row.total).padEnd(4)}  ${pct.toFixed(1).padStart(5)}%`,
  );
}

const overall = percent(covered, total);
console.log(
  `  ${"TOTAL".padEnd(width)}  ${String(covered).padStart(4)}/${String(total).padEnd(4)}  ${overall.toFixed(1).padStart(5)}%`,
);

if (overall < MIN) {
  console.error(
    `FAIL: patch coverage ${overall.toFixed(1)}% is below the ${MIN}% minimum ` +
      `(${total - covered} uncovered changed line${total - covered === 1 ? "" : "s"}).`,
  );
  console.error("Add tests covering the changed lines, or set PATCH_COVERAGE_MIN to override.");
  process.exit(1);
}

console.log(`PASS: patch coverage ${overall.toFixed(1)}% >= ${MIN}%.`);
