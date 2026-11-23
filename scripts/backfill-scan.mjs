#!/usr/bin/env node
/**
 * Usage: RECIPEDB_FAMILY_PASSWORD=... node scripts/backfill-scan.mjs [--dry-run|--force <id>]
 * Run against a port-forward. See docs/runbook-backfill-scan-ocr.md.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stderr } from "node:process";

const base = (process.env.RECIPEDB_BASE ?? "http://localhost:3000").replace(/\/+$/, "");
const password = process.env.RECIPEDB_FAMILY_PASSWORD ?? await promptForPassword();
const args = process.argv.slice(2);
let dryRun = false;
const forceIds = [];

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--dry-run") {
    dryRun = true;
  } else if (args[i] === "--force") {
    const id = args[i + 1];
    if (!id || !/^\d+$/.test(id) || Number(id) <= 0) {
      fatal("--force requires a positive recipe id");
    }
    forceIds.push(Number(id));
    i += 1;
  } else {
    fatal(`unknown argument: ${args[i]}`);
  }
}

function fatal(message) {
  console.error(message);
  process.exit(1);
}

async function promptForPassword() {
  const rl = createInterface({ input: stdin, terminal: false });
  try {
    stderr.write("Family password: ");
    if (stdin.isTTY && typeof stdin.setRawMode === "function") {
      // Raw mode disables terminal echo; non-terminal readline does not echo it.
      stdin.setRawMode(true);
      try {
        return await rl.question("");
      } finally {
        stdin.setRawMode(false);
      }
    }
    return await rl.question("");
  } finally {
    rl.close();
  }
}

function cookieFrom(response) {
  const setCookie = response.headers.get("set-cookie");
  const match = setCookie?.match(/(?:^|,\s*)recipedb_session=([^;,]*)/);
  return match ? `recipedb_session=${match[1]}` : null;
}

async function login() {
  let response;
  try {
    response = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password, next: "/" }),
      redirect: "manual",
    });
  } catch {
    fatal("login failed (wrong password or unreachable host)");
  }
  const cookie = cookieFrom(response);
  if (response.status !== 302 || !cookie) {
    fatal("login failed (wrong password or unreachable host)");
  }
  return cookie;
}

async function requestJson(url, options, isLogin = false) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "request failed");
  }
  if (response.status === 401) {
    fatal("authentication failed; check RECIPEDB_FAMILY_PASSWORD");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    if (isLogin) return { response, data: null };
    throw new Error(`HTTP ${response.status}: invalid JSON response`);
  }
  return { response, data };
}

const cookie = await login();
let listResponse;
let listing;
try {
  ({ response: listResponse, data: listing } = await requestJson(
    `${base}/api/backfill/scan-ocr`,
    { headers: { cookie } },
  ));
} catch (error) {
  fatal(`could not list scan backfill targets: ${error instanceof Error ? error.message : "request failed"}`);
}
if (!listResponse.ok) {
  fatal(`could not list scan backfill targets (HTTP ${listResponse.status})`);
}
if (!listing || !Array.isArray(listing.targets) || !Array.isArray(listing.skipped)) {
  fatal("could not list scan backfill targets (invalid JSON response)");
}

console.log(`Targets (${listing.targets.length}):`);
for (const target of listing.targets) {
  console.log(`  ${target.id}\t${target.title}`);
}
console.log(`Skipped (${listing.skipped.length}):`);
for (const item of listing.skipped) {
  console.log(`  ${item.id}\t${item.reason}`);
}

if (dryRun) process.exit(0);

const targets = forceIds.length > 0
  ? forceIds.map((id) => {
      const target = listing.targets.find((item) => Number(item.id) === id);
      if (!target) console.warn(`Warning: forced recipe ${id} is not listed as a target; posting anyway.`);
      return target ?? { id, title: "(not listed)" };
    })
  : listing.targets;

let backfilled = 0;
let failed = 0;
let skipped = listing.skipped.length;
for (const target of targets) {
  try {
    const { response, data } = await requestJson(`${base}/api/backfill/scan-ocr`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ recipeId: target.id, ...(forceIds.length > 0 ? { force: true } : {}) }),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}${data?.error ? `: ${data.error}` : ""}`);
    }
    const details = Object.entries(data ?? {})
      .filter(([key]) => key === "status" || /count|pages|written|updated/i.test(key))
      .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
      .join(" ");
    console.log(`${target.id}\t${target.title}\t${details || "completed"}`);
    if (data?.status === "skipped") skipped += 1;
    else backfilled += 1;
  } catch (error) {
    if (error instanceof Error && error.message.includes("authentication failed")) {
      fatal(error.message);
    }
    console.error(`${target.id}\t${target.title}\terror: ${error instanceof Error ? error.message : "request failed"}`);
    failed += 1;
  }
}

console.log(`Summary: backfilled=${backfilled} skipped=${skipped} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
