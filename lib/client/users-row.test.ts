/** The founding administrator's document, which nothing in the application
 *  wrote.
 *
 *  Every other account is created by `grantAccess`, which fills in timestamps,
 *  a creator and a signature count. The first one is typed into the Firestore
 *  console by hand, because at that moment there is nobody to create it and no
 *  screen to create it from. It therefore carries only the fields the README
 *  asks for, and the staff list has to open on it — that screen is the only
 *  way anybody else ever gets an account, so if it fails on the founding
 *  document the plant is locked out of its own quality system.
 *
 *  This went wrong in production exactly once, which is why it is pinned here.
 */

import { describe, expect, it } from "vitest";

import { byActiveThenName, toUserRow } from "./queries";
import type { UserDoc } from "@/lib/model";

/** Precisely the fields the README's «أول حساب» table asks for — no more. */
const BOOTSTRAP = {
  email: "muhamedbeda10@gmail.com",
  displayName: "Beda",
  role: "ADMIN",
  active: true,
  signedInspections: 0,
} as unknown as UserDoc;

const stamp = (d: Date) => ({ toDate: () => d, toMillis: () => d.getTime() });

describe("the staff list, on the document nobody wrote", () => {
  it("opens on an account with no timestamps at all", () => {
    const row = toUserRow("pmmXJGs8KjVS1wJuR4fzEzNip6D3", BOOTSTRAP);

    expect(row.createdAt).toBeNull();
    expect(row.updatedAt).toBeNull();
    expect(row.displayName).toBe("Beda");
    expect(row.role).toBe("ADMIN");
    expect(row.active).toBe(true);
  });

  it("reports no creator, rather than inventing one", () => {
    // Nobody created the first account; that is what makes it the first.
    expect(toUserRow("uid", BOOTSTRAP).createdBy).toBeNull();
  });

  it("counts nothing signed when the field is missing entirely", () => {
    const withoutCount = { ...BOOTSTRAP, signedInspections: undefined } as unknown as UserDoc;
    expect(toUserRow("uid", withoutCount)._count.inspections).toBe(0);
  });

  it("keeps the timestamps an application-created account does have", () => {
    const created = new Date("2026-09-12T10:00:00Z");
    const full = {
      ...BOOTSTRAP,
      createdAt: stamp(created),
      updatedAt: stamp(created),
      createdByName: "Beda",
      signedInspections: 4,
    } as unknown as UserDoc;

    const row = toUserRow("uid", full);
    expect(row.createdAt).toEqual(created);
    expect(row.createdBy).toEqual({ displayName: "Beda" });
    expect(row._count.inspections).toBe(4);
  });
});

describe("the order the staff list is read in", () => {
  it("puts working accounts above retired ones, then sorts by name", () => {
    const rows = [
      { active: false, displayName: "Adel" },
      { active: true, displayName: "Zaki" },
      { active: true, displayName: "Beda" },
      { active: false, displayName: "Yara" },
    ];

    expect([...rows].sort(byActiveThenName).map((r) => r.displayName)).toEqual([
      "Beda",
      "Zaki",
      "Adel",
      "Yara",
    ]);
  });
});
