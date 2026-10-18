-- 0001_scaling_quantity.sql
-- Derived numeric quantity columns on ingredient_lines (#16, decision on #15).
--
-- Additive and nullable-only, so this applies cleanly to a fresh DB (right
-- after 0000_init) and to an existing one, with no table rebuild and no replay
-- of 0000_init. `qty` stays the display source of truth; every column here is
-- derived by app/lib/quantity-parse.ts.
--
-- WARNING: this file is checksummed into migrations-applied.json by
-- app/db/migrate.server.ts. Never edit it after it has been applied anywhere —
-- add 0002_* instead.
--
-- Hand-written: the drizzle-kit in this repo reports the 0000_snapshot.json as
-- "unsupported version" and cannot diff it, so `drizzle-kit generate` emits
-- nothing. Same approach as 0000_init.sql. The statements below match
-- app/db/schema.server.ts.
--> statement-breakpoint
ALTER TABLE `ingredient_lines` ADD `qty_amount` real;
--> statement-breakpoint
ALTER TABLE `ingredient_lines` ADD `qty_amount2` real;
--> statement-breakpoint
ALTER TABLE `ingredient_lines` ADD `qty_unit_normalized` text;
--> statement-breakpoint
ALTER TABLE `ingredient_lines` ADD `qty_parse_status` text NOT NULL DEFAULT 'unparsed';
