"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, SESSION_MAX_AGE_MS } from "@/lib/server/auth";
import { adminAuth } from "@/lib/server/firebase-admin";
import { users, type UserDoc } from "@/lib/server/model";

/** How stale an ID token may be before we refuse to mint a long session from
 *  it. Without this, a token captured hours ago could still be traded for a
 *  fresh twelve-hour session. */
const MAX_SIGN_IN_AGE_MS = 5 * 60 * 1000;

export interface SessionResult {
  ok: boolean;
  error?: string;
}

/** Trade a freshly minted Firebase ID token for an httpOnly session cookie.
 *
 *  Signing in to Firebase is not the same as being allowed in here. An account
 *  that Firebase knows but this plant has not provisioned — or has since
 *  deactivated — gets no cookie and no session. Firebase answers "who is
 *  this"; the User table answers "may they work".
 */
export async function createSession(idToken: string): Promise<SessionResult> {
  if (typeof idToken !== "string" || idToken.length === 0)
    return { ok: false, error: "تعذّر إتمام تسجيل الدخول." };

  const auth = adminAuth();

  let uid: string;
  let authTimeMs: number;
  try {
    const decoded = await auth.verifyIdToken(idToken, true);
    uid = decoded.uid;
    authTimeMs = decoded.auth_time * 1000;
  } catch {
    return { ok: false, error: "بيانات الدخول غير صحيحة أو انتهت صلاحيتها." };
  }

  if (Date.now() - authTimeMs > MAX_SIGN_IN_AGE_MS)
    return { ok: false, error: "انتهت مهلة تسجيل الدخول. برجاء المحاولة مرة أخرى." };

  const snapshot = await users().doc(uid).get();
  if (!snapshot.exists)
    return { ok: false, error: "هذا الحساب غير مُسجَّل في النظام. راجع مدير النظام." };
  if (!(snapshot.data() as UserDoc).active)
    return { ok: false, error: "هذا الحساب موقوف. راجع مدير النظام." };

  const sessionCookie = await auth.createSessionCookie(idToken, {
    expiresIn: SESSION_MAX_AGE_MS,
  });

  (await cookies()).set(SESSION_COOKIE, sessionCookie, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_MS / 1000,
  });

  return { ok: true };
}

/** End the session everywhere, not just in this browser.
 *
 *  Revoking the refresh tokens matters on a shared shop-floor tablet: it means
 *  signing out actually invalidates the credential rather than only forgetting
 *  it locally.
 */
export async function endSession(): Promise<void> {
  const jar = await cookies();
  const session = jar.get(SESSION_COOKIE)?.value;

  if (session) {
    try {
      const decoded = await adminAuth().verifySessionCookie(session, false);
      await adminAuth().revokeRefreshTokens(decoded.uid);
    } catch {
      // Already expired or unreadable. The cookie still goes.
    }
  }

  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
