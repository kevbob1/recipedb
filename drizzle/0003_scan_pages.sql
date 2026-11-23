-- 0003_scan_pages.sql
-- Per-page provenance and OCR training capture for scanned documents
-- (ADR-0004).
--
-- recipe_pages is the per-page draft store: one row per page of a multi-page
-- scan, carrying that page's raw OCR text and its capture filename (relative
-- to DATA_DIR/images/, e.g. "<recipeId>/page-1.png"). Written on save and
-- replaced with the other child rows; page_no is 1-based and unique per
-- recipe. image_filename is nullable and may name a capture that has not
-- been uploaded yet (the page-image upload lands with the PDF ingestion
-- phase).
--
-- ocr_training_samples is the append-only training capture: one row per
-- ACCEPTED page, pairing the raw OCR text with the corrected text a person
-- accepted at review. The acceptance write lands in a later phase; this
-- migration only provides the table. corrected_text and accepted_at stay
-- NULL until that capture runs. `source` records where the sample came from
-- ('scan' for camera and PDF alike) so future backfills can be excluded.
--
-- WARNING: this file is checksummed into migrations-applied.json by
-- app/db/migrate.server.ts. Never edit it after it has been applied anywhere —
-- add 0004_* instead.
--
-- Hand-written: the drizzle-kit in this repo reports the 0000_snapshot.json as
-- "unsupported version" and cannot diff it, so `drizzle-kit generate` emits
-- nothing. Same approach as 0000_init.sql / 0001_scaling_quantity.sql /
-- 0002_scan_image.sql. The statements below match app/db/schema.server.ts.
--> statement-breakpoint
CREATE TABLE `recipe_pages` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `recipe_id` INTEGER NOT NULL REFERENCES `recipes`(`id`) ON DELETE CASCADE,
  `page_no` INTEGER NOT NULL,
  `image_filename` TEXT,
  `raw_ocr_text` TEXT
);
--> statement-breakpoint
CREATE INDEX `recipe_pages_recipe_idx` ON `recipe_pages` (`recipe_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_pages_recipe_page_uq`
  ON `recipe_pages` (`recipe_id`, `page_no`);
--> statement-breakpoint
CREATE TABLE `ocr_training_samples` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `recipe_id` INTEGER NOT NULL REFERENCES `recipes`(`id`) ON DELETE CASCADE,
  `page_no` INTEGER NOT NULL,
  `image_filename` TEXT,
  `raw_ocr_text` TEXT NOT NULL,
  `corrected_text` TEXT,
  `source` TEXT NOT NULL DEFAULT 'scan',
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `accepted_at` INTEGER
);
--> statement-breakpoint
CREATE INDEX `ocr_training_samples_recipe_idx` ON `ocr_training_samples` (`recipe_id`);
