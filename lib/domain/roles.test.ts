import { describe, expect, it } from "vitest";
import {
  PERMISSIONS,
  ROLES,
  ROLE_LABELS,
  can,
  isRole,
  permissionsOf,
  verdictPermission,
  type Permission,
  type Role,
} from "./roles";

// ───────────────────────── the matrix itself ─────────────────────────

/** The whole table, pinned. Widening a role has to be written here as well as
 *  in the source, so nobody gains an authority by accident. */
const EXPECTED: Record<Role, readonly Permission[]> = {
  ADMIN: [
    "lot.receive",
    "lot.certificate.manage",
    "analysis.record",
    "inspection.submit",
    "inspection.override",
    "part.raise",
    "part.requeue",
    "part.release",
    "material.manage",
    "supplier.manage",
    "user.manage",
  ],
  QUALITY_MANAGER: [
    "lot.receive",
    "lot.certificate.manage",
    "analysis.record",
    "inspection.submit",
    "inspection.override",
    "part.raise",
    "part.requeue",
    "part.release",
    "material.manage",
    "supplier.manage",
  ],
  SUPERVISOR: [
    "lot.receive",
    "lot.certificate.manage",
    "analysis.record",
    "inspection.submit",
    "inspection.override",
    "part.raise",
    "part.requeue",
    "supplier.manage",
  ],
  INSPECTOR: ["lot.receive", "lot.certificate.manage", "analysis.record", "inspection.submit"],
  VIEWER: [],
};

describe("the permission matrix", () => {
  for (const role of ROLES) {
    it(`grants ${role} exactly its documented permissions`, () => {
      expect([...permissionsOf(role)].sort()).toEqual([...EXPECTED[role]].sort());
    });
  }

  it("answers every role against every permission without throwing", () => {
    for (const role of ROLES)
      for (const permission of PERMISSIONS) expect(typeof can(role, permission)).toBe("boolean");
  });

  it("grants no permission that is not declared", () => {
    for (const role of ROLES)
      for (const permission of permissionsOf(role))
        expect(PERMISSIONS).toContain(permission);
  });
});

// ─────────────────── the rules that matter most ───────────────────

describe("separation of authority", () => {
  it("lets only the quality manager and the administrator release product", () => {
    expect(can("QUALITY_MANAGER", "part.release")).toBe(true);
    expect(can("ADMIN", "part.release")).toBe(true);
    expect(can("SUPERVISOR", "part.release")).toBe(false);
    expect(can("INSPECTOR", "part.release")).toBe(false);
    expect(can("VIEWER", "part.release")).toBe(false);
  });

  it("stops an inspector departing from the verdict the system derived", () => {
    expect(can("INSPECTOR", "inspection.submit")).toBe(true);
    expect(can("INSPECTOR", "inspection.override")).toBe(false);
    expect(can("SUPERVISOR", "inspection.override")).toBe(true);
  });

  it("keeps the drawing spec out of the hands of the shop floor", () => {
    expect(can("INSPECTOR", "material.manage")).toBe(false);
    expect(can("SUPERVISOR", "material.manage")).toBe(false);
    expect(can("QUALITY_MANAGER", "material.manage")).toBe(true);
  });

  it("gives account administration to the administrator alone", () => {
    for (const role of ROLES)
      expect(can(role, "user.manage")).toBe(role === "ADMIN");
  });

  it("gives a viewer nothing at all", () => {
    for (const permission of PERMISSIONS) expect(can("VIEWER", permission)).toBe(false);
  });
});

// ───────────────────── verdict gating ─────────────────────

describe("verdictPermission", () => {
  it("treats agreeing with the system as an ordinary submission", () => {
    expect(verdictPermission("ACCEPTED", "ACCEPTED")).toBe("inspection.submit");
    // Recording a derived rejection is reporting a fact, not exercising
    // judgement, so it needs no more authority than an acceptance does.
    expect(verdictPermission("REJECTED", "REJECTED")).toBe("inspection.submit");
    expect(verdictPermission("REWORK", "REWORK")).toBe("inspection.submit");
  });

  it("treats departing from the system as an override", () => {
    expect(verdictPermission("ACCEPTED", "REJECTED")).toBe("inspection.override");
    expect(verdictPermission("REWORK", "REJECTED")).toBe("inspection.override");
    expect(verdictPermission("PENDING", "ACCEPTED")).toBe("inspection.override");
  });

  it("gates a release on its own even when the system derived it", () => {
    expect(verdictPermission("RELEASED", "RELEASED")).toBe("part.release");
    expect(verdictPermission("RELEASED", "REWORK")).toBe("part.release");
  });
});

// ───────────────────────── narrowing ─────────────────────────

describe("isRole", () => {
  it("accepts every declared role", () => {
    for (const role of ROLES) expect(isRole(role)).toBe(true);
  });

  it("rejects anything else, including near misses and junk types", () => {
    for (const value of ["admin", "Admin", "MANAGER", "", null, undefined, 0, {}, []])
      expect(isRole(value)).toBe(false);
  });
});

describe("ROLE_LABELS", () => {
  it("labels every role in both languages", () => {
    for (const role of ROLES) {
      expect(ROLE_LABELS[role].ar.trim()).not.toBe("");
      expect(ROLE_LABELS[role].en.trim()).not.toBe("");
    }
  });
});
