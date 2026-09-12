import { describe, expect, it } from "vitest";

import {
  allows,
  describeOverrides,
  effectivePermissions,
  PERMISSIONS,
  ROLES,
  can,
  isRole,
  permissionsOf,
  verdictPermission,
  type Permission,
  type Role,
} from "./roles";

/** The whole matrix, written out again. Deliberate duplication: a change to
 *  who may do what has to be made twice, and the second time is here, in a
 *  file an auditor can read without reading the implementation. */
const EXPECTED: Record<Role, Permission[]> = {
  ADMIN: [
    "planning.manage",
    "inspection.record",
    "verdict.bypass",
    "rework.record",
    "config.manage",
    "user.manage",
  ],
  QUALITY_MANAGER: [
    "planning.manage",
    "inspection.record",
    "verdict.bypass",
    "rework.record",
    "config.manage",
  ],
  SUPERVISOR: ["planning.manage", "inspection.record", "verdict.bypass", "rework.record"],
  INSPECTOR: ["inspection.record", "rework.record"],
  VIEWER: [],
};

describe("the permission matrix", () => {
  it("is exactly this", () => {
    for (const role of ROLES) expect([...permissionsOf(role)].sort()).toEqual([...EXPECTED[role]].sort());
  });

  it("gives a viewer nothing at all", () => {
    for (const p of PERMISSIONS) expect(can("VIEWER", p)).toBe(false);
  });

  it("keeps account management to the administrator", () => {
    for (const role of ROLES)
      expect(can(role, "user.manage")).toBe(role === "ADMIN");
  });

  it("keeps the drawings out of an inspector's hands", () => {
    // An inspector who can widen a tolerance can pass anything.
    expect(can("INSPECTOR", "config.manage")).toBe(false);
    expect(can("SUPERVISOR", "config.manage")).toBe(false);
    expect(can("QUALITY_MANAGER", "config.manage")).toBe(true);
  });

  it("puts a concession above the inspector who measured", () => {
    expect(can("INSPECTOR", "verdict.bypass")).toBe(false);
    // Somebody on the shift has to be able to, or the line waits for a manager.
    expect(can("SUPERVISOR", "verdict.bypass")).toBe(true);
  });
});

describe("what a verdict costs to record", () => {
  it("is reporting when it agrees with the evidence", () => {
    expect(verdictPermission("ACCEPTED", "ACCEPTED")).toBe("inspection.record");
    expect(verdictPermission("HOLD", "HOLD")).toBe("inspection.record");
  });

  it("is reporting to hold a piece the evidence would have passed", () => {
    // Nobody needs authority to stop a piece. An inspector who saw something
    // the sheet has no line for must be able to act on it.
    expect(verdictPermission("HOLD", "ACCEPTED")).toBe("inspection.record");
  });

  it("is a concession to pass what the evidence holds", () => {
    expect(verdictPermission("ACCEPTED", "HOLD")).toBe("verdict.bypass");
  });

  it("is a concession whenever it is called one, agreement or not", () => {
    // A bypass recorded on a piece that would have passed anyway is still a
    // bypass on the record, and still needs the authority behind it.
    expect(verdictPermission("ACCEPTED_BYPASS", "ACCEPTED")).toBe("verdict.bypass");
    expect(verdictPermission("ACCEPTED_BYPASS", "HOLD")).toBe("verdict.bypass");
  });
});

describe("reading a role back out of the database", () => {
  it("accepts the five and nothing else", () => {
    for (const r of ROLES) expect(isRole(r)).toBe(true);
    for (const junk of ["admin", "MANAGER", "", null, 7, {}]) expect(isRole(junk)).toBe(false);
  });
});

describe("what one account may actually do", () => {
  const inspector = { role: "INSPECTOR" as const };

  it("follows the role when nothing has been said about the person", () => {
    expect(allows(inspector, "inspection.record")).toBe(true);
    expect(allows(inspector, "config.manage")).toBe(false);
    expect(effectivePermissions(inspector)).toEqual([...permissionsOf("INSPECTOR")]);
  });

  it("adds what a person has been granted on top of their role", () => {
    // The inspector who is also the only one keeping the drawings up to date.
    const account = { ...inspector, granted: ["config.manage"] as const };
    expect(allows(account, "config.manage")).toBe(true);
    expect(allows(account, "user.manage")).toBe(false);
  });

  it("takes away what a person has been denied, whatever their role says", () => {
    // The supervisor who must not grant concessions until they are signed off.
    const account = { role: "SUPERVISOR" as const, denied: ["verdict.bypass"] as const };
    expect(allows(account, "verdict.bypass")).toBe(false);
    expect(allows(account, "inspection.record")).toBe(true);
  });

  it("lets a denial win over a grant, so removing access is never ambiguous", () => {
    const account = {
      ...inspector,
      granted: ["config.manage"] as const,
      denied: ["config.manage"] as const,
    };
    expect(allows(account, "config.manage")).toBe(false);
  });

  it("says how an account differs from its role, and says nothing when it does not", () => {
    expect(describeOverrides(inspector)).toEqual([]);
    // A grant of something the role already had is not a difference.
    expect(describeOverrides({ ...inspector, granted: ["inspection.record"] })).toEqual([]);
    expect(describeOverrides({ ...inspector, granted: ["config.manage"] })).toEqual([
      "also define dimensions, defects and departments",
    ]);
    expect(
      describeOverrides({ role: "SUPERVISOR", denied: ["verdict.bypass"] })
    ).toEqual(["not accept on a concession"]);
  });
});
