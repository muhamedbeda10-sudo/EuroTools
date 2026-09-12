/** Roles, permissions, and who may do what.
 *
 *  Pure — no I/O, no session — so the same matrix runs in the browser to hide
 *  controls somebody could not use and in `firestore.rules` to refuse them.
 *  Those two are written separately and must be kept in step; the rules file
 *  says so where it duplicates this, because widening a role has to be a
 *  deliberate act in two places.
 *
 *  The database stores the role key, never the label, so re-wording a label
 *  never invalidates an account.
 *
 *  ## Where the authority line falls
 *
 *  A verdict is *derived*: the readings and the defects imply it. Recording a
 *  sheet that agrees with the evidence is reporting a fact, and any inspector
 *  may do it. Two things take authority, and they are the two an audit asks
 *  about: letting a piece through on a concession, and changing what the
 *  drawings say a piece has to be. So the line is at `verdict.bypass` and
 *  `config.manage`, not at `inspection.record`.
 */

export const ROLES = [
  "ADMIN",
  "QUALITY_MANAGER",
  "SUPERVISOR",
  "INSPECTOR",
  "VIEWER",
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  /** Bring in planning's sheet, and edit or cancel a line from it. */
  "planning.manage",
  /** Measure a piece and record the verdict the evidence requires. */
  "inspection.record",
  /** Let a piece through that the evidence says should be held — a
   *  concession. The one verdict nothing can arrive at on its own. */
  "verdict.bypass",
  /** Record that a department has finished the rework it was held for. */
  "rework.record",
  /** Define what a piece has to be: its dimensions, its tolerances, the
   *  defects to look for, and the departments a hold can name. */
  "config.manage",
  /** Create accounts, assign roles, deactivate users. */
  "user.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Every role is spelled out in full rather than inherited from the one below
 *  it. It is more to read, but an auditor can be handed this table as it
 *  stands, and widening a role shows up in the diff as the line it is. The
 *  test beside this file pins the whole matrix for the same reason. */
const MATRIX: Record<Role, readonly Permission[]> = {
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
  /** Runs the shift. May grant a concession — somebody on the floor has to be
   *  able to, or the line stops waiting for a manager — but may not change
   *  what the drawings require. */
  SUPERVISOR: ["planning.manage", "inspection.record", "verdict.bypass", "rework.record"],
  /** Measures, records what the evidence says, and closes out a rework when
   *  the department reports back. Cannot let through what the evidence holds. */
  INSPECTOR: ["inspection.record", "rework.record"],
  /** Reads everything, writes nothing. For plant management, internal audit,
   *  and customer representatives. */
  VIEWER: [],
};

export const ROLE_LABELS: Record<Role, { en: string }> = {
  ADMIN: { en: "System Administrator" },
  QUALITY_MANAGER: { en: "Quality Manager" },
  SUPERVISOR: { en: "Quality Supervisor" },
  INSPECTOR: { en: "Inspector" },
  VIEWER: { en: "Viewer" },
};

export const PERMISSION_LABELS: Record<Permission, string> = {
  "planning.manage": "Import and edit planning lines",
  "inspection.record": "Measure a piece and record the verdict",
  "verdict.bypass": "Accept on a concession",
  "rework.record": "Close out a rework",
  "config.manage": "Define dimensions, defects and departments",
  "user.manage": "Manage accounts",
};

/** Does this role carry this permission? The only question anything asks. */
export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].includes(permission);
}

/** Narrow a value read from the database or a form to a known role. */
export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

/** Every permission a role holds, for the admin screen and for tests. */
export function permissionsOf(role: Role): readonly Permission[] {
  return MATRIX[role];
}

/** The permission a chosen verdict needs.
 *
 *  Agreeing with the evidence is reporting; a hold is always reporting, since
 *  nobody needs authority to stop a piece. Letting through what the evidence
 *  holds is the concession, and it is the only one gated.
 */
export function verdictPermission(chosen: string, suggested: string): Permission {
  return chosen === "ACCEPTED_BYPASS" || (chosen !== "HOLD" && suggested === "HOLD")
    ? "verdict.bypass"
    : "inspection.record";
}
