import { Link } from "react-router";
import type { Route } from "./+types/_index";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "recipedb" },
    {
      name: "description",
      content: "Single-household recipe organizer (MVP).",
    },
  ];
}

export default function Index() {
  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: 640, margin: "0 auto" }}>
      <h1>recipedb</h1>
      <p>Single-household recipe organizer — MVP.</p>
      <p>
        <Link to="/add">+ Add a recipe</Link> · <a href="/health">/health</a>
      </p>
    </main>
  );
}
