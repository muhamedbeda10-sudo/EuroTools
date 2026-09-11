import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { can, isRole, type Permission, type Role } from "@/lib/domain/roles";
import { prisma } from "@/lib/db";
import { adminAuth } from "@/lib/server/firebase-admin";
import { SESSION_COOKIE } from "@/lib/session-cookie";

export { SESSION_COOKIE };

/** One shift. Long enough that an inspector is not signing in again in the
 *  middle of a job, short enough that a tablet left on the shop floor has
 *  stopped being a way in by the next morning. */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export interface SessionUser {
  id: number;
  firebaseUid: string;
  email: string;
  displayName: string;
  role: Role;
  employeeNo: string | null;
}

/** Denial shaped so an action can hand it straight back to the caller: it is
 *  structurally an `ActionResult`. */
export interface Denied {
  ok: false;
  error: string;
}

export type Authorised = { ok: true; user: SessionUser } | Denied;

/** Who is calling, or null.
 *
 *  Firebase proves the cookie is genuine and unexpired. Everything after that
 *  is decided by the User row: the role, and whether the account is still
 *  active. Reading authority from our own database on every request is what
 *  makes deactivating an account take effect on the very next click, instead
 *  of whenever a token happens to lapse.
 *
 *  `checkRevoked` is deliberately off. It would cost a network round trip to
 *  Google on every request to answer a question the `active` flag already
 *  answers faster and more strictly.
 *
 *  Memoised for the render pass, so a layout, a page and an action that all
 *  ask still cost one query between them.
 */
export const currentUser = cache(async (): Promise<SessionUser | null> => {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) return null;

  let uid: string;
  try {
    uid = (await adminAuth().verifySessionCookie(session, false)).uid;
  } catch {
    // Expired, tampered with, or signed for another project. Not an error
    // worth surfacing: the caller is simply not signed in.
    return null;
  }

  const user = await prisma.user.findUnique({ where: { firebaseUid: uid } });
  if (!user || !user.active) return null;

  // A role the domain layer does not recognise grants nothing. This can only
  // happen if a role were removed from `roles.ts` while accounts still carry
  // it, and failing closed is the only safe reading.
  if (!isRole(user.role)) return null;

  return {
    id: user.id,
    firebaseUid: user.firebaseUid,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    employeeNo: user.employeeNo,
  };
});

/** The caller, or the login page. For Server Components and pages, where a
 *  redirect is the right answer to "not signed in". */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/** The caller if they hold the permission, or a denial to return as-is.
 *
 *  For Server Actions, which report failure through `ActionResult` rather than
 *  by throwing, so the reason lands in the form the operator is looking at:
 *
 *      const auth = await requirePermission("material.manage");
 *      if (!auth.ok) return auth;
 *
 *  This is the real authorisation boundary. `proxy.ts` only keeps signed-out
 *  traffic off the pages; every write is decided here, next to the data.
 */
export async function requirePermission(permission: Permission): Promise<Authorised> {
  const user = await currentUser();
  if (!user) return { ok: false, error: "انتهت الجلسة. برجاء تسجيل الدخول من جديد." };
  if (!can(user.role, permission))
    return { ok: false, error: "ليس لديك صلاحية لتنفيذ هذا الإجراء." };
  return { ok: true, user };
}

/** A page that only one kind of account may open, such as user administration.
 *  Signed-out callers go to the login page; signed-in callers without the
 *  permission are sent home rather than shown a door they cannot use. */
export async function requirePermissionPage(permission: Permission): Promise<SessionUser> {
  const user = await requireUser();
  if (!can(user.role, permission)) redirect("/");
  return user;
}
