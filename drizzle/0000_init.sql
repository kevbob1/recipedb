-- 0000_init.sql
-- Hand-written initial migration for recipedb.
-- Source of truth: app/db/schema.server.ts and GLOSSARY.md.
-- drizzle-kit tracks the relational schema in app/db/schema.server.ts; this
-- file is the actual SQL applied at startup. FTS5 is appended here because
-- drizzle-kit does not understand virtual tables.

-- ---------------------------------------------------------------------------
-- recipes
-- ---------------------------------------------------------------------------
CREATE TABLE `recipes` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `title` TEXT NOT NULL,
  `is_draft` INTEGER NOT NULL DEFAULT 1,
  `yield` TEXT,
  `category` TEXT NOT NULL,
  `favorite` INTEGER NOT NULL DEFAULT 0,
  `source_type` TEXT NOT NULL,
  `source_url` TEXT,
  `raw_ocr_text` TEXT,
  `created_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  `updated_at` INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  CHECK (category IN ('one-dish','soup','salad','bread','dessert','cookies','cake','pie','other')),
  CHECK (source_type IN ('url','scan','manual'))
);

CREATE INDEX `recipes_category_idx` ON `recipes` (`category`);
CREATE INDEX `recipes_is_draft_idx` ON `recipes` (`is_draft`);

-- ---------------------------------------------------------------------------
-- ingredient_lines
-- qty is TEXT so fractions ("1/2"), ranges ("2-3"), and words ("a pinch")
-- round-trip without numeric coercion.
-- ---------------------------------------------------------------------------
CREATE TABLE `ingredient_lines` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `recipe_id` INTEGER NOT NULL REFERENCES `recipes`(`id`) ON DELETE CASCADE,
  `qty` TEXT NOT NULL,
  `unit` TEXT,
  `item` TEXT NOT NULL,
  `note` TEXT,
  `position` INTEGER NOT NULL
);

CREATE INDEX `ingredient_lines_recipe_idx` ON `ingredient_lines` (`recipe_id`);
CREATE UNIQUE INDEX `ingredient_lines_recipe_pos_uq`
  ON `ingredient_lines` (`recipe_id`, `position`);

-- ---------------------------------------------------------------------------
-- steps
-- ---------------------------------------------------------------------------
CREATE TABLE `steps` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `recipe_id` INTEGER NOT NULL REFERENCES `recipes`(`id`) ON DELETE CASCADE,
  `position` INTEGER NOT NULL,
  `text` TEXT NOT NULL
);

CREATE INDEX `steps_recipe_idx` ON `steps` (`recipe_id`);
CREATE UNIQUE INDEX `steps_recipe_pos_uq` ON `steps` (`recipe_id`, `position`);

-- ---------------------------------------------------------------------------
-- tags
-- ---------------------------------------------------------------------------
CREATE TABLE `tags` (
  `id` INTEGER PRIMARY KEY AUTOINCREMENT,
  `recipe_id` INTEGER NOT NULL REFERENCES `recipes`(`id`) ON DELETE CASCADE,
  `label` TEXT NOT NULL
);

CREATE UNIQUE INDEX `tags_recipe_label_uq` ON `tags` (`recipe_id`, `label`);
CREATE INDEX `tags_label_idx` ON `tags` (`label`);

-- ---------------------------------------------------------------------------
-- FTS5 — hand-written because drizzle-kit does not track virtual tables.
--
-- A regular (non-contentless) FTS5 table. The relational triggers INSERT,
-- UPDATE, and DELETE rows in `recipe_fts` so MATCH queries always reflect
-- the current state of `recipes` / `ingredient_lines` / `steps` / `tags`.
-- rowid == recipes.id keeps the link implicit.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE `recipe_fts` USING fts5(
  `title`,
  `ingredients`,
  `steps`,
  `tags`,
  tokenize='unicode61'
);

-- recipes: seed a row in the FTS index on insert, drop on delete, retitle on
-- update of the title column.
CREATE TRIGGER IF NOT EXISTS `recipe_fts_ai_recipes`
AFTER INSERT ON `recipes`
BEGIN
  INSERT INTO `recipe_fts` (rowid, title, ingredients, steps, tags)
  VALUES (new.id, new.title, '', '', '');
END;

CREATE TRIGGER IF NOT EXISTS `recipe_fts_ad_recipes`
AFTER DELETE ON `recipes`
BEGIN
  DELETE FROM `recipe_fts` WHERE rowid = old.id;
END;

CREATE TRIGGER IF NOT EXISTS `recipe_fts_au_recipes`
AFTER UPDATE OF `title` ON `recipes`
BEGIN
  UPDATE `recipe_fts` SET title = new.title WHERE rowid = new.id;
END;

-- ingredient_lines: recompose the aggregated `ingredients` cell on change.
CREATE TRIGGER IF NOT EXISTS `recipe_fts_ai_ingredient_lines`
AFTER INSERT ON `ingredient_lines`
BEGIN
  UPDATE `recipe_fts`
     SET ingredients = (
       SELECT group_concat(
         coalesce(qty,'') || ' ' || coalesce(unit,'') || ' ' ||
         coalesce(item,'') || ' ' || coalesce(note,''),
         ' | '
       )
       FROM `ingredient_lines`
       WHERE recipe_id = new.recipe_id
     )
   WHERE rowid = new.recipe_id;
END;

CREATE TRIGGER IF NOT EXISTS `recipe_fts_ad_ingredient_lines`
AFTER DELETE ON `ingredient_lines`
BEGIN
  UPDATE `recipe_fts`
     SET ingredients = (
       SELECT group_concat(
         coalesce(qty,'') || ' ' || coalesce(unit,'') || ' ' ||
         coalesce(item,'') || ' ' || coalesce(note,''),
         ' | '
       )
       FROM `ingredient_lines`
       WHERE recipe_id = old.recipe_id
     )
   WHERE rowid = old.recipe_id;
END;

CREATE TRIGGER IF NOT EXISTS `recipe_fts_au_ingredient_lines`
AFTER UPDATE ON `ingredient_lines`
BEGIN
  UPDATE `recipe_fts`
     SET ingredients = (
       SELECT group_concat(
         coalesce(qty,'') || ' ' || coalesce(unit,'') || ' ' ||
         coalesce(item,'') || ' ' || coalesce(note,''),
         ' | '
       )
       FROM `ingredient_lines`
       WHERE recipe_id = new.recipe_id
     )
   WHERE rowid = new.recipe_id;
END;

-- steps: recompose the aggregated `steps` cell.
CREATE TRIGGER IF NOT EXISTS `recipe_fts_ai_steps`
AFTER INSERT ON `steps`
BEGIN
  UPDATE `recipe_fts`
     SET steps = (
       SELECT group_concat(text, ' | ' ORDER BY position)
       FROM `steps`
       WHERE recipe_id = new.recipe_id
     )
   WHERE rowid = new.recipe_id;
END;

CREATE TRIGGER IF NOT EXISTS `recipe_fts_ad_steps`
AFTER DELETE ON `steps`
BEGIN
  UPDATE `recipe_fts`
     SET steps = (
       SELECT group_concat(text, ' | ' ORDER BY position)
       FROM `steps`
       WHERE recipe_id = old.recipe_id
     )
   WHERE rowid = old.recipe_id;
END;

CREATE TRIGGER IF NOT EXISTS `recipe_fts_au_steps`
AFTER UPDATE ON `steps`
BEGIN
  UPDATE `recipe_fts`
     SET steps = (
       SELECT group_concat(text, ' | ' ORDER BY position)
       FROM `steps`
       WHERE recipe_id = new.recipe_id
     )
   WHERE rowid = new.recipe_id;
END;

-- tags: recompose the aggregated `tags` cell.
CREATE TRIGGER IF NOT EXISTS `recipe_fts_ai_tags`
AFTER INSERT ON `tags`
BEGIN
  UPDATE `recipe_fts`
     SET tags = (
       SELECT group_concat(label, ' | ')
       FROM `tags`
       WHERE recipe_id = new.recipe_id
     )
   WHERE rowid = new.recipe_id;
END;

CREATE TRIGGER IF NOT EXISTS `recipe_fts_ad_tags`
AFTER DELETE ON `tags`
BEGIN
  UPDATE `recipe_fts`
     SET tags = (
       SELECT group_concat(label, ' | ')
       FROM `tags`
       WHERE recipe_id = old.recipe_id
     )
   WHERE rowid = old.recipe_id;
END;

CREATE TRIGGER IF NOT EXISTS `recipe_fts_au_tags`
AFTER UPDATE ON `tags`
BEGIN
  UPDATE `recipe_fts`
     SET tags = (
       SELECT group_concat(label, ' | ')
       FROM `tags`
       WHERE recipe_id = new.recipe_id
     )
   WHERE rowid = new.recipe_id;
END;
