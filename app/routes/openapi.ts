import type { Route } from "./+types/openapi";
import openApiSpec from "../../docs/openapi.yaml?raw";

export function loader(_args: Route.LoaderArgs) {
  return new Response(openApiSpec, {
    headers: { "content-type": "text/yaml; charset=utf-8" },
  });
}

export function action() {
  return Response.json({ error: "method-not-allowed" }, { status: 405 });
}

export default function OpenApiRoute() {
  return null;
}
