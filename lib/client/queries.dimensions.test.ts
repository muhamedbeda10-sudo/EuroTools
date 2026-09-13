import { describe, expect, it } from "vitest";

import { mergeDimensions } from "./queries";
import type { DimensionSpec } from "../model";

const dim = (over: Partial<DimensionSpec> & { key: string }): DimensionSpec => ({
  name: over.key,
  unit: "mm",
  nominal: null,
  tolMinus: null,
  tolPlus: null,
  ...over,
});

describe("carrying a drawing forward to the next piece", () => {
  it("fills an unconfigured item from the sheet before it", () => {
    // The whole point: five pieces of one part are measured against one
    // drawing. Having typed the nominal and the tolerance on the first piece,
    // the inspector should be typing only the reading on the other four.
    const merged = mergeDimensions(
      [],
      [dim({ key: "len", name: "Length", nominal: 120, tolMinus: -0.2, tolPlus: 0.2 })]
    );

    expect(merged).toEqual([
      { key: "len", name: "Length", unit: "mm", nominal: 120, tolMinus: -0.2, tolPlus: 0.2 },
    ]);
  });

  it("lets the item's own configuration win over what was typed last time", () => {
    // A sheet that disagreed with the configuration was somebody working round
    // it, not a new standard. The configured drawing is the authority.
    const merged = mergeDimensions(
      [dim({ key: "len", name: "Length", nominal: 120, tolMinus: -0.1, tolPlus: 0.1 })],
      [dim({ key: "len", name: "Length", nominal: 119, tolMinus: -5, tolPlus: 5 })]
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ nominal: 120, tolMinus: -0.1, tolPlus: 0.1 });
  });

  it("keeps a dimension the inspector added that the configuration does not cover", () => {
    const merged = mergeDimensions(
      [dim({ key: "len", name: "Length" })],
      [dim({ key: "len", name: "Length" }), dim({ key: "adhoc_1_k3", name: "Weld gap" })]
    );

    expect(merged.map((d) => d.key)).toEqual(["len", "adhoc_1_k3"]);
  });

  it("puts the configured dimensions first so the sheet does not reshuffle between pieces", () => {
    // Rows that move between piece 1 and piece 2 are rows an inspector fills in
    // by position and gets wrong.
    const merged = mergeDimensions(
      [dim({ key: "a" }), dim({ key: "b" })],
      [dim({ key: "extra" }), dim({ key: "b" }), dim({ key: "a" })]
    );

    expect(merged.map((d) => d.key)).toEqual(["a", "b", "extra"]);
  });

  it("leaves a configured item alone when there is no sheet before it", () => {
    const configured = [dim({ key: "len", name: "Length", nominal: 120 })];
    expect(mergeDimensions(configured, [])).toEqual(configured);
  });

  it("asks for nothing when the item is unconfigured and has never been measured", () => {
    // The first piece of a brand-new part: the inspector adds what they
    // measured, and that becomes the drawing the rest inherit.
    expect(mergeDimensions([], [])).toEqual([]);
  });

  it("does not mutate either list it was given", () => {
    const configured = [dim({ key: "a" })];
    const previous = [dim({ key: "b" })];
    mergeDimensions(configured, previous);

    expect(configured.map((d) => d.key)).toEqual(["a"]);
    expect(previous.map((d) => d.key)).toEqual(["b"]);
  });
});
