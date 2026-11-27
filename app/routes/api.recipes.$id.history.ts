import type { Route } from "./+types/api.recipes.$id.history";
import { requireAuth } from "../lib/auth.server";
import { getRecipeHistory } from "../lib/adjustments-http.server";

export function loader({ request, params }: Route.LoaderArgs) {
  requireAuth(request, { isApi: true });
  return getRecipeHistory(params.id);
}

export function action({ request }: Route.ActionArgs) {
  requireAuth(request, { isApi: true });
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}

export default function ApiRecipeHistoryRoute() {
  return null;
}
