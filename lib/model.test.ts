import { describe, expect, it } from "vitest";

import { configKey, lineIsComplete } from "./model";

describe("turning what people type into a document id", () => {
  it("survives the characters that are actually on a drawing", () => {
    // A Firestore id may not contain a slash, and part numbers are full of
    // them. It may not begin with two dots either.
    for (const awkward of ["PN-1042/A", "1.2379/D2", "Core insert", "PN#1042", "..hidden"]) {
      const key = configKey(awkward);
      expect(key).not.toContain("/");
      expect(key.startsWith("..")).toBe(false);
      expect(key.startsWith("i_")).toBe(true);
    }
  });

  it("uses no encoding name a browser might not know", () => {
    // `base64url` exists in Node and not in the Buffer polyfill a bundle gets.
    // The difference only shows up in production, as an id that cannot be
    // written — so the characters are swapped by hand instead.
    expect(configKey("a/b+c")).toMatch(/^i_[A-Za-z0-9_-]+$/);
  });

  it("gives one key to one value however it was typed", () => {
    expect(configKey("Core")).toBe(configKey("  core  "));
    expect(configKey("Core")).not.toBe(configKey("Cavity"));
  });

  it("handles a code that is not Latin", () => {
    expect(configKey("قلب")).toMatch(/^i_[A-Za-z0-9_-]+$/);
    expect(configKey("قلب")).not.toBe(configKey("غطاء"));
  });
});

describe("what planning means by Complete", () => {
  it("is true when no piece on the line is waiting on quality", () => {
    expect(lineIsComplete({ total: 5, withQc: 0, inRework: 2, closed: 3, measurements: 9 })).toBe(true);
    expect(lineIsComplete({ total: 5, withQc: 1, inRework: 1, closed: 3, measurements: 9 })).toBe(false);
  });

  it("is false for a line with nothing on it, rather than vacuously true", () => {
    expect(lineIsComplete({ total: 0, withQc: 0, inRework: 0, closed: 0, measurements: 0 })).toBe(false);
  });
});
