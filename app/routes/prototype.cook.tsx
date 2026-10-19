/**
 * THROWAWAY PROTOTYPE — issue #17 "Cook mode step-focus UX" (Map #14).
 *
 * QUESTION: while cooking, which layout keeps the cook's place with the least
 * scrolling and the fewest mis-taps — one giant step at a time, a scrolling
 * page with a sticky progress header, or a split board that keeps ingredients
 * permanently in view?
 *
 * VARIANTS (switch with ?variant=A|B|C, default A; the floating bar at the
 * bottom cycles them, arrow keys also work):
 *   A StepFocus    — one huge step, prev/next, dots, ingredient sheet, wake lock.
 *   B ScrollSticky — scrolling steps, sticky progress header, tap to advance.
 *   C SplitBoard   — persistent ingredients rail + stacked step cards.
 *
 * This route renders a hard-coded fake recipe (app/prototype/cook/fake-recipe.ts).
 * It deliberately has NO loader, so it bypasses requireAuth and needs no DB.
 * Nothing is persisted, there are no tests, and every piece of state is local.
 * Delete app/prototype/ and this route once #17 is decided.
 */
import { useSearchParams } from "react-router";
import { FAKE_RECIPE } from "../prototype/cook/fake-recipe";
import { CookVariantSwitcher } from "../prototype/cook/CookVariantSwitcher";
import { VariantA } from "../prototype/cook/VariantA";
import { VariantB } from "../prototype/cook/VariantB";
import { VariantC } from "../prototype/cook/VariantC";
import { parseVariant } from "../prototype/cook/variants";

export function meta() {
  return [{ title: "Prototype: Cook mode — recipedb" }];
}

export default function PrototypeCookRoute() {
  const [params] = useSearchParams();
  const variant = parseVariant(params.get("variant"));

  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#faf7f2",
        color: "#211d18",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <div
        style={{
          borderBottom: "1px dashed #c9c1b1",
          background: "#fff8e8",
          padding: "7px 12px",
          fontSize: 11,
          letterSpacing: "0.04em",
          color: "#6b655c",
          textAlign: "center",
        }}
      >
        Throwaway prototype · issue #17 · fake data, no auth, nothing saved ·{" "}
        <strong style={{ color: "#3a332b" }}>?variant={variant}</strong>
      </div>

      {variant === "A" ? <VariantA recipe={FAKE_RECIPE} /> : null}
      {variant === "B" ? <VariantB recipe={FAKE_RECIPE} /> : null}
      {variant === "C" ? <VariantC recipe={FAKE_RECIPE} /> : null}

      <CookVariantSwitcher variant={variant} />
    </div>
  );
}
