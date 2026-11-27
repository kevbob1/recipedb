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

// Resource route: exporting no `default`/`ErrorBoundary` component keeps React
// Router's handleResourceRequest in charge, which passes every loader/action
// Response through verbatim instead of rendering it through the document/error
// pipeline.
