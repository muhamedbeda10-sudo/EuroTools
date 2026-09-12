import { describe, expect, it } from "vitest";
import {
  fmtDate,
  fmtDateTime,
  fmtDuration,
  fmtNum,
  fmtTolerance,
  optionalNumber,
  optionalString,
  pct,
  safeNextPath,
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

describe("safeNextPath", () => {
  it("keeps a path inside the application, query string and all", () => {
    expect(safeNextPath("/parts/42")).toBe("/parts/42");
    expect(safeNextPath("/reports?stage=FINAL")).toBe("/reports?stage=FINAL");
  });

  it("refuses anything that could leave the origin", () => {
    for (const hostile of [
      "//evil.test",
      "/\\evil.test",
      "https://evil.test",
      "http://evil.test",
      "javascript:alert(1)",
      "evil.test",
      "../admin",
    ])
      expect(safeNextPath(hostile)).toBe("/");
  });

  it("refuses control characters used to smuggle a second line", () => {
    // Built from char codes so this file stays free of the very characters it
    // is testing for.
    const ch = (code: number) => String.fromCharCode(code);
    expect(safeNextPath("/parts" + ch(10) + "/../..")).toBe("/");
    expect(safeNextPath("/parts" + ch(13) + ch(10) + "Location: https://evil.test")).toBe("/");
    expect(safeNextPath("/parts" + ch(0))).toBe("/");
    expect(safeNextPath("/parts" + ch(127))).toBe("/");
  });

  it("refuses the login page itself so a redirect cannot loop", () => {
    expect(safeNextPath("/login")).toBe("/");
    expect(safeNextPath("/login?next=/login")).toBe("/");
  });

  it("falls back for a missing, empty or non-string value", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
    expect(safeNextPath("   ")).toBe("/");
  });

  it("uses the fallback it was given", () => {
    expect(safeNextPath("//evil.test", "/queue")).toBe("/queue");
  });
});

describe("a span of time, as the shop floor would say it", () => {
  const m = 60_000;
  const h = 60 * m;
  const d = 24 * h;

  it("gives two units at most", () => {
    // "3d 4h 12m 6s" is a number nobody reads.
    expect(fmtDuration(3 * d + 4 * h + 12 * m)).toBe("3d 4h");
    expect(fmtDuration(4 * h + 12 * m)).toBe("4h 12m");
    expect(fmtDuration(12 * m)).toBe("12m");
  });

  it("drops the second unit when it is zero", () => {
    expect(fmtDuration(3 * d)).toBe("3d");
    expect(fmtDuration(4 * h)).toBe("4h");
  });

  it("says nothing has really happened yet under a minute", () => {
    expect(fmtDuration(40_000)).toBe("under a minute");
    expect(fmtDuration(0)).toBe("under a minute");
  });

  it("shows a dash rather than a negative for a clock that disagrees", () => {
    expect(fmtDuration(-1)).toBe("—");
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(Number.NaN)).toBe("—");
  });
});
