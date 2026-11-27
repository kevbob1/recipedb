import type { Route } from "./+types/api.backfill-normalize-images";
import { requireAuth } from "../lib/auth.server";
import { normalizeImages } from "../lib/normalize-images.server";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loader({ request }: Route.LoaderArgs) {
  requireAuth(request, { isApi: true });
  return Response.json(normalizeImages({ dryRun: true }));
}

export async function action({ request }: Route.ActionArgs) {
  requireAuth(request, { isApi: true });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid-json" }, { status: 400 });
  }
  if (!isRecord(body)) {
    return Response.json({ error: "invalid-body" }, { status: 400 });
  }
  return Response.json(
    normalizeImages({ keepOrphans: body.keepOrphans === true }),
  );
}

// Resource route: exporting no `default`/`ErrorBoundary` component keeps React
// Router's handleResourceRequest in charge, which passes every loader/action
// Response through verbatim — JSON 200/400 as-is — instead of rendering them
// through the document/error pipeline.
