"use server";

import { revalidatePath } from "next/cache";

import { ROLES, isRole } from "@/lib/domain/roles";
import { prisma } from "@/lib/db";
import { requirePermission } from "@/lib/server/auth";
import { adminAuth } from "@/lib/server/firebase-admin";
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
 */
async function assertNotSelf(actorId: number, subjectId: number): Promise<string | null> {
  if (actorId === subjectId)
    return "لا يمكنك تعديل صلاحيتك أو إيقاف حسابك بنفسك. يجب أن يقوم بذلك مدير نظام آخر.";
  return null;
}

async function assertNotLastAdmin(subjectId: number): Promise<string | null> {
  const subject = await prisma.user.findUnique({ where: { id: subjectId } });
  if (!subject || subject.role !== "ADMIN" || !subject.active) return null;

  const others = await prisma.user.count({
    where: { role: "ADMIN", active: true, id: { not: subjectId } },
  });
  if (others === 0)
    return "هذا هو مدير النظام النشط الوحيد. عيّن مدير نظام آخر أولًا.";
  return null;
}

// ───────────────────────── create ─────────────────────────

/** Open an account in Firebase Authentication and in the database.
 *
 *  The two writes are not one transaction — they are different systems — so a
 *  database failure deletes the Firebase account it just made rather than
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

  const clash = await prisma.user.findUnique({ where: { email } });
  if (clash) return { ok: false, error: "هذا البريد مسجَّل بالفعل." };

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
      return { ok: false, error: "هذا البريد مسجَّل بالفعل في Firebase." };
    if (code === "auth/invalid-password")
      return { ok: false, error: "كلمة المرور مرفوضة من Firebase." };
    return { ok: false, error: "تعذّر إنشاء الحساب في Firebase." };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firebaseUid: uid,
          email,
          displayName,
          role,
          employeeNo,
          active: true,
          createdById: auth.user.id,
        },
      });
      await tx.userAuditEvent.create({
        data: {
          kind: "CREATED",
          subjectId: user.id,
          actorId: auth.user.id,
          toValue: role,
        },
      });
    });
  } catch {
    // Roll the Firebase side back so a retry is not blocked by a half-made
    // account nobody can see in this screen.
    await adminAuth().deleteUser(uid).catch(() => undefined);
    return { ok: false, error: "تعذّر حفظ الحساب. لم يتم إنشاء أي شيء." };
  }

  revalidatePath("/admin/users");
  return { ok: true, info: `تم إنشاء حساب ${displayName}.` };
}

// ───────────────────────── role ─────────────────────────

export async function setUserRole(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("user.manage");
  if (!auth.ok) return auth;

  const id = Number(formData.get("id"));
  const role = String(formData.get("role") ?? "").trim();
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "معرّف غير صالح." };
  if (!isRole(role)) return { ok: false, error: `الصلاحية يجب أن تكون إحدى: ${ROLES.join(", ")}` };

  const self = await assertNotSelf(auth.user.id, id);
  if (self) return { ok: false, error: self };

  const subject = await prisma.user.findUnique({ where: { id } });
  if (!subject) return { ok: false, error: "الحساب غير موجود." };
  if (subject.role === role) return { ok: true, info: "لا تغيير." };

  if (role !== "ADMIN") {
    const last = await assertNotLastAdmin(id);
    if (last) return { ok: false, error: last };
  }

  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { role } }),
    prisma.userAuditEvent.create({
      data: {
        kind: "ROLE_CHANGED",
        subjectId: id,
        actorId: auth.user.id,
        fromValue: subject.role,
        toValue: role,
      },
    }),
  ]);

  revalidatePath("/admin/users");
  return { ok: true, info: `تم تغيير صلاحية ${subject.displayName}.` };
}

// ───────────────────────── activation ─────────────────────────

/** Deactivating is how an account is retired; it is never deleted, because the
 *  inspections it signed have to keep pointing at somebody. Revoking the
 *  refresh tokens as well means signing out actually invalidates the
 *  credential rather than just forgetting it in one browser. */
export async function setUserActive(formData: FormData): Promise<ActionResult> {
  const auth = await requirePermission("user.manage");
  if (!auth.ok) return auth;

  const id = Number(formData.get("id"));
  const active = formData.get("active") === "true";
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "معرّف غير صالح." };

  if (!active) {
    const self = await assertNotSelf(auth.user.id, id);
    if (self) return { ok: false, error: self };
    const last = await assertNotLastAdmin(id);
    if (last) return { ok: false, error: last };
  }

  const subject = await prisma.user.findUnique({ where: { id } });
  if (!subject) return { ok: false, error: "الحساب غير موجود." };
  if (subject.active === active) return { ok: true, info: "لا تغيير." };

  await prisma.$transaction([
    prisma.user.update({ where: { id }, data: { active } }),
    prisma.userAuditEvent.create({
      data: {
        kind: active ? "ACTIVATED" : "DEACTIVATED",
        subjectId: id,
        actorId: auth.user.id,
        fromValue: String(subject.active),
        toValue: String(active),
      },
    }),
  ]);

  if (!active)
    await adminAuth()
      .revokeRefreshTokens(subject.firebaseUid)
      .catch(() => undefined);

  revalidatePath("/admin/users");
  return {
    ok: true,
    info: active ? `تم تفعيل ${subject.displayName}.` : `تم إيقاف ${subject.displayName}.`,
  };
}
