"use server";

import { revalidatePath } from "next/cache";
import { Timestamp } from "firebase-admin/firestore";

import { ROLES, isRole } from "@/lib/domain/roles";
import { requirePermission } from "@/lib/server/auth";
import { adminAuth } from "@/lib/server/firebase-admin";
import { db } from "@/lib/server/firestore";
import {
  reserveUnique,
  userAuditEvents,
  users,
  type UserAuditEventDoc,
  type UserDoc,
} from "@/lib/server/model";
import { optionalString } from "@/lib/format";

import type { ActionResult } from "@/lib/server/actions";

/** Firebase accepts six characters; a system that signs off on product should
 *  ask for more. */
const MIN_PASSWORD_LENGTH = 8;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Two rules hold this screen together, and both exist to stop an
 *  administrator locking the plant out of its own quality system:
 *
 *  1. Nobody changes their own role or deactivates their own account. Another
 *     administrator has to, which is ordinary separation of duties and also
 *     removes the single most likely way to strand the system.
 *  2. The last active administrator cannot be demoted or deactivated. Rule 1
 *     already implies this today, but stating it separately means the
 *     invariant survives a future change to rule 1.
 *
 *  A user document is keyed by its Firebase uid, so the `id` these actions
 *  take from the form is that uid.
 */
function selfEditRefusal(actorUid: string, subjectUid: string): string | null {
  if (actorUid === subjectUid)
    return "لا يمكنك تعديل صلاحيتك أو إيقاف حسابك بنفسك. يجب أن يقوم بذلك مدير نظام آخر.";
  return null;
}

/** Would this change leave nobody able to administer the system?
 *
 *  A count aggregation rather than a read of the staff list: it answers the
 *  question exactly and costs one read whatever the plant's headcount.
 */
async function lastAdminRefusal(subject: UserDoc): Promise<string | null> {
  if (subject.role !== "ADMIN" || !subject.active) return null;

  const others = await users()
    .where("role", "==", "ADMIN")
    .where("active", "==", true)
    .count()
    .get();

  // The subject is still counted here, so "only them" reads as one.
  if (others.data().count <= 1) return "هذا هو مدير النظام النشط الوحيد. عيّن مدير نظام آخر أولًا.";
  return null;
}

function auditEvent(
  kind: string,
  subject: { uid: string; name: string },
  actor: { uid: string; name: string },
  values: { from?: string | null; to?: string | null } = {}
): UserAuditEventDoc {
  return {
    at: Timestamp.now(),
    kind,
    subjectUid: subject.uid,
    subjectName: subject.name,
    actorUid: actor.uid,
    actorName: actor.name,
    fromValue: values.from ?? null,
    toValue: values.to ?? null,
  };
}

// ───────────────────────── create ─────────────────────────

/** Open an account in Firebase Authentication and in Firestore.
 *
 *  The two writes are not one transaction — they are different systems — so a
 *  Firestore failure deletes the Firebase account it just made rather than
 *  leaving one that can authenticate but has no role, which is exactly the
 *  state `createSession` would refuse anyway.
 */
export async function createUser(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("user.manage");
  if (!auth.ok) return auth;

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const displayName = String(formData.get("displayName") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "").trim();
  const employeeNo = optionalString(formData.get("employeeNo"));

  if (!EMAIL_PATTERN.test(email)) return { ok: false, error: "البريد الإلكتروني غير صالح." };
  if (displayName === "")
    return { ok: false, error: "الاسم مطلوب — هو الاسم الذي يُوقَّع به على الفحوص." };
  if (password.length < MIN_PASSWORD_LENGTH)
    return { ok: false, error: `كلمة المرور يجب ألا تقل عن ${MIN_PASSWORD_LENGTH} أحرف.` };
  if (!isRole(role)) return { ok: false, error: "الصلاحية غير معروفة." };

  let uid: string;
  try {
    const created = await adminAuth().createUser({
      email,
      password,
      displayName,
      emailVerified: true,
    });
    uid = created.uid;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "auth/email-already-exists")
      return { ok: false, error: "هذا البريد مسجَّل بالفعل." };
    if (code === "auth/invalid-password")
      return { ok: false, error: "كلمة المرور مرفوضة من Firebase." };
    return { ok: false, error: "تعذّر إنشاء الحساب في Firebase." };
  }

  try {
    await db().runTransaction(async (tx) => {
      const ref = users().doc(uid);
      // Firebase already refuses a duplicate address, so this reservation is
      // the second lock: it also covers an account created outside this screen
      // and keeps the guarantee in one place with the others.
      const claim = await reserveUnique(tx, "user.email", email, ref.path);
      if (!claim.ok) throw new Error("CLASH");

      tx.create(ref, {
        email,
        displayName,
        role,
        employeeNo,
        active: true,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        createdByUid: auth.user.uid,
        createdByName: auth.user.displayName,
        signedInspections: 0,
      } satisfies UserDoc);

      tx.create(
        userAuditEvents().doc(),
        auditEvent(
          "CREATED",
          { uid, name: displayName },
          { uid: auth.user.uid, name: auth.user.displayName },
          { to: role }
        )
      );
    });
  } catch (error) {
    // Roll the Firebase side back so a retry is not blocked by a half-made
    // account nobody can see in this screen.
    await adminAuth().deleteUser(uid).catch(() => undefined);
    if ((error as Error).message === "CLASH")
      return { ok: false, error: "هذا البريد مسجَّل بالفعل." };
    return { ok: false, error: "تعذّر حفظ الحساب. لم يتم إنشاء أي شيء." };
  }

  revalidatePath("/admin/users");
  return { ok: true, info: `تم إنشاء حساب ${displayName}.` };
}

// ───────────────────────── role ─────────────────────────

export async function setUserRole(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("user.manage");
  if (!auth.ok) return auth;

  const uid = optionalString(formData.get("id"));
  const role = String(formData.get("role") ?? "").trim();
  if (!uid) return { ok: false, error: "معرّف غير صالح." };
  if (!isRole(role)) return { ok: false, error: `الصلاحية يجب أن تكون إحدى: ${ROLES.join(", ")}` };

  const self = selfEditRefusal(auth.user.uid, uid);
  if (self) return { ok: false, error: self };

  const snapshot = await users().doc(uid).get();
  if (!snapshot.exists) return { ok: false, error: "الحساب غير موجود." };
  const subject = snapshot.data() as UserDoc;
  if (subject.role === role) return { ok: true, info: "لا تغيير." };

  if (role !== "ADMIN") {
    const refusal = await lastAdminRefusal(subject);
    if (refusal) return { ok: false, error: refusal };
  }

  const batch = db().batch();
  batch.update(users().doc(uid), { role, updatedAt: Timestamp.now() });
  batch.create(
    userAuditEvents().doc(),
    auditEvent(
      "ROLE_CHANGED",
      { uid, name: subject.displayName },
      { uid: auth.user.uid, name: auth.user.displayName },
      { from: subject.role, to: role }
    )
  );
  await batch.commit();

  revalidatePath("/admin/users");
  return { ok: true, info: `تم تغيير صلاحية ${subject.displayName}.` };
}

// ───────────────────────── activation ─────────────────────────

/** Deactivating is how an account is retired; it is never deleted, because the
 *  inspections it signed have to keep pointing at somebody. Revoking the
 *  refresh tokens as well means signing out actually invalidates the
 *  credential rather than just forgetting it in one browser.
 *
 *  Firestore cannot refuse the delete the way a foreign key did, so this
 *  screen simply offers no delete: retiring an account is deactivation, and
 *  `firestore.rules` denies every client write, so nothing outside these
 *  actions can remove one either.
 */
export async function setUserActive(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("user.manage");
  if (!auth.ok) return auth;

  const uid = optionalString(formData.get("id"));
  const active = formData.get("active") === "true";
  if (!uid) return { ok: false, error: "معرّف غير صالح." };

  const snapshot = await users().doc(uid).get();
  if (!snapshot.exists) return { ok: false, error: "الحساب غير موجود." };
  const subject = snapshot.data() as UserDoc;
  if (subject.active === active) return { ok: true, info: "لا تغيير." };

  if (!active) {
    const self = selfEditRefusal(auth.user.uid, uid);
    if (self) return { ok: false, error: self };
    const refusal = await lastAdminRefusal(subject);
    if (refusal) return { ok: false, error: refusal };
  }

  const batch = db().batch();
  batch.update(users().doc(uid), { active, updatedAt: Timestamp.now() });
  batch.create(
    userAuditEvents().doc(),
    auditEvent(
      active ? "ACTIVATED" : "DEACTIVATED",
      { uid, name: subject.displayName },
      { uid: auth.user.uid, name: auth.user.displayName },
      { from: String(subject.active), to: String(active) }
    )
  );
  await batch.commit();

  if (!active) await adminAuth().revokeRefreshTokens(uid).catch(() => undefined);

  revalidatePath("/admin/users");
  return {
    ok: true,
    info: active ? `تم تفعيل ${subject.displayName}.` : `تم إيقاف ${subject.displayName}.`,
  };
}
