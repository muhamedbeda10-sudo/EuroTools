import "server-only";

import { getFirestore, type Firestore } from "firebase-admin/firestore";

import { adminApp } from "@/lib/server/firebase-admin";

/** The Firestore handle, created once per server instance.
 *
 *  Everything reaches Firestore through the Admin SDK, on the server. Nothing
 *  in the browser talks to the database: `firestore.rules` denies all client
 *  access, and the pages go through Server Actions that check the caller's
 *  role first. That is deliberate — a Firestore security rule cannot read the
 *  User document and reason about roles the way `requirePermission` does, so
 *  putting the boundary in the rules would mean a weaker boundary.
 */
const globalForFirestore = globalThis as unknown as { qcFirestore?: Firestore };

export function db(): Firestore {
  if (globalForFirestore.qcFirestore) return globalForFirestore.qcFirestore;

  const instance = getFirestore(adminApp());
  // Undefined is what an optional form field parses to, and writing one would
  // otherwise throw rather than clear the field.
  instance.settings({ ignoreUndefinedProperties: true });

  globalForFirestore.qcFirestore = instance;
  return instance;
}
