import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  route("api/backfill/scan-ocr", "routes/api.backfill-scan-ocr.tsx"),
  route("api/backfill/normalize-images", "routes/api.backfill-normalize-images.tsx"),
  route("api/backfill/training-export", "routes/api.backfill-training-export.tsx"),
  route("api/tokens", "routes/api.tokens.ts"),
  // Public routes — never gated.
  index("routes/_index.tsx"),
  route("health", "routes/health.tsx"),
  route("openapi.yaml", "routes/openapi.ts"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),

  // Everything below is gated by requireAuth() at the top of each
  // route's loader/action. Health is intentionally public for the
  // proxy / orchestrator; login/logout are public by definition.
  route("add", "routes/add.tsx"),
  route("api/recipes", "routes/api.recipes.ts"),
  route("api/recipes/:id", "routes/api.recipes.$id.ts"),
  route("api/recipes/:id/history", "routes/api.recipes.$id.history.ts"),
  route("api/adjustments", "routes/api.adjustments.ts"),
  route("api/import-url", "routes/api.import-url.ts"),
  route("api/save-draft", "routes/api.save-draft.ts"),
  // Explicit re-OCR against a retained scan capture (#28).
  route("api/re-ocr", "routes/api.re-ocr.ts"),
  // Read-only serving of retained scan artifacts (ADR-0004 phase 4).
  route("api/scan-images/*", "routes/api.scan-images.$.ts"),
  // Read-only single-page read view (#25). The home list lands here; review
  // and cook are one tap away from it.
  route("recipes/:id", "routes/recipes.$id.tsx"),
  route("recipes/:id/review", "routes/recipes.$id.review.tsx"),
  // Read-only cook screen (#18). No action: a cook session writes nothing.
  route("recipes/:id/cook", "routes/recipes.$id.cook.tsx"),
] satisfies RouteConfig;
