#!/usr/bin/env node
/**
 * Usage: RECIPEDB_TOKEN=rdb_... node scripts/backfill-scan.mjs [--dry-run|--force <id>]
 * Run against a port-forward. See docs/runbook-backfill-scan-ocr.md.
 */

const base = (process.env.RECIPEDB_BASE ?? "http://localhost:3000").replace(/\/+$/, "");
const token = process.env.RECIPEDB_TOKEN;
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

if (!token?.startsWith("rdb_")) {
  fatal("authentication failed; set RECIPEDB_TOKEN to an rdb_-prefixed API token");
}

async function requestJson(url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers: { ...options.headers, authorization: `Bearer ${token}` },
    });
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "request failed");
  }
  if (response.status === 401) {
    fatal("authentication failed; check RECIPEDB_TOKEN");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`HTTP ${response.status}: invalid JSON response`);
  }
  return { response, data };
}

let listResponse;
let listing;
try {
  ({ response: listResponse, data: listing } = await requestJson(
    `${base}/api/backfill/scan-ocr`,
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
      headers: { "content-type": "application/json" },
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
