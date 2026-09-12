/** The indexes the real Firestore insists on, which the emulator never asks
 *  for.
 *
 *  The emulator answers any query put to it. Production refuses one that
 *  combines a filter with a sort on a different field unless an index exists
 *  for exactly that shape, and refuses it whether or not a single document
 *  matches. A suite that is green against the emulator therefore says nothing
 *  about whether the queue opens in the factory.
 *
 *  Nothing can prove this list complete without a real project. What it can do
 *  is refuse to let the query surface change quietly: filter on a new field,
 *  or sort by one, and this fails until somebody has gone and thought about
 *  the indexes.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// Both files run queries: the reads a page makes, and the ones an action
// makes to find what it is about to change.
const source = ["lib/client/queries.ts", "lib/client/actions.ts"]
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const indexFile = JSON.parse(readFileSync("firestore.indexes.json", "utf8")) as {
  indexes: {
    collectionGroup: string;
    queryScope: string;
    fields: { fieldPath: string; order: string }[];
  }[];
};

const shape = (index: (typeof indexFile.indexes)[number]) =>
  `${index.collectionGroup}(${index.fields
    .map((f) => `${f.fieldPath} ${f.order === "DESCENDING" ? "desc" : "asc"}`)
    .join(", ")})`;

/** Every compound query in the application, and the index that serves it.
 *  Written out rather than derived, because the derivation is the thing most
 *  likely to be wrong. */
const REQUIRED = [
  ["a stage's queue — what to measure and what is in rework", "pieces(stage asc, state asc, plannedAt asc)"],
  ["the dashboard's oldest-waiting list", "pieces(state asc, plannedAt asc)"],
  ["the pieces cut from one planning line", "pieces(lineId asc, pieceNo asc)"],
  ["a piece's measurement history", "inspections(pieceId asc, inspectedAt desc)"],
  ["a piece's rework history", "reworks(pieceId asc, heldAt desc)"],
] as const;

/** Sorting alone, or filtering alone, is served by the single-field indexes
 *  Firestore keeps for free. So is a query with only equality filters, which
 *  it answers by merging those. Only the combinations need declaring. */
const FILTERED_FIELDS = [
  // `active` and `role` are the pair that counts the remaining administrators
  // before letting one deactivate another. Two equality filters and no sort,
  // which Firestore answers by merging single-field indexes.
  "active",
  "completedAt",
  "lineId",
  "pieceId",
  "role",
  "stage",
  "state",
];
const SORTED_FIELDS = [
  "at",
  "capturedAt",
  "displayName",
  "heldAt",
  "inspectedAt",
  "itemCode",
  "pieceNo",
  "plannedAt",
];

const found = (call: string) =>
  [
    ...new Set(
      Array.from(source.matchAll(new RegExp(`${call}\\("([a-zA-Z]+)"`, "g")), (m) => m[1])
    ),
  ].sort();

describe("the composite indexes production will insist on", () => {
  it("declares one for every compound query the pages run", () => {
    expect(indexFile.indexes.map(shape).sort()).toEqual(REQUIRED.map(([, s]) => s).sort());
  });

  it("asks for nothing Firestore would build on its own", () => {
    for (const index of indexFile.indexes) expect(index.fields.length).toBeGreaterThan(1);
  });

  it("sorts on the last field and filters on the ones before it", () => {
    // Firestore matches an index by prefix: every equality field first, the
    // sort field last. One written the other way round is never used.
    for (const index of indexFile.indexes) {
      const sortField = index.fields.at(-1)!.fieldPath;
      expect(SORTED_FIELDS, `${shape(index)} sorts on a field nothing sorts on`).toContain(sortField);
      for (const field of index.fields.slice(0, -1))
        expect(FILTERED_FIELDS, `${shape(index)} filters on a field nothing filters on`).toContain(
          field.fieldPath
        );
    }
  });
});

describe("the query surface these were worked out from", () => {
  it("filters on the fields it filtered on when the indexes were written", () => {
    expect(found("where")).toEqual(FILTERED_FIELDS);
  });

  it("sorts by the fields it sorted by when the indexes were written", () => {
    expect(found("orderBy")).toEqual(SORTED_FIELDS);
  });
});
