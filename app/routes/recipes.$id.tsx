/**
 * /recipes/:id — the single-page read view (issue #25).
 *
 * The recipe as stored, on one screen: title, category, tags, favorite, yield,
 * the ingredient list (with the shared scaled view from /add), and the steps
 * in order. This is where the home list points; from here the person chooses
 * to edit (the review screen) or to cook (the cook screen).
 *
 * Read-only by construction: the loader is requireAuth + loadReadRecipe and
 * there is no action, so a stale tab cannot mutate anything. There is no
 * check-off state and no wake lock here — this page is a document, not a
 * session (those belong to /cook).
 */
import { Link } from "react-router";
import type { Route } from "./+types/recipes.$id";
import { ScaledIngredientList } from "./review-editor";
import { loadReadRecipe } from "../lib/read.server";
import { requireAuth } from "../lib/auth.server";

export function meta({ data }: Route.MetaArgs) {
  if (!data) return [{ title: "Recipe — recipedb" }];
  return [{ title: `${data.draft.title || "Untitled recipe"} — recipedb` }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  requireAuth(request);
  const result = loadReadRecipe(params.id);
  if (!result.ok) {
    throw new Response(result.message, { status: result.status });
  }
  return { draft: result.draft, recipeId: result.recipeId };
}

export default function ReadRoute({ loaderData }: Route.ComponentProps) {
  const { draft, recipeId } = loaderData;
  // loadDraft already returns steps in position order; sorting here keeps the
  // page honest on its own and is a no-op when the load was ordered.
  const steps = [...draft.steps].sort((a, b) => a.position - b.position);

  return (
    <main style={shellStyle}>
      <p style={backRowStyle}>
        <Link to="/" style={linkStyle}>
          ← Home
        </Link>
      </p>

      <header style={cardStyle}>
        <p style={eyebrowStyle}>
          {draft.favorite ? (
            <span aria-label="Favorite">★ Favorite</span>
          ) : (
            "Recipe"
          )}
        </p>
        <h1 style={titleStyle}>{draft.title || "Untitled recipe"}</h1>
        <p style={metaStyle}>
          {draft.category}
          {draft.yield ? ` · ${draft.yield}` : null}
          {` · ${draft.ingredients.length} ingredient${
            draft.ingredients.length === 1 ? "" : "s"
          }`}
          {` · ${steps.length} step${steps.length === 1 ? "" : "s"}`}
        </p>

        {draft.tags.length > 0 ? (
          <ul aria-label="Tags" style={tagListStyle}>
            {draft.tags.map((tag) => (
              <li key={tag} style={tagStyle}>
                {tag}
              </li>
            ))}
          </ul>
        ) : null}

        <div style={actionRowStyle}>
          <Link
            to={`/recipes/${recipeId}/review`}
            style={{ ...ghostLinkStyle }}
          >
            Edit recipe
          </Link>
          <Link to={`/recipes/${recipeId}/cook`} style={primaryLinkStyle}>
            Cook this →
          </Link>
        </div>

        {draft.sourceUrl ? (
          <p style={sourceStyle}>
            Source:{" "}
            <a
              href={draft.sourceUrl}
              target="_blank"
              rel="noreferrer"
              style={linkStyle}
            >
              {draft.sourceUrl}
            </a>
          </p>
        ) : null}
      </header>

      <section aria-labelledby="ingredients-heading" style={cardStyle}>
        <h2 id="ingredients-heading" style={sectionTitleStyle}>
          Ingredients
        </h2>
        {draft.ingredients.length === 0 ? (
          <p style={mutedStyle}>
            No ingredients listed for this recipe yet.
          </p>
        ) : (
          <ScaledIngredientList ingredients={draft.ingredients} />
        )}
      </section>

      <section aria-labelledby="steps-heading" style={cardStyle}>
        <h2 id="steps-heading" style={sectionTitleStyle}>
          Steps
        </h2>
        {steps.length === 0 ? (
          <p style={mutedStyle}>
            No steps written yet — add them on the review screen.
          </p>
        ) : (
          <ol style={stepListStyle}>
            {steps.map((step, i) => (
              <li key={`${step.position}-${i}`} style={stepItemStyle}>
                <span aria-hidden style={badgeStyle}>
                  {i + 1}
                </span>
                <p style={stepTextStyle}>{step.text}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <p style={footnoteStyle}>
        Nothing on this page is saved. ·{" "}
        <Link to={`/recipes/${recipeId}/review`} style={linkStyle}>
          Edit
        </Link>{" "}
        ·{" "}
        <Link to={`/recipes/${recipeId}/cook`} style={linkStyle}>
          Cook
        </Link>{" "}
        · <Link to="/" style={linkStyle}>Back to recipes</Link>
      </p>
    </main>
  );
}

/* ------------------------------- styles ------------------------------- */
/* Inline objects, matching the idiom used by home, review, and cook. */

const muted = "#6b655c";
const brand = "#b04a2f";

const shellStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  maxWidth: 720,
  margin: "0 auto",
  padding: "0.5rem 16px 6rem",
};

const backRowStyle: React.CSSProperties = {
  margin: "10px 0 0",
  fontSize: 13,
};

const cardStyle: React.CSSProperties = {
  margin: "12px 0 0",
  padding: "14px 16px",
  border: "1px solid #e3ddd2",
  borderRadius: 14,
  background: "#fff",
};

const eyebrowStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: brand,
};

const titleStyle: React.CSSProperties = {
  margin: "4px 0 0",
  fontSize: "1.5rem",
  lineHeight: 1.25,
};

const metaStyle: React.CSSProperties = {
  margin: "6px 0 0",
  fontSize: 13,
  color: muted,
};

const tagListStyle: React.CSSProperties = {
  listStyle: "none",
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  margin: "10px 0 0",
  padding: 0,
};

const tagStyle: React.CSSProperties = {
  fontSize: 12,
  border: "1px solid #e3ddd2",
  background: "#fdfcf8",
  borderRadius: 999,
  padding: "3px 10px",
  color: "#3a332b",
};

const actionRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  marginTop: 14,
};

const primaryLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "11px 18px",
  background: brand,
  color: "#fff",
  borderRadius: 999,
  textDecoration: "none",
  fontWeight: 600,
  fontSize: 14,
};

const ghostLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "11px 18px",
  border: "1px solid #c9c1b1",
  background: "#fff",
  color: "inherit",
  borderRadius: 999,
  textDecoration: "none",
  fontSize: 14,
};

const sourceStyle: React.CSSProperties = {
  margin: "12px 0 0",
  fontSize: 12,
  color: muted,
  overflowWrap: "anywhere",
};

const sectionTitleStyle: React.CSSProperties = {
  margin: 0,
  fontSize: 13,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
};

const mutedStyle: React.CSSProperties = {
  margin: "8px 0 0",
  fontSize: 14,
  color: muted,
};

const stepListStyle: React.CSSProperties = {
  listStyle: "none",
  margin: "10px 0 0",
  padding: 0,
  display: "grid",
  gap: 12,
};

const stepItemStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
};

const badgeStyle: React.CSSProperties = {
  flex: "none",
  width: 28,
  height: 28,
  borderRadius: 999,
  background: "#efe9df",
  color: "#3a332b",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 13,
  fontWeight: 700,
};

const stepTextStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "1rem",
  lineHeight: 1.5,
  color: "#3a332b",
};

const linkStyle: React.CSSProperties = { color: brand };

const footnoteStyle: React.CSSProperties = {
  margin: "16px 0 0",
  fontSize: 12,
  color: muted,
};
