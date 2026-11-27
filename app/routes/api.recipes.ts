import type { Route } from "./+types/api.recipes";
import { requireAuth } from "../lib/auth.server";
import { listRecipeSummaries } from "../lib/adjustments-http.server";

export function loader({ request }: Route.LoaderArgs) {
  requireAuth(request, { isApi: true });
  return listRecipeSummaries(new URL(request.url));
}

export function action({ request }: Route.ActionArgs) {
  requireAuth(request, { isApi: true });
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}

export default function ApiRecipesRoute() {
  return null;
}
