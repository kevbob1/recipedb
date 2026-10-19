import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  // Public routes — never gated.
  index("routes/_index.tsx"),
  route("health", "routes/health.tsx"),
  route("login", "routes/login.tsx"),
  route("logout", "routes/logout.tsx"),

  // THROWAWAY prototype for issue #17 (cook mode step-focus UX). No loader, so
  // it bypasses requireAuth on purpose; delete with app/prototype/.
  route("prototype/cook", "routes/prototype.cook.tsx"),

  // Everything below is gated by requireAuth() at the top of each
  // route's loader/action. Health is intentionally public for the
  // proxy / orchestrator; login/logout are public by definition.
  route("add", "routes/add.tsx"),
  route("api/import-url", "routes/api.import-url.ts"),
  route("api/save-draft", "routes/api.save-draft.ts"),
  route("recipes/:id/review", "routes/recipes.$id.review.tsx"),
] satisfies RouteConfig;
