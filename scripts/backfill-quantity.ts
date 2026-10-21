/**
 * One-shot backfill: derive the numeric quantity columns for rows that have
 * never been parsed (qty_parse_status = 'unparsed' — the column default, so it
 * matches every row that existed before 0001_scaling_quantity).
 *
 * Run after the migration has been applied (the app self-migrates at boot, so
 * this is a post-deploy step, not a build step):
 *
 *   DATA_DIR=/data npx tsx scripts/backfill-quantity.ts
 *   npm run db:backfill-quantity          # same, using the ambient DATA_DIR
 *
 * Idempotent: only 'unparsed' rows are touched, and each is written with its
 * resolved status, so a second run scans nothing. qty text is never modified.
 */
import { getRawSqlite } from "../app/db/client.server";
import { fromText } from "../app/lib/ingredient-line";

export interface BackfillCounts {
  scanned: number;
  parsed: number;
  ranges: number;
  unparseable: number;
}

interface LegacyRow {
  id: number;
  qty: string;
  unit: string | null;
}

export function backfillQuantities(): BackfillCounts {
  const sqlite = getRawSqlite();
  const rows = sqlite
    .prepare(
      `SELECT id, qty, unit FROM ingredient_lines
        WHERE qty_parse_status IS NULL OR qty_parse_status = 'unparsed'`,
    )
    .all() as LegacyRow[];

  const update = sqlite.prepare(
    `UPDATE ingredient_lines
        SET qty_amount = ?, qty_amount2 = ?, qty_unit_normalized = ?, qty_parse_status = ?
      WHERE id = ?`,
  );

  const counts: BackfillCounts = {
    scanned: rows.length,
    parsed: 0,
    ranges: 0,
    unparseable: 0,
  };

  const run = sqlite.transaction(() => {
    for (const row of rows) {
      const p = fromText(row.qty, row.unit);
      if (p.qtyParseStatus === "parsed") counts.parsed += 1;
      else if (p.qtyParseStatus === "range") counts.ranges += 1;
      else counts.unparseable += 1;
      update.run(p.qtyAmount, p.qtyAmount2, p.qtyUnitNormalized, p.qtyParseStatus, row.id);
    }
  });
  run();

  return counts;
}

// Direct invocation (tsx scripts/backfill-quantity.ts) prints what it did.
if (process.argv[1]?.endsWith("backfill-quantity.ts")) {
  const counts = backfillQuantities();
  console.log(
    `[backfill-quantity] scanned ${counts.scanned} row(s): ` +
      `${counts.parsed} parsed, ${counts.ranges} range, ${counts.unparseable} unparseable`,
  );
  getRawSqlite().close();
}
