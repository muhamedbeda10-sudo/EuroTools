import "server-only";

import { getFirestore, type Firestore } from "firebase-admin/firestore";

import { adminApp } from "@/lib/server/firebase-admin";

/** Firestore through the Admin SDK.
 *
 *  The application itself no longer uses this: it is a static site that talks
 *  to Firestore from the browser, under `firestore.rules`. What is left here
 *  is for the command-line scripts — seeding demo data, and opening the first
 *  administrator account — which need to write before any account exists to
 *  write with, and so run outside the rules by design.
 *
 *  That is also why it has no place in a deployed artifact. It runs on a
 *  maintainer's machine, against the emulators or with a service-account key.
 */
const globalForFirestore = globalThis as unknown as { qcFirestore?: Firestore };

export function db(): Firestore {
  if (globalForFirestore.qcFirestore) return globalForFirestore.qcFirestore;

  const instance = getFirestore(adminApp());
  // Undefined is what an optional field parses to, and writing one would
  // otherwise throw rather than clear the field.
  instance.settings({ ignoreUndefinedProperties: true });

  globalForFirestore.qcFirestore = instance;
  return instance;
}
