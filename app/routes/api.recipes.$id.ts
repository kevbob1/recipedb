import type { Route } from "./+types/api.recipes.$id";
import { requireAuth } from "../lib/auth.server";
import { getRecipeDraft } from "../lib/adjustments-http.server";

export function loader({ request, params }: Route.LoaderArgs) {
  requireAuth(request, { isApi: true });
  return getRecipeDraft(params.id);
}

export function action({ request }: Route.ActionArgs) {
  requireAuth(request, { isApi: true });
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}

export default function ApiRecipeRoute() {
  return null;
}
