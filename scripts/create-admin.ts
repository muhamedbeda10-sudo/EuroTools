/** Create the first administrator, in Firebase Authentication and in
 *  Firestore, so a freshly deployed instance has someone who can sign in.
 *
 *  Everything after this account is created through the application. This
 *  script exists only because the very first account has nobody to create it.
 *
 *  Usage — prefer the environment over arguments, because a password passed as
 *  an argument is visible in shell history and in the process list:
 *
 *      ADMIN_EMAIL=qa.manager@example.com \
 *      ADMIN_PASSWORD='…' \
 *      ADMIN_NAME='م. منى رشاد' \
 *      FIREBASE_PROJECT_ID=your-project \
 *      npm run create-admin
 *
 *  Running it again for an address that already exists updates the name and
 *  role and reactivates the account; it never silently resets a password.
 */

import { Timestamp } from "firebase-admin/firestore";

import { ROLES, isRole } from "../lib/domain/roles";
import { adminAuth } from "../lib/server/firebase-admin";
import { db } from "../lib/server/firestore";
import { userAuditEvents, users, type UserDoc } from "../lib/server/model";

/** Read a value from the environment, falling back to --flag=value. */
function arg(name: string): string | undefined {
  const fromEnv = process.env[`ADMIN_${name.toUpperCase()}`];
  if (fromEnv && fromEnv.trim() !== "") return fromEnv.trim();

  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  const value = flag?.slice(`--${name}=`.length).trim();
  return value === "" ? undefined : value;
}

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

/** The Admin SDK needs credentials, and the error it raises when it has none
 *  names a Google documentation page rather than the two things to do about
 *  it. This says them instead. */
function requireCredentials(): void {
  if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) return;

  const project =
    process.env.FIREBASE_PROJECT_ID ??
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??
    process.env.GCLOUD_PROJECT;
  const key = process.env.GOOGLE_APPLICATION_CREDENTIALS;

  if (project && key) return;

  fail(
    [
      "هذا السكربت يكتب قبل وجود أي حساب، فهو يحتاج مفتاح خدمة.",
      "",
      "  من Firebase Console:",
      "    Settings (⚙) → Project settings → Service accounts",
      "    → Generate new private key → احفظ الملف خارج المستودع",
      "",
      "  ثم شغّل:",
      "",
      "    FIREBASE_PROJECT_ID=<project-id> \\",
      "    GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json \\",
      "    ADMIN_EMAIL=... ADMIN_NAME='...' ADMIN_PASSWORD='...' \\",
      "      npm run create-admin",
      "",
      "  أو أنشئ الحساب يدويًا من Console — الخطوات بالحقول في README",
      "  تحت «أول حساب»، ولا تحتاج مفتاحًا على الإطلاق.",
    ].join("\n  ")
  );
}

async function main() {
  requireCredentials();

  const email = arg("email")?.toLowerCase();
  const password = arg("password");
  const displayName = arg("name");
  const role = arg("role") ?? "ADMIN";

  if (!email) fail("ADMIN_EMAIL is required.");
  if (!displayName) fail("ADMIN_NAME is required — it is the name that signs records.");
  if (!isRole(role)) fail(`ADMIN_ROLE must be one of: ${ROLES.join(", ")}`);

  const auth = adminAuth();

  // Find the Firebase account or create it. An existing one is left alone
  // apart from its display name: this script must never be a way to take over
  // somebody's account by resetting their password.
  let uid: string;
  try {
    const existing = await auth.getUserByEmail(email);
    uid = existing.uid;
    await auth.updateUser(uid, { displayName, disabled: false });
    console.log(`  Firebase: reusing existing account ${email}`);
  } catch {
    if (!password)
      fail("ADMIN_PASSWORD is required to create a new account (at least 8 characters).");
    if (password.length < 8) fail("ADMIN_PASSWORD must be at least 8 characters.");

    const created = await auth.createUser({ email, password, displayName, emailVerified: true });
    uid = created.uid;
    console.log(`  Firebase: created ${email}`);
  }

  const ref = users().doc(uid);
  await db().runTransaction(async (tx) => {
    // No separate reservation for the address: the document is keyed by the
    // Firebase uid, and Authentication has already refused a duplicate one.
    const existing = await tx.get(ref);

    if (existing.exists) {
      tx.update(ref, { email, displayName, role, active: true, updatedAt: Timestamp.now() });
    } else {
      tx.create(ref, {
        email,
        displayName,
        role,
        employeeNo: null,
        active: true,
        createdAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
        // Nobody created the first account; that is what makes it the first.
        createdByUid: null,
        createdByName: null,
        signedInspections: 0,
      } satisfies UserDoc);
    }

    tx.create(userAuditEvents().doc(), {
      at: Timestamp.now(),
      kind: existing.exists ? "ROLE_CHANGED" : "CREATED",
      subjectUid: uid,
      subjectName: displayName,
      actorUid: uid,
      actorName: `${displayName} (bootstrap)`,
      fromValue: null,
      toValue: role,
    });
  });

  console.log(`  Firestore: ${displayName} <${email}> is ${role}, active`);
  console.log("\n  Done. Sign in at /login.\n");
}

main().catch((error) => {
  const message = String((error as Error)?.message ?? error);
  if (message.includes("Unable to detect a Project Id") || message.includes("Could not load the default credentials")) {
    console.error(
      "\n  تعذّر التحقق من الاعتمادات. راجع FIREBASE_PROJECT_ID و GOOGLE_APPLICATION_CREDENTIALS.\n"
    );
    process.exit(1);
  }
  console.error(error);
  process.exit(1);
});
