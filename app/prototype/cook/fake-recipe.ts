/**
 * THROWAWAY PROTOTYPE DATA — issue #17 "Cook mode step-focus UX" (Map #14).
 *
 * A hard-coded, realistic home-cooking recipe so the prototype runs with no
 * database, no auth, and no seeded recipe. Do not import this from real code.
 */
import type { DraftIngredient, DraftStep } from "../../lib/draft";

export interface PrototypeRecipe {
  title: string;
  yield: string;
  totalTime: string;
  ingredients: DraftIngredient[];
  steps: DraftStep[];
}

function ing(
  text: string,
  qty: string,
  unit: string | null,
  item: string,
  note: string | null = null,
): DraftIngredient {
  return { text, qty, unit, item, note, confidence: qty.trim() ? "ok" : "warn" };
}

function step(position: number, text: string): DraftStep {
  return { position, text };
}

export const FAKE_RECIPE: PrototypeRecipe = {
  title: "Weeknight Chickpea & Spinach Curry",
  yield: "Serves 4",
  totalTime: "35 min",
  ingredients: [
    ing("2 tbsp olive oil", "2", "tbsp", "olive oil"),
    ing("1 large yellow onion, finely diced", "1", null, "yellow onion", "large, finely diced"),
    ing("3 cloves garlic, minced", "3", "clove", "garlic", "minced"),
    ing("1 tbsp fresh ginger, grated", "1", "tbsp", "ginger", "fresh, grated"),
    ing("2 tsp ground cumin", "2", "tsp", "ground cumin"),
    ing("1 tsp smoked paprika", "1", "tsp", "smoked paprika"),
    ing("1 (14 oz) can chickpeas, drained and rinsed", "1", "can", "chickpeas", "14 oz, drained and rinsed"),
    ing("1 (13.5 oz) can full-fat coconut milk", "1", "can", "coconut milk", "full-fat, 13.5 oz"),
    ing("5 oz baby spinach", "5", "oz", "baby spinach"),
    ing("1/2 lemon, juiced", "1/2", null, "lemon", "juiced"),
    ing("Salt and black pepper, to taste", "to taste", null, "salt and black pepper"),
    ing("Cooked basmati rice or flatbread, to serve", "", null, "basmati rice or flatbread", "to serve"),
  ],
  steps: [
    step(1, "Warm the olive oil in a wide, deep skillet over medium heat until it shimmers, about 1 minute."),
    step(2, "Add the onion with a pinch of salt. Cook, stirring occasionally, until soft and translucent, 6 to 8 minutes."),
    step(3, "Stir in the garlic, ginger, cumin, and smoked paprika. Cook for 45 seconds, until fragrant — do not let the spices scorch."),
    step(4, "Add the chickpeas and toss to coat in the aromatics. Pour in the coconut milk and 1/2 cup water, then simmer for 8 minutes."),
    step(5, "Add the spinach a handful at a time, folding it in as it wilts, 2 to 3 minutes."),
    step(6, "Taste and season with lemon juice, salt, and pepper. Simmer 2 more minutes so the flavours marry."),
    step(7, "Spoon over basmati rice or serve with flatbread. Leftovers keep in the fridge for 3 days."),
  ],
};
