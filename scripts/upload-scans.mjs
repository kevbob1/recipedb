#!/usr/bin/env node
/**
 * Upload PDFs from _pdf_scans/ as new scan recipes.
 *
 * Usage:
 *   RECIPEDB_TOKEN=rdb_... node scripts/upload-scans.mjs [options]
 */
import { basename, resolve } from "node:path";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";

const DEFAULT_BASE = "https://recipedb.k.pd.o/";
const MAX_PDF_BYTES = 15 * 1024 * 1024;

function usage() {
  console.log(`usage: node scripts/upload-scans.mjs [options]

Uploads PDFs as new scan recipes. The server stores the source PDF; OCR can be
run later through the scan backfill workflow.

Options:
  --dry-run           List PDFs and show the first draft; make no requests
  --base <url>        Server base URL (default: RECIPEDB_BASE or ${DEFAULT_BASE})
  --dir <path>        PDF directory (default: ./_pdf_scans)
  --include <prefix>  Only include filenames beginning with this prefix (repeatable)
  --force             Ignore the resume manifest and upload listed files again
  --help              Show this help

Authentication: RECIPEDB_TOKEN (an rdb_-prefixed API token).`);
}

function fatal(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(args) {
  const options = {
    dryRun: false,
    base: process.env.RECIPEDB_BASE ?? DEFAULT_BASE,
    dir: "./_pdf_scans",
    includes: [],
    force: false,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--base" || arg === "--dir" || arg === "--include") {
      const value = args[i + 1];
      if (!value || value.startsWith("--")) fatal(`${arg} requires a value`);
      if (arg === "--base") options.base = value;
      else if (arg === "--dir") options.dir = value;
      else options.includes.push(value);
      i += 1;
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help") {
      options.help = true;
    } else {
      fatal(`unknown argument: ${arg}`);
    }
  }

  options.base = options.base.replace(/\/+$/, "");
  if (!options.base) fatal("--base must be a valid URL");
  return options;
}

function networkHint(error) {
  const code = error?.cause?.code ?? error?.code;
  if (!code) return "";
  if (code.includes("CERT")) {
    return ` (TLS: Node does not trust system CAs; for mkcert hosts add NODE_EXTRA_CA_CERTS=~/.local/share/mkcert/rootCA.pem)`;
  }
  return ` (${code})`;
}

function titleFromFilename(filename) {
  const title = basename(filename, filename.slice(filename.lastIndexOf(".")))
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return title || "Scanned recipe";
}

function draftFor(filename) {
  const title = titleFromFilename(filename);
  // Mirrors the required RecipeDraft fields and scan provenance from
  // createDraft({ kind: "scan", text: "" }); the filename supplies its title.
  return {
    title,
    titleConfidence: "ok",
    category: "other",
    categoryConfidence: "ok",
    yield: null,
    yieldConfidence: "bad",
    tags: [],
    sourceType: "scan",
    sourceUrl: null,
    rawOcrText: "",
    imageFilename: null,
    favorite: false,
    ingredients: [],
    steps: [],
  };
}

function matchesIncludes(filename, includes) {
  return includes.length === 0 || includes.some((prefix) => filename.startsWith(prefix));
}

async function readManifest(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`resume manifest is not valid JSON: ${path}`);
  }
  if (!Array.isArray(parsed) || parsed.some((name) => typeof name !== "string")) {
    throw new Error(`resume manifest must be a JSON array of filenames: ${path}`);
  }
  return parsed;
}

async function appendManifest(path, names, filename) {
  if (names.includes(filename)) return;
  names.push(filename);
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(names, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function responseData(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  usage();
  process.exit(0);
}

const directory = resolve(options.dir);
const manifestPath = resolve(directory, ".upload-scans-done.json");
let entries;
try {
  entries = await readdir(directory, { withFileTypes: true });
} catch (error) {
  fatal(`could not read PDF directory ${directory}: ${error instanceof Error ? error.message : "unknown error"}`);
}

const files = entries
  .filter((entry) => entry.isFile() && /\.pdf$/i.test(entry.name))
  .map((entry) => entry.name)
  .filter((filename) => matchesIncludes(filename, options.includes))
  .sort((a, b) => a.localeCompare(b));

let manifest;
try {
  manifest = await readManifest(manifestPath);
} catch (error) {
  fatal(error instanceof Error ? error.message : "could not read resume manifest");
}

const pendingFiles = options.force
  ? files
  : files.filter((filename) => !manifest.includes(filename));
const candidates = [];
const results = [];

for (const filename of pendingFiles) {
  const path = resolve(directory, filename);
  try {
    const fileStat = await stat(path);
    if (fileStat.size > MAX_PDF_BYTES) {
      results.push({ filename, result: `ERROR: ${fileStat.size} bytes exceeds 15 MiB limit` });
      continue;
    }
    candidates.push(filename);
  } catch (error) {
    results.push({
      filename,
      result: `ERROR: ${error instanceof Error ? error.message : "could not inspect file"}`,
    });
  }
}

console.log(`PDFs: ${candidates.length} to upload${options.force ? " (--force)" : ""}; ${pendingFiles.length - candidates.length} rejected`);
if (!options.force) {
  const alreadyDone = files.length - pendingFiles.length;
  if (alreadyDone > 0) console.log(`Resume manifest: skipping ${alreadyDone} already uploaded`);
}

if (options.dryRun) {
  for (const [index, filename] of candidates.entries()) {
    console.log(`[${index + 1}/${candidates.length}] ${filename} -> would upload`);
  }
  if (candidates.length > 0) {
    console.log(`Draft for ${candidates[0]}:`);
    console.log(JSON.stringify(draftFor(candidates[0]), null, 2));
  }
} else if (candidates.length > 0) {
  const token = process.env.RECIPEDB_TOKEN;
  if (!token?.startsWith("rdb_")) {
    fatal("set RECIPEDB_TOKEN to an rdb_-prefixed API token before uploading");
  }

  for (const [index, filename] of candidates.entries()) {
    const path = resolve(directory, filename);
    try {
      const bytes = await readFile(path);
      if (bytes.toString("ascii", 0, 5) !== "%PDF-") {
        throw new Error("file does not begin with %PDF-");
      }
      const form = new FormData();
      form.append("draft", JSON.stringify(draftFor(filename)));
      form.append("pdf", new Blob([bytes], { type: "application/pdf" }), filename);

      const response = await fetch(`${options.base}/api/save-draft`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      const data = await responseData(response);
      if (!response.ok) {
        const details = response.status === 401
          ? "authentication failed; check RECIPEDB_TOKEN"
          : data?.error
            ? `${data.error}${data.message ? `: ${data.message}` : ""}`
            : `HTTP ${response.status}`;
        throw new Error(details);
      }
      if (data === null || (typeof data.recipeId !== "number" && typeof data.recipeId !== "string")) {
        throw new Error("server returned success without a recipeId");
      }

      try {
        await appendManifest(manifestPath, manifest, filename);
      } catch (error) {
        throw new Error(
          `uploaded as recipe ${data.recipeId}, but could not update resume manifest: ${error instanceof Error ? error.message : "write failed"}`,
        );
      }
      results.push({ filename, result: `recipe ${data.recipeId}` });
      console.log(`[${index + 1}/${candidates.length}] ${filename} -> recipe ${data.recipeId}`);
    } catch (error) {
      const message = error instanceof Error
        ? `${error.message}${networkHint(error)}`
        : "request failed";
      results.push({ filename, result: `ERROR: ${message}` });
      console.error(`[${index + 1}/${candidates.length}] ${filename} -> ERROR: ${message}`);
    }
  }
}

console.log("\nSummary:");
for (const { filename, result } of results) {
  console.log(`${filename}\t${result}`);
}
const failed = results.filter(({ result }) => result.startsWith("ERROR:")).length;
console.log(`\nUploaded=${results.length - failed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
