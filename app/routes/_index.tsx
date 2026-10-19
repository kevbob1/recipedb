/**
 * / — Home: search + browse (#11)
 *
 * One surface, two modes that share the same list:
 *   - Browse: category cards + recent-first list, with optional filters.
 *   - Search: a single FTS5 box over title/ingredients/steps/tags,
 *     ordered by relevance.
 *
 * Filters: category, tag (autocomplete), favorite-only, ingredient include.
 *
 * The whole page is one form whose inputs are reflected in the URL
 * (search params), so a phone result is shareable and a back button returns
 * to the previous query.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  Link,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "react-router";
import type { Route } from "./+types/_index";
import { CATEGORIES, type Category } from "../lib/categories";
import {
  categoryCounts,
  listRecipes,
  suggestTags,
  type SearchHit,
} from "../lib/search.server";
import { requireAuth } from "../lib/auth.server";

export function meta(_args: Route.MetaArgs) {
  return [
    { title: "recipedb" },
    {
      name: "description",
      content: "Find a recipe in seconds.",
    },
  ];
}

export async function loader({ request }: Route.LoaderArgs) {
  // Auth gate. Recipe lists, counts, and tag suggestions all live
  // behind the family password.
  requireAuth(request);
  const url = new URL(request.url);
  const sp = url.searchParams;
  const query = sp.get("q") ?? "";
  const category = sp.get("cat") ?? "";
  const tag = sp.get("tag") ?? "";
  const favoriteOnly = sp.get("fav") === "1";
  const ingredientInclude = sp.get("ing") ?? "";
  // Autocomplete is best-effort and cheap. Empty query → no call.
  const acPrefix = sp.get("ac") ?? "";

  const result = listRecipes(
    {
      query: query || null,
      category: category || null,
      tag: tag || null,
      favoriteOnly: favoriteOnly || null,
      ingredientInclude: ingredientInclude || null,
    },
    { limit: 50 },
  );
  const counts = categoryCounts();
  const tagSuggestions =
    acPrefix.length > 0 ? suggestTags(acPrefix, { limit: 8 }) : [];

  return {
    query,
    category,
    tag,
    favoriteOnly,
    ingredientInclude,
    result,
    counts,
    tagSuggestions,
  };
}

export default function Index({ loaderData }: Route.ComponentProps) {
  const {
    query,
    category,
    tag,
    favoriteOnly,
    ingredientInclude,
    result,
    counts,
    tagSuggestions,
  } = loaderData;
  const [params] = useSearchParams();
  const navigation = useNavigation();
  const submit = useSubmit();
  const isSearching = navigation.state !== "idle";
  const isBrowse = result.mode === "browse";

  // Sticky search bar — keep the input focused across submit cycles.
  const queryInputRef = useRef<HTMLInputElement | null>(null);

  // Debounce the autocomplete fetch by reusing the URL: every keystroke in
  // the tag field updates the URL via submit(), which round-trips through
  // the loader. Keep this state local; the URL is the source of truth.
  const [tagDraft, setTagDraft] = useState(tag);
  useEffect(() => {
    setTagDraft(tag);
  }, [tag]);

  return (
    <main style={shellStyle}>
      <StickySearch
        queryRef={queryInputRef}
        defaultValue={query}
        submitting={isSearching}
        onSubmit={(q) => {
          const next = new URLSearchParams(params);
          if (q) next.set("q", q);
          else next.delete("q");
          submit(next, { method: "get", replace: true });
        }}
        onClear={() => {
          const next = new URLSearchParams(params);
          next.delete("q");
          submit(next, { method: "get", replace: true });
          queryInputRef.current?.focus();
        }}
      />

      <Form
        method="get"
        action="/"
        style={{ display: "grid", gap: 10, marginTop: 10 }}
        onChange={(e) => submit(e.currentTarget, { replace: true })}
      >
        {/* Preserve the query across filter changes. */}
        {query ? <input type="hidden" name="q" value={query} /> : null}

        <div style={filterRowStyle}>
          <label style={selectLabelStyle}>
            <span>Category</span>
            <select
              name="cat"
              defaultValue={category}
              style={controlStyle}
            >
              <option value="">All</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>

          <label style={{ ...selectLabelStyle, position: "relative" }}>
            <span>Tag</span>
            <input
              type="text"
              name="tag"
              value={tagDraft}
              onChange={(e) => {
                setTagDraft(e.target.value);
              }}
              placeholder="e.g. weekend"
              autoComplete="off"
              style={controlStyle}
            />
            {tagSuggestions.length > 0 ? (
              <ul style={suggestListStyle}>
                {tagSuggestions.map((s) => (
                  <li key={s}>
                    <button
                      type="button"
                      onClick={() => {
                        setTagDraft(s);
                        const form = document.querySelector<HTMLFormElement>(
                          "form[action='/']",
                        );
                        if (form) submit(form, { replace: true });
                      }}
                      style={suggestBtnStyle}
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </label>

          <label style={selectLabelStyle}>
            <span>Ingredient</span>
            <input
              type="text"
              name="ing"
              defaultValue={ingredientInclude}
              placeholder="e.g. basil"
              style={controlStyle}
            />
          </label>

          <label style={toggleLabelStyle}>
            <input
              type="checkbox"
              name="fav"
              value="1"
              defaultChecked={favoriteOnly}
              style={{ width: 20, height: 20 }}
            />
            <span>★ Favorites only</span>
          </label>
        </div>
      </Form>

      <header style={{ marginTop: 16 }}>
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>
          {isBrowse ? "Your recipes" : "Search results"}
        </h1>
        <p style={{ color: "#6b655c", margin: "4px 0 0", fontSize: 13 }}>
          {isBrowse
            ? `${result.total} recipe${result.total === 1 ? "" : "s"}`
            : `${result.total} match${result.total === 1 ? "" : "es"} for “${query}”`}
          {" · "}
          <Link to="/add" style={{ color: "#b04a2f" }}>+ Add a recipe</Link>
        </p>
      </header>

      {isBrowse ? (
        <CategoryGrid
          counts={counts}
          activeCategory={category as Category | ""}
          onPick={(c) => {
            const next = new URLSearchParams(params);
            if (c) next.set("cat", c);
            else next.delete("cat");
            submit(next, { method: "get", replace: true });
          }}
        />
      ) : null}

      <section style={{ marginTop: 14 }}>
        {result.hits.length === 0 ? (
          <EmptyState
            isSearch={!isBrowse}
            hasFilters={
              Boolean(category || tag || favoriteOnly || ingredientInclude)
            }
          />
        ) : (
          <ul style={listStyle}>
            {result.hits.map((h) => (
              <RecipeRow key={h.id} hit={h} />
            ))}
          </ul>
        )}
      </section>

      {isSearching ? (
        <p style={{ color: "#6b655c", fontSize: 12, marginTop: 8 }}>
          Updating…
        </p>
      ) : null}
    </main>
  );
}

/* --------------------------- subcomponents --------------------------- */

function StickySearch(props: {
  queryRef: React.MutableRefObject<HTMLInputElement | null>;
  defaultValue: string;
  submitting: boolean;
  onSubmit: (q: string) => void;
  onClear: () => void;
}) {
  const [v, setV] = useState(props.defaultValue);
  useEffect(() => {
    setV(props.defaultValue);
  }, [props.defaultValue]);

  // 250ms debounce: small enough to feel instant, big enough to avoid a
  // request per keystroke on a phone keyboard.
  useEffect(() => {
    if (v === props.defaultValue) return;
    const t = setTimeout(() => props.onSubmit(v), 250);
    return () => clearTimeout(t);
  }, [v, props]);

  return (
    <div style={stickySearchStyle}>
      <form
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit(v);
        }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          ref={props.queryRef}
          type="search"
          name="q"
          value={v}
          onChange={(e) => setV(e.target.value)}
          placeholder="Search recipes, ingredients, tags…"
          autoComplete="off"
          enterKeyHint="search"
          inputMode="search"
          style={searchInputStyle}
          aria-label="Search recipes"
        />
        {v ? (
          <button
            type="button"
            onClick={() => {
              setV("");
              props.onClear();
            }}
            style={clearBtnStyle}
            aria-label="Clear search"
          >
            ×
          </button>
        ) : null}
        {props.submitting ? (
          <span style={{ alignSelf: "center", color: "#6b655c", fontSize: 12 }}>
            …
          </span>
        ) : null}
      </form>
    </div>
  );
}

function CategoryGrid(props: {
  counts: { category: Category; count: number }[];
  activeCategory: Category | "";
  onPick: (c: Category | "") => void;
}) {
  return (
    <nav
      aria-label="Browse by category"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
        gap: 8,
        marginTop: 10,
      }}
    >
      <button
        type="button"
        onClick={() => props.onPick("")}
        style={{
          ...categoryCardStyle,
          borderColor: props.activeCategory === "" ? "#b04a2f" : "#e3ddd2",
          background: props.activeCategory === "" ? "#fdf1ec" : "#fff",
        }}
      >
        <strong>All</strong>
        <span style={catCountStyle}>
          {props.counts.reduce((s, c) => s + c.count, 0)}
        </span>
      </button>
      {props.counts.map((c) => (
        <button
          key={c.category}
          type="button"
          onClick={() => props.onPick(c.category)}
          style={{
            ...categoryCardStyle,
            borderColor:
              props.activeCategory === c.category ? "#b04a2f" : "#e3ddd2",
            background:
              props.activeCategory === c.category ? "#fdf1ec" : "#fff",
          }}
        >
          <strong>{c.category}</strong>
          <span style={catCountStyle}>{c.count}</span>
        </button>
      ))}
    </nav>
  );
}

function RecipeRow({ hit }: { hit: SearchHit }) {
  return (
    <li>
      <Link
        to={`/recipes/${hit.id}`}
        style={rowLinkStyle}
        aria-label={`${hit.title}, category ${hit.category}${
          hit.favorite ? ", favorite" : ""
        }`}
      >
        <span style={{ display: "grid", gap: 2, flex: 1, minWidth: 0 }}>
          <span style={rowTitleStyle}>
            {hit.favorite ? (
              <span aria-hidden style={{ color: "#b04a2f" }}>★ </span>
            ) : null}
            {hit.title}
          </span>
          <span style={rowMetaStyle}>{hit.category}</span>
        </span>
        <span aria-hidden style={{ color: "#c9c1b1" }}>›</span>
      </Link>
    </li>
  );
}

function EmptyState(props: { isSearch: boolean; hasFilters: boolean }) {
  if (props.isSearch) {
    return (
      <p style={{ color: "#6b655c", padding: "20px 0" }}>
        No matches. Try a shorter word, or clear the filters.
      </p>
    );
  }
  if (props.hasFilters) {
    return (
      <p style={{ color: "#6b655c", padding: "20px 0" }}>
        Nothing here with those filters. Try clearing one.
      </p>
    );
  }
  return (
    <div style={{ padding: "20px 0", color: "#6b655c" }}>
      <p style={{ margin: "0 0 12px" }}>No recipes yet.</p>
      <Link to="/add" style={primaryLinkStyle}>+ Add your first recipe</Link>
    </div>
  );
}

/* ------------------------------- styles ------------------------------- */

const shellStyle: React.CSSProperties = {
  fontFamily: "system-ui, sans-serif",
  padding: "0 0 8rem",
  maxWidth: 720,
  margin: "0 auto",
};

const stickySearchStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: "#fdfcf8",
  padding: "10px 12px 8px",
  margin: "0 -12px",
  zIndex: 10,
  borderBottom: "1px solid #e3ddd2",
};

const searchInputStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 44,
  fontSize: 16,
  padding: "10px 14px",
  borderRadius: 999,
  border: "1px solid #c9c1b1",
  background: "#fff",
  font: "inherit",
};

const clearBtnStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #c9c1b1",
  background: "#fff",
  width: 44,
  height: 44,
  borderRadius: 999,
  fontSize: 22,
  cursor: "pointer",
};

const filterRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: 8,
  padding: "0 4px",
};

const selectLabelStyle: React.CSSProperties = {
  display: "grid",
  gap: 4,
  fontSize: 12,
  color: "#6b655c",
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};

const controlStyle: React.CSSProperties = {
  minHeight: 40,
  padding: "8px 10px",
  borderRadius: 10,
  border: "1px solid #c9c1b1",
  background: "#fff",
  fontSize: 15,
  textTransform: "none",
  letterSpacing: "normal",
  color: "#1f1d1a",
  font: "inherit",
};

const toggleLabelStyle: React.CSSProperties = {
  gridColumn: "1 / -1",
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  fontSize: 14,
  padding: "8px 4px",
  textTransform: "none",
  letterSpacing: "normal",
  color: "#1f1d1a",
};

const suggestListStyle: React.CSSProperties = {
  position: "absolute",
  top: "100%",
  left: 0,
  right: 0,
  margin: "2px 0 0",
  padding: 4,
  listStyle: "none",
  background: "#fff",
  border: "1px solid #c9c1b1",
  borderRadius: 10,
  zIndex: 5,
  maxHeight: 220,
  overflowY: "auto",
};

const suggestBtnStyle: React.CSSProperties = {
  appearance: "none",
  background: "transparent",
  border: "none",
  width: "100%",
  textAlign: "left",
  padding: "8px 10px",
  borderRadius: 6,
  cursor: "pointer",
  font: "inherit",
  color: "inherit",
};

const listStyle: React.CSSProperties = {
  listStyle: "none",
  padding: 0,
  margin: 0,
  display: "grid",
  gap: 6,
};

const rowLinkStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "14px 14px",
  borderRadius: 12,
  border: "1px solid #e3ddd2",
  background: "#fff",
  textDecoration: "none",
  color: "inherit",
  minHeight: 56,
};

const rowTitleStyle: React.CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const rowMetaStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#6b655c",
  textTransform: "lowercase",
};

const categoryCardStyle: React.CSSProperties = {
  appearance: "none",
  border: "1px solid #e3ddd2",
  background: "#fff",
  borderRadius: 12,
  padding: "12px 14px",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  cursor: "pointer",
  font: "inherit",
  color: "inherit",
  minHeight: 56,
  textTransform: "capitalize",
};

const catCountStyle: React.CSSProperties = {
  color: "#6b655c",
  fontSize: 13,
  fontWeight: 500,
};

const primaryLinkStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "10px 16px",
  background: "#b04a2f",
  color: "#fff",
  borderRadius: 999,
  textDecoration: "none",
  fontWeight: 600,
};
