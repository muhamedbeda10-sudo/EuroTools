/** The indexes the real Firestore needs, which the emulator never asks for.
 *
 *  The emulator answers any query put to it. Production refuses a query that
 *  combines a filter with a sort on a different field unless a composite index
 *  exists for exactly that shape, and it refuses it whether or not a single
 *  document matches. So a suite that is green against the emulator says
 *  nothing about whether the queue page opens in the factory.
 *
 *  Nothing can prove this file complete without running against a real
 *  project. What it can do is refuse to let the query surface change quietly:
 *  filter on a new field, or sort by one, and this fails until somebody has
 *  gone and thought about the index.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync("lib/client/queries.ts", "utf8");
const indexFile = JSON.parse(readFileSync("firestore.indexes.json", "utf8")) as {
  indexes: { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order: string }[] }[];
  fieldOverrides: unknown[];
};

/** `collection(field asc, field desc, …)`, which is how an index reads once
 *  you stop looking at the JSON. */
const shape = (index: (typeof indexFile.indexes)[number]) =>
  `${index.collectionGroup}(${index.fields
    .map((f) => `${f.fieldPath} ${f.order === "DESCENDING" ? "desc" : "asc"}`)
    .join(", ")})`;

/** Every compound query in the application, and the index that serves it.
 *  Written out rather than derived, because the derivation is the thing most
 *  likely to be wrong. */
const REQUIRED = [
  ["lot detail — the inspections filed against a lot", "inspections(lotId asc, inspectedAt desc)"],
  ["part history, and the traveller's batched read", "inspections(partId asc, inspectedAt desc)"],
  ["out-of-tolerance report — the last fifty", "inspections(hasFailedMeasurement asc, inspectedAt desc)"],
  ["lot detail — the parts cut from a lot", "parts(lotId asc, serialNumber asc)"],
  ["queue filtered by stage", "parts(currentStage asc, serialNumber asc)"],
  ["queue filtered by status, and the open-work list", "parts(status asc, serialNumber asc)"],
  ["queue filtered by stage and status together", "parts(currentStage asc, status asc, serialNumber asc)"],
  ["released parts report", "parts(status asc, updatedAt desc)"],
] as const;

/** Sorting alone, or filtering alone, is served by the single-field indexes
 *  Firestore maintains for free. Only the combinations above need declaring. */
const FILTERED_FIELDS = ["currentStage", "hasFailedMeasurement", "lotId", "partId", "stage", "status"];
const SORTED_FIELDS = [
  "at",
  "displayName",
  "inspectedAt",
  "name",
  "partNumber",
  "performedAt",
  "receivedAt",
  "serialNumber",
  "updatedAt",
];

const found = (call: string) =>
  [...new Set(Array.from(source.matchAll(new RegExp(`${call}\\("([a-zA-Z]+)"`, "g")), (m) => m[1]))].sort();

describe("the composite indexes production will insist on", () => {
  it("declares one for every compound query the pages run", () => {
    expect(indexFile.indexes.map(shape).sort()).toEqual(REQUIRED.map(([, s]) => s).sort());
  });

  it("asks for nothing Firestore would build on its own", () => {
    // A single-field index is automatic, so declaring one is a sign the shape
    // was copied from an error message rather than worked out.
    for (const index of indexFile.indexes) expect(index.fields.length).toBeGreaterThan(1);
  });

  it("sorts on the last field and filters on the ones before it", () => {
    // Firestore matches an index by prefix: every equality field first, the
    // sort field last. An index written the other way round is never used.
    for (const index of indexFile.indexes) {
      const sortField = index.fields.at(-1)!.fieldPath;
      expect(SORTED_FIELDS, `${shape(index)} sorts on a field nothing sorts on`).toContain(sortField);

      for (const field of index.fields.slice(0, -1))
        expect(FILTERED_FIELDS, `${shape(index)} filters on a field nothing filters on`).toContain(field.fieldPath);
    }
  });
});

describe("the query surface these were worked out from", () => {
  // These two are the tripwire. They fail on any new filter or sort, which is
  // exactly when the index list needs looking at again.
  it("filters on the fields it filtered on when the indexes were written", () => {
    expect(found("where")).toEqual(FILTERED_FIELDS);
  });

  it("sorts by the fields it sorted by when the indexes were written", () => {
    expect(found("orderBy")).toEqual(SORTED_FIELDS);
  });
});
