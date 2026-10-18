import type { Route } from "./+types/_index";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "recipedb" },
    {
      name: "description",
      content: "Single-household recipe organizer (MVP scaffold).",
    },
  ];
}

export default function Index() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>recipedb</h1>
      <p>Single-household recipe organizer — MVP scaffold.</p>
      <p>
        See <a href="/health">/health</a> for the liveness check.
      </p>
    </main>
  );
}
