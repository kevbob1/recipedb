import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./app/db/schema.server.ts",
  out: "./drizzle",
  dialect: "sqlite",
  // Migrations are applied by app/db/migrate.ts at container start, not by
  // drizzle-kit's migrator; we still want drizzle-kit to track the schema so
  // future `db:generate` runs work.
  verbose: true,
});
