-- 0004_machine_api.sql
-- API tokens and append-only recipe save history for the machine API.
--
-- api_tokens stores only SHA-256 hashes; plaintext secrets are returned once
-- when minted. save_events are immutable history snapshots and cascade with
-- their recipe.
--
-- WARNING: this file is checksummed into migrations-applied.json by
-- app/db/migrate.server.ts. Never edit it after it has been applied anywhere —
-- add 0005_* instead.
--
-- Hand-written: drizzle-kit cannot diff the repo's legacy 0000_snapshot.json.
-- The statements below match app/db/schema.server.ts.
--> statement-breakpoint
CREATE TABLE `api_tokens` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `name` TEXT NOT NULL,
  `token_hash` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_tokens_token_hash_uq` ON `api_tokens` (`token_hash`);
--> statement-breakpoint
CREATE TABLE `save_events` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `recipe_id` INTEGER NOT NULL REFERENCES `recipes`(`id`) ON DELETE CASCADE,
  `capture_mode` TEXT NOT NULL,
  `recognized_json` TEXT,
  `saved_json` TEXT NOT NULL,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  CHECK (`capture_mode` IN ('save', 'revise', 'backfill', 'reparse'))
);
--> statement-breakpoint
CREATE INDEX `save_events_recipe_created_idx`
  ON `save_events` (`recipe_id`, `created_at`);
