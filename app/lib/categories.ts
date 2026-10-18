/**
 * Fixed recipe category list.
 *
 * Kept in a non-server module so client code (review editor, add flow) and
 * server code (Drizzle schema, persistence) can share the same closed set
 * without pulling server-only modules into the browser bundle.
 *
 * Source: GLOSSARY.md.
 */
export const CATEGORIES = [
  "one-dish",
  "soup",
  "salad",
  "bread",
  "dessert",
  "cookies",
  "cake",
  "pie",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];
