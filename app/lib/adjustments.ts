import type { SaveEvent } from "../db/schema.server";
import type {
  DraftIngredient,
  DraftPage,
  DraftStep,
  RecipeDraft,
} from "./draft";
import { isHumanOrigin } from "./save-events.server";

export type SaveEventRow = SaveEvent;

export type ScalarAdjustmentField =
  | "title"
  | "category"
  | "yieldText"
  | "favorite"
  | "sourceUrl"
  | "imageFilename";

export interface FieldAdjustment {
  kind: "field";
  action: "modify";
  field: ScalarAdjustmentField;
  before: string | boolean | null;
  after: string | boolean | null;
}

export interface TagAdjustment {
  kind: "tag";
  action: "add" | "remove";
  before: string | null;
  after: string | null;
}

export interface IngredientChange {
  kind: "ingredient";
  action: "modify" | "add" | "remove";
  before: DraftIngredient | null;
  after: DraftIngredient | null;
  beforeIndex: number | null;
  afterIndex: number | null;
}

export interface StepChange {
  kind: "step";
  action: "modify" | "add" | "remove";
  before: DraftStep | null;
  after: DraftStep | null;
  beforeIndex: number | null;
  afterIndex: number | null;
}

export type Adjustment =
  | FieldAdjustment
  | TagAdjustment
  | IngredientChange
  | StepChange;

export interface PageTextChange {
  pageNo: number;
  before: string | null;
  after: string | null;
  changed: boolean;
}

export interface RecipeAdjustment {
  eventId: number;
  recipeId: number;
  timestamp: Date;
  captureMode: SaveEvent["captureMode"];
  origin: "import" | "human" | "machine";
  adjustments: Adjustment[];
  pageChanges: PageTextChange[];
}

interface LinePair<T> {
  before: T;
  after: T;
  beforeIndex: number;
  afterIndex: number;
}

const SCALAR_FIELDS: readonly {
  field: ScalarAdjustmentField;
  read: (draft: RecipeDraft) => string | boolean | null;
}[] = [
  { field: "title", read: (draft) => draft.title },
  { field: "category", read: (draft) => draft.category },
  { field: "yieldText", read: (draft) => draft.yield },
  { field: "favorite", read: (draft) => draft.favorite },
  { field: "sourceUrl", read: (draft) => draft.sourceUrl },
  {
    field: "imageFilename",
    read: (draft) => draft.imageFilename ?? null,
  },
];

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizedText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

function textSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizedText(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizedText(right).split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

function pairLines<T>(
  before: readonly T[],
  after: readonly T[],
  textOf: (line: T) => string,
  positionOf?: (line: T) => number,
): LinePair<T>[] {
  const pairs: LinePair<T>[] = [];
  const usedBefore = new Set<number>();
  const usedAfter = new Set<number>();

  // Preserve exact matches at their position first. A line shifted by an
  // insertion/deletion can then be recovered by similarity instead.
  before.forEach((line, beforeIndex) => {
    const afterIndex =
      positionOf === undefined
        ? beforeIndex
        : after.findIndex(
            (candidate, index) =>
              !usedAfter.has(index) &&
              positionOf(candidate) === positionOf(line),
          );
    if (
      afterIndex >= 0 &&
      afterIndex < after.length &&
      !usedAfter.has(afterIndex) &&
      normalizedText(textOf(line)) === normalizedText(textOf(after[afterIndex]!))
    ) {
      usedBefore.add(beforeIndex);
      usedAfter.add(afterIndex);
      pairs.push({ before: line, after: after[afterIndex]!, beforeIndex, afterIndex });
    }
  });

  // Then greedily match remaining lines by best token Jaccard similarity.
  // Ties resolve by original before index, then after index; scores below 0.5
  // are considered unrelated, so they become a removal plus an addition.
  const candidates: {
    beforeIndex: number;
    afterIndex: number;
    similarity: number;
  }[] = [];
  before.forEach((beforeLine, beforeIndex) => {
    if (usedBefore.has(beforeIndex)) return;
    after.forEach((afterLine, afterIndex) => {
      if (usedAfter.has(afterIndex)) return;
      const similarity = textSimilarity(textOf(beforeLine), textOf(afterLine));
      if (similarity >= 0.5) {
        candidates.push({ beforeIndex, afterIndex, similarity });
      }
    });
  });
  candidates.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.beforeIndex - right.beforeIndex ||
      left.afterIndex - right.afterIndex,
  );
  for (const candidate of candidates) {
    if (usedBefore.has(candidate.beforeIndex) || usedAfter.has(candidate.afterIndex)) {
      continue;
    }
    usedBefore.add(candidate.beforeIndex);
    usedAfter.add(candidate.afterIndex);
    pairs.push({
      before: before[candidate.beforeIndex]!,
      after: after[candidate.afterIndex]!,
      beforeIndex: candidate.beforeIndex,
      afterIndex: candidate.afterIndex,
    });
  }

  // Remaining same-position lines are modifications; only after that are
  // unmatched tail lines classified as additions/removals.
  before.forEach((line, beforeIndex) => {
    if (usedBefore.has(beforeIndex)) return;
    const afterIndex =
      positionOf === undefined
        ? beforeIndex
        : after.findIndex(
            (candidate, index) =>
              !usedAfter.has(index) &&
              positionOf(candidate) === positionOf(line),
          );
    if (afterIndex >= 0 && afterIndex < after.length && !usedAfter.has(afterIndex)) {
      usedBefore.add(beforeIndex);
      usedAfter.add(afterIndex);
      pairs.push({ before: line, after: after[afterIndex]!, beforeIndex, afterIndex });
    }
  });
  return pairs.sort(
    (left, right) => left.beforeIndex - right.beforeIndex || left.afterIndex - right.afterIndex,
  );
}

function diffLines<T extends DraftIngredient | DraftStep>(
  before: readonly T[],
  after: readonly T[],
  kind: "ingredient" | "step",
): Adjustment[] {
  const positionOf =
    kind === "step"
      ? (line: T) => ("position" in line ? line.position : -1)
      : undefined;
  const pairs = pairLines(
    before,
    after,
    (line) => line.text,
    positionOf,
  );
  const usedBefore = new Set(pairs.map((pair) => pair.beforeIndex));
  const usedAfter = new Set(pairs.map((pair) => pair.afterIndex));
  const changes: Adjustment[] = [];

  for (const pair of pairs) {
    if (!sameValue(pair.before, pair.after)) {
      if (kind === "ingredient") {
        changes.push({
          kind,
          action: "modify",
          before: pair.before as DraftIngredient,
          after: pair.after as DraftIngredient,
          beforeIndex: pair.beforeIndex,
          afterIndex: pair.afterIndex,
        });
      } else {
        changes.push({
          kind,
          action: "modify",
          before: pair.before as DraftStep,
          after: pair.after as DraftStep,
          beforeIndex: pair.beforeIndex,
          afterIndex: pair.afterIndex,
        });
      }
    }
  }
  before.forEach((line, beforeIndex) => {
    if (!usedBefore.has(beforeIndex)) {
      if (kind === "ingredient") {
        changes.push({
          kind,
          action: "remove",
          before: line as DraftIngredient,
          after: null,
          beforeIndex,
          afterIndex: null,
        });
      } else {
        changes.push({
          kind,
          action: "remove",
          before: line as DraftStep,
          after: null,
          beforeIndex,
          afterIndex: null,
        });
      }
    }
  });
  after.forEach((line, afterIndex) => {
    if (!usedAfter.has(afterIndex)) {
      if (kind === "ingredient") {
        changes.push({
          kind,
          action: "add",
          before: null,
          after: line as DraftIngredient,
          beforeIndex: null,
          afterIndex,
        });
      } else {
        changes.push({
          kind,
          action: "add",
          before: null,
          after: line as DraftStep,
          beforeIndex: null,
          afterIndex,
        });
      }
    }
  });
  return changes;
}

export function diffDrafts(before: RecipeDraft, after: RecipeDraft): Adjustment[] {
  const adjustments: Adjustment[] = [];
  for (const { field, read } of SCALAR_FIELDS) {
    const beforeValue = read(before);
    const afterValue = read(after);
    if (!sameValue(beforeValue, afterValue)) {
      adjustments.push({
        kind: "field",
        action: "modify",
        field,
        before: beforeValue,
        after: afterValue,
      });
    }
  }

  const beforeTags = new Set(before.tags);
  const afterTags = new Set(after.tags);
  for (const tag of [...afterTags].filter((value) => !beforeTags.has(value)).sort()) {
    adjustments.push({ kind: "tag", action: "add", before: null, after: tag });
  }
  for (const tag of [...beforeTags].filter((value) => !afterTags.has(value)).sort()) {
    adjustments.push({ kind: "tag", action: "remove", before: tag, after: null });
  }

  adjustments.push(...diffLines(before.ingredients, after.ingredients, "ingredient"));
  adjustments.push(...diffLines(before.steps, after.steps, "step"));
  return adjustments;
}

export function pageTextChanges(
  before: readonly DraftPage[] | undefined,
  after: readonly DraftPage[] | undefined,
): PageTextChange[] {
  const beforeByNo = new Map((before ?? []).map((page) => [page.pageNo, page.text]));
  const afterByNo = new Map((after ?? []).map((page) => [page.pageNo, page.text]));
  return [...new Set([...beforeByNo.keys(), ...afterByNo.keys()])]
    .sort((left, right) => left - right)
    .map((pageNo) => {
      const beforeText = beforeByNo.get(pageNo) ?? null;
      const afterText = afterByNo.get(pageNo) ?? null;
      return {
        pageNo,
        before: beforeText,
        after: afterText,
        changed: beforeText !== afterText,
      };
    });
}

function decodeDraft(json: string): RecipeDraft {
  return JSON.parse(json) as RecipeDraft;
}

function makeEventAdjustment(
  event: SaveEventRow,
  before: RecipeDraft,
  after: RecipeDraft,
  origin: RecipeAdjustment["origin"],
): RecipeAdjustment {
  return {
    eventId: event.id,
    recipeId: event.recipeId,
    timestamp: event.createdAt,
    captureMode: event.captureMode,
    origin,
    adjustments: diffDrafts(before, after),
    pageChanges: pageTextChanges(before.pages, after.pages),
  };
}

export function deriveRecipeAdjustments(events: SaveEventRow[]): {
  adjustments: RecipeAdjustment[];
  machineAdjustments: RecipeAdjustment[];
} {
  const adjustments: RecipeAdjustment[] = [];
  const machineAdjustments: RecipeAdjustment[] = [];
  let previousSaved: RecipeDraft | null = null;

  const chronologicalEvents = [...events].sort(
    (left, right) =>
      left.createdAt.getTime() - right.createdAt.getTime() || left.id - right.id,
  );
  for (const event of chronologicalEvents) {
    const saved = decodeDraft(event.savedJson);
    const recognized =
      event.recognizedJson === null ? null : decodeDraft(event.recognizedJson);
    if (isHumanOrigin(event.captureMode)) {
      const before = previousSaved ?? recognized;
      if (before !== null) {
        const origin = previousSaved === null ? "import" : "human";
        const group = makeEventAdjustment(event, before, saved, origin);
        if (group.adjustments.length > 0 || group.pageChanges.some((page) => page.changed)) {
          adjustments.push(group);
        }
      }
    } else {
      const before = previousSaved ?? recognized;
      if (before !== null) {
        const group = makeEventAdjustment(event, before, saved, "machine");
        if (group.adjustments.length > 0 || group.pageChanges.some((page) => page.changed)) {
          machineAdjustments.push(group);
        }
      }
    }
    previousSaved = saved;
  }

  return { adjustments, machineAdjustments };
}
