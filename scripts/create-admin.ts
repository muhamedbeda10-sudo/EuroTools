/** Create the first administrator, in Firebase Authentication and in the
 *  database, so a freshly deployed instance has someone who can sign in.
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
 *      npm run create-admin
 *
 *  Running it again for an address that already exists updates the name and
 *  role and reactivates the account; it never silently resets a password.
 */

import { PrismaClient } from "@prisma/client";
import { applicationDefault, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

import { ROLES, isRole } from "../lib/domain/roles";

const prisma = new PrismaClient();

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

async function main() {
  const email = arg("email")?.toLowerCase();
  const password = arg("password");
  const displayName = arg("name");
  const role = arg("role") ?? "ADMIN";

  if (!email) fail("ADMIN_EMAIL is required.");
  if (!displayName) fail("ADMIN_NAME is required — it is the name that signs records.");
  if (!isRole(role)) fail(`ADMIN_ROLE must be one of: ${ROLES.join(", ")}`);

  if (getApps().length === 0)
    initializeApp({
      credential: applicationDefault(),
      projectId: process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    });
  const auth = getAuth();

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

    const created = await auth.createUser({
      email,
      password,
      displayName,
      emailVerified: true,
    });
    uid = created.uid;
    console.log(`  Firebase: created ${email}`);
  }

  const user = await prisma.user.upsert({
    where: { firebaseUid: uid },
    create: { firebaseUid: uid, email, displayName, role, active: true },
    update: { email, displayName, role, active: true },
  });

  console.log(`  Database: ${user.displayName} <${user.email}> is ${user.role}, active`);
  console.log("\n  Done. Sign in at /login.\n");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
