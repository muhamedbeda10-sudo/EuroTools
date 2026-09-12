import { describe, expect, it } from "vitest";

import { parseCsv } from "./csv";

describe("reading a CSV the way Excel exports one", () => {
  it("reads plain rows", () => {
    expect(parseCsv("a,b,c\n1,2,3")).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("keeps a comma that is inside quotes", () => {
    // A description reading "core, cavity" is one field, not two.
    expect(parseCsv('item,description\nCore,"core, cavity"')).toEqual([
      ["item", "description"],
      ["Core", "core, cavity"],
    ]);
  });

  it("reads a doubled quote as one quote", () => {
    expect(parseCsv('a\n"say ""hello"""')).toEqual([["a"], ['say "hello"']]);
  });

  it("keeps a newline that is inside quotes", () => {
    expect(parseCsv('a,b\n"line one\nline two",x')).toEqual([
      ["a", "b"],
      ["line one\nline two", "x"],
    ]);
  });

  it("survives Windows line endings and the mark Excel puts at the front", () => {
    expect(parseCsv("﻿a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps an empty trailing field rather than dropping the column", () => {
    // A blank priority at the end of a row must not shorten the row, or every
    // column after it reads one place to the left.
    expect(parseCsv("a,b,c\n1,,")).toEqual([
      ["a", "b", "c"],
      ["1", "", ""],
    ]);
  });
});
