import { describe, expect, it } from "vitest";

import { facetValues, matchesFacet, matchesText } from "./filter";

describe("searching a list of work", () => {
  const row = ["MM260001", "Core", "Core insert", "MM260001-Core-003"];

  it("finds a row by any of the things it is known by", () => {
    for (const q of ["MM260001", "core", "insert", "003"]) {
      expect(matchesText(row, q)).toBe(true);
    }
  });

  it("matches on part of a project number, because nobody types the whole one", () => {
    expect(matchesText(row, "2600")).toBe(true);
  });

  it("narrows as you type more, rather than widening", () => {
    // Two terms that each match on their own, but name different rows
    // together, must not come back as a match.
    expect(matchesText(row, "core insert")).toBe(true);
    expect(matchesText(row, "core cavity")).toBe(false);
  });

  it("ignores case and stray spacing", () => {
    expect(matchesText(row, "  CORE   InSeRt ")).toBe(true);
  });

  it("shows everything when nothing has been typed", () => {
    expect(matchesText(row, "")).toBe(true);
    expect(matchesText(row, "   ")).toBe(true);
  });

  it("does not match a blank field against a blank-looking term", () => {
    expect(matchesText([null, undefined, ""], "x")).toBe(false);
  });

  it("searches numbers as readily as text", () => {
    expect(matchesText(["Core", 12], "12")).toBe(true);
  });
});

describe("a facet", () => {
  it("means any when nothing is chosen", () => {
    expect(matchesFacet("A", "")).toBe(true);
    expect(matchesFacet(null, "")).toBe(true);
  });

  it("keeps only the rows carrying the chosen value", () => {
    expect(matchesFacet("A", "A")).toBe(true);
    expect(matchesFacet("B", "A")).toBe(false);
  });

  it("treats a missing value as not matching a real choice", () => {
    expect(matchesFacet(null, "A")).toBe(false);
    expect(matchesFacet(undefined, "A")).toBe(false);
  });
});

describe("the values a facet offers", () => {
  const rows = [{ p: "B" }, { p: "A" }, { p: "B" }, { p: null }, { p: "  " }, { p: "C" }];

  it("offers each value once, in order", () => {
    expect(facetValues(rows, (r) => r.p)).toEqual(["A", "B", "C"]);
  });

  it("never offers a blank, which would filter to nothing", () => {
    expect(facetValues(rows, (r) => r.p)).not.toContain("");
  });

  it("orders numbers the way a person reads them", () => {
    const n = [{ p: "10" }, { p: "9" }, { p: "2" }];
    expect(facetValues(n, (r) => r.p)).toEqual(["2", "9", "10"]);
  });

  it("offers nothing for an empty list", () => {
    expect(facetValues([], (r: { p: string }) => r.p)).toEqual([]);
  });
});
