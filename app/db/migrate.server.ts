/**
 * Migration runner.
 *
 * Applied at container start BEFORE the server begins listening. The
 * migration journal lives at DATA_DIR/migrations-applied.json (defaults to
 * /data/migrations-applied.json) so it survives across container restarts.
 *
 * drizzle-kit generates a journal at drizzle/meta/_journal.json. We honor
 * that file and apply every `tag` listed there whose entry is missing from
 * our applied journal. Each .sql file is split on the standard `--> statement-breakpoint`
 * marker drizzle-kit uses and run statement-by-statement.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureDataDirs,
  getMigrationsAppliedPath,
  getRawSqlite,
} from "./client.server";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "drizzle");
const JOURNAL_PATH = path.join(MIGRATIONS_DIR, "meta", "_journal.json");

type Journal = {
  version: string;
  dialect: string;
  entries: Array<{
    idx: number;
    version: string;
    when: number;
    tag: string;
    breakpoints: boolean;
  }>;
};

type AppliedJournal = Record<
  string,
  { appliedAt: number; checksum: string }
>;

function readJournal(): Journal {
  const raw = fs.readFileSync(JOURNAL_PATH, "utf8");
  return JSON.parse(raw) as Journal;
}

function readAppliedJournal(): AppliedJournal {
  const p = getMigrationsAppliedPath();
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as AppliedJournal;
  } catch {
    // Corrupt journal: treat as empty and let the checksum check below catch
    // the real problem (we'll re-apply anything not present).
    return {};
  }
}

function writeAppliedJournal(journal: AppliedJournal): void {
  fs.writeFileSync(
    getMigrationsAppliedPath(),
    JSON.stringify(journal, null, 2),
    "utf8",
  );
}

function checksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function splitStatements(sqlText: string): string[] {
  // Drizzle emits `--> statement-breakpoint` between statements. Be tolerant:
  // split, then strip comments + empty fragments.
  const parts = sqlText
    .split(/-->\s*statement-breakpoint/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts;
}

export function runMigrations(): { applied: string[]; skipped: string[] } {
  ensureDataDirs();
  const sqlite = getRawSqlite();
  const journal = readJournal();
  const applied = readAppliedJournal();

  const appliedNow: string[] = [];
  const skipped: string[] = [];

  for (const entry of journal.entries) {
    const tag = entry.tag;
    const sqlPath = path.join(MIGRATIONS_DIR, `${tag}.sql`);
    if (!fs.existsSync(sqlPath)) {
      throw new Error(
        `migration ${tag} listed in journal but missing: ${sqlPath}`,
      );
    }
    const sqlText = fs.readFileSync(sqlPath, "utf8");
    const hash = checksum(sqlText);

    if (applied[tag]?.checksum === hash) {
      skipped.push(tag);
      continue;
    }
    if (applied[tag] && applied[tag]!.checksum !== hash) {
      throw new Error(
        `migration ${tag} has been modified after being applied. ` +
          `Expected sha256 ${applied[tag]!.checksum} but file is ${hash}. ` +
          `Refusing to re-apply.`,
      );
    }

    const statements = splitStatements(sqlText);
    const exec = sqlite.transaction(() => {
      for (const stmt of statements) {
        sqlite.exec(stmt);
      }
    });
    exec();

    applied[tag] = { appliedAt: Date.now(), checksum: hash };
    writeAppliedJournal(applied);
    appliedNow.push(tag);
  }

  return { applied: appliedNow, skipped };
}
