import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/_index.tsx"),
  route("health", "routes/health.tsx"),
  route("add", "routes/add.tsx"),
  route("api/import-url", "routes/api.import-url.ts"),
  route("api/save-draft", "routes/api.save-draft.ts"),
  route("recipes/:id/review", "routes/recipes.$id.review.tsx"),
] satisfies RouteConfig;
