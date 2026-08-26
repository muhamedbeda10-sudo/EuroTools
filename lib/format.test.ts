import { describe, expect, it } from "vitest";
import {
  fmtDate,
  fmtDateTime,
  fmtNum,
  fmtTolerance,
  optionalNumber,
  optionalString,
  pct,
  todayInputValue,
  triState,
} from "./format";

// The app pins Africa/Cairo (UTC+2, no DST since 2023 was reinstated as
// Apr–Oct DST; these cases sit either side of it deliberately).
describe("date formatting", () => {
  it("renders a fixed dd/mm/yyyy with no locale separators", () => {
    expect(fmtDate(new Date("2026-08-06T06:35:00Z"))).toBe("06/08/2026");
  });

  it("renders a 24-hour clock so ص/م never appears", () => {
    // 06:35 UTC is 08:35 in Cairo summer time.
    expect(fmtDateTime(new Date("2026-08-06T06:35:00Z"))).toMatch(
      /^06\/08\/2026 \d{2}:35$/
    );
  });

  it("uses h23 — midnight is 00, never 24", () => {
    const s = fmtDateTime(new Date("2026-01-15T22:00:00Z")); // 00:00 Cairo, next day
    expect(s.split(" ")[1]).toBe("00:00");
    expect(s.startsWith("16/01/2026")).toBe(true);
  });

  it("shifts the date into the app timezone, not UTC", () => {
    // 23:30 UTC on the 5th is already 01:30 on the 6th in Cairo.
    expect(fmtDate(new Date("2026-08-05T23:30:00Z"))).toBe("06/08/2026");
  });

  it("accepts an ISO string as well as a Date", () => {
    expect(fmtDate("2026-08-06T06:35:00Z")).toBe("06/08/2026");
  });

  it("renders a dash for missing or unparseable input", () => {
    expect(fmtDate(null)).toBe("—");
    expect(fmtDate(undefined)).toBe("—");
    expect(fmtDateTime("not a date")).toBe("—");
  });

  it("gives a date-input value in the app timezone", () => {
    expect(todayInputValue(new Date("2026-08-05T23:30:00Z"))).toBe("2026-08-06");
  });
});

describe("fmtNum", () => {
  it("trims trailing zeros but keeps significant digits", () => {
    expect(fmtNum(50.05)).toBe("50.05");
    expect(fmtNum(50)).toBe("50");
    expect(fmtNum(0.0201)).toBe("0.0201");
  });

  it("renders a dash for nothing", () => {
    expect(fmtNum(null)).toBe("—");
    expect(fmtNum(undefined)).toBe("—");
    expect(fmtNum(NaN)).toBe("—");
  });

  it("keeps zero as a number, not a dash", () => {
    expect(fmtNum(0)).toBe("0");
  });
});

describe("fmtTolerance", () => {
  it("writes a symmetric band with ±", () => {
    expect(fmtTolerance(50, 0.05, 0.05)).toBe("50 ±0.05");
  });

  it("writes an asymmetric band with both signs", () => {
    expect(fmtTolerance(20, 0, 0.1)).toBe("20 +0.1/-0");
  });

  it("drops the band entirely when there is none", () => {
    expect(fmtTolerance(20, 0, 0)).toBe("20");
  });

  it("normalises a negatively-written tolerance", () => {
    expect(fmtTolerance(50, -0.05, 0.05)).toBe("50 ±0.05");
  });

  it("renders a dash without a nominal", () => {
    expect(fmtTolerance(null, 0.05, 0.05)).toBe("—");
  });
});

describe("pct", () => {
  it("rounds to whole percent by default", () => {
    expect(pct(0.75)).toBe("75%");
    expect(pct(0.9333, 1)).toBe("93.3%");
  });
});

describe("form parsers", () => {
  it("treats a blank field as absent, not zero", () => {
    expect(optionalNumber("")).toBeNull();
    expect(optionalNumber("  ")).toBeNull();
    expect(optionalNumber(null)).toBeNull();
    expect(optionalNumber("0")).toBe(0);
    expect(optionalNumber("50.05")).toBe(50.05);
  });

  it("rejects a non-numeric field rather than yielding NaN", () => {
    expect(optionalNumber("abc")).toBeNull();
  });

  it("trims strings and nulls out the empty ones", () => {
    expect(optionalString("  PN-1  ")).toBe("PN-1");
    expect(optionalString("   ")).toBeNull();
    expect(optionalString(null)).toBeNull();
  });

  it("reads the tri-state checklist answer", () => {
    expect(triState("yes")).toBe(true);
    expect(triState("no")).toBe(false);
    expect(triState("")).toBeNull();
    expect(triState(null)).toBeNull();
    expect(triState("maybe")).toBeNull();
  });
});
