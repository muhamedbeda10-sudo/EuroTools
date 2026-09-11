/** Roles, permissions, and who may do what.
 *
 *  This file is to authorisation what `stages.ts` is to the checklists: the
 *  single source of truth. It is pure — no I/O, no Prisma, no session — so the
 *  same matrix runs on the server to *decide* and in the browser to hide
 *  controls the user could not use anyway. If those two ever disagree, the
 *  operator gets a button that fails on click.
 *
 *  The database stores the role key, never the label, so re-wording a label
 *  never invalidates an existing account.
 *
 *  ## Where the authority line actually falls
 *
 *  A checklist verdict is *derived*, not typed: `rollup()` reads the answers
 *  and the measurements and returns the verdict they imply. Recording a
 *  finished sheet is therefore reporting a fact, and every inspector may do
 *  it. What takes authority is departing from that verdict, and releasing
 *  product. So the line is drawn at `inspection.override` and `part.release`,
 *  not at `inspection.submit`.
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
  /** Register an incoming lot against a material and supplier. */
  "lot.receive",
  /** Record a certificate and mark it received or verified. */
  "lot.certificate.manage",
  /** Open an analysis and enter its measured results. */
  "analysis.record",
  /** Record a stage checklist carrying the verdict the system derived. */
  "inspection.submit",
  /** Record a verdict that differs from the derived one. */
  "inspection.override",
  /** Issue parts from an accepted lot. */
  "part.raise",
  /** Send a reworked part back into its queue. */
  "part.requeue",
  /** Sign the final release. The last gate before product leaves quality. */
  "part.release",
  /** Edit a material spec: tolerances, hardness window, required finish. */
  "material.manage",
  /** Create and edit supplier records. */
  "supplier.manage",
  /** Create accounts, assign roles, deactivate users. */
  "user.manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Every role is spelled out in full rather than inherited from the one below
 *  it. It is more to read, but an auditor can be handed this table as-is, and
 *  widening a role shows up in the diff as the line it actually is. The test
 *  beside this file pins the whole matrix for the same reason.
 *
 *  ADMIN deliberately holds quality authority here as well as account
 *  administration. That is what was asked for; a plant wanting strict
 *  separation of duties would drop everything above `user.manage` from this
 *  row and give the plant manager a QUALITY_MANAGER account instead. */
const MATRIX: Record<Role, readonly Permission[]> = {
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
  INSPECTOR: [
    "lot.receive",
    "lot.certificate.manage",
    "analysis.record",
    "inspection.submit",
  ],
  /** Reads everything, writes nothing. For plant management, internal audit,
   *  and customer representatives. */
  VIEWER: [],
};

export const ROLE_LABELS: Record<Role, { ar: string; en: string }> = {
  ADMIN: { ar: "مدير النظام", en: "System Administrator" },
  QUALITY_MANAGER: { ar: "مدير الجودة", en: "Quality Manager" },
  SUPERVISOR: { ar: "مشرف الجودة", en: "Quality Supervisor" },
  INSPECTOR: { ar: "فاحص", en: "Inspector" },
  VIEWER: { ar: "مُطّلِع", en: "Viewer" },
};

/** Does this role carry this permission? The only question the server asks. */
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

/** The permission a stage verdict needs.
 *
 *  `RELEASED` is the final quality release and is gated on its own, whether or
 *  not the system suggested it — a derived release is still a release.
 *  Otherwise, agreeing with the system is reporting and differing from it is a
 *  judgement call. */
export function verdictPermission(chosen: string, suggested: string): Permission {
  if (chosen === "RELEASED") return "part.release";
  return chosen === suggested ? "inspection.submit" : "inspection.override";
}
