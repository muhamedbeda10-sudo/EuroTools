import "server-only";

import { Timestamp, type Transaction } from "firebase-admin/firestore";

import { COLLECTIONS, SUBCOLLECTIONS, uniqueKey } from "@/lib/model";
import type { UniqueScope } from "@/lib/model";
import { db } from "@/lib/server/firestore";

/** Admin-SDK handles for the command-line scripts.
 *
 *  The document shapes, the collection names and the uniqueness key are all in
 *  `lib/model.ts`, which imports no SDK and is shared with the browser. This
 *  module is only the scripts' way of reaching them.
 */

export * from "@/lib/model";

// ───────────────────────── collection handles ─────────────────────────

export const users = () => db().collection(COLLECTIONS.users);
export const userAuditEvents = () => db().collection(COLLECTIONS.userAuditEvents);
export const uniques = () => db().collection(COLLECTIONS.uniques);
export const suppliers = () => db().collection(COLLECTIONS.suppliers);
export const materials = () => db().collection(COLLECTIONS.materials);
export const lots = () => db().collection(COLLECTIONS.lots);
export const parts = () => db().collection(COLLECTIONS.parts);
export const inspections = () => db().collection(COLLECTIONS.inspections);
export const stats = () => db().collection(COLLECTIONS.stats);

export const analysesOf = (lotId: string) => lots().doc(lotId).collection(SUBCOLLECTIONS.analyses);
export const eventsOf = (partId: string) => parts().doc(partId).collection(SUBCOLLECTIONS.events);

// ───────────────────────── uniqueness ─────────────────────────



/** Claim a value inside a transaction, or say who already holds it.
 *
 *  Firestore has no unique index, so uniqueness is a document whose id *is*
 *  the value: two writers racing for the same part number both try to create
 *  the same document, and Firestore lets exactly one of them win. This has to
 *  run in the same transaction as the write it protects, or a crash between
 *  the two leaves a reservation pointing at nothing.
 */
export async function reserveUnique(
  tx: Transaction,
  scope: UniqueScope,
  value: string,
  ownerPath: string
): Promise<{ ok: true } | { ok: false; ownerPath: string }> {
  const ref = uniques().doc(uniqueKey(scope, value));
  const existing = await tx.get(ref);

  if (existing.exists) {
    const owner = (existing.data() as { ownerPath?: string } | undefined)?.ownerPath ?? "";
    if (owner === ownerPath) return { ok: true };
    return { ok: false, ownerPath: owner };
  }

  tx.create(ref, { scope, value: value.trim(), ownerPath, at: Timestamp.now() });
  return { ok: true };
}

/** Give a value back, when a record is renamed onto a different one. */
export function releaseUnique(tx: Transaction, scope: UniqueScope, value: string): void {
  tx.delete(uniques().doc(uniqueKey(scope, value)));
}

/** A fresh Firestore id, for entries embedded in a document.
 *
 *  Embedded checklist answers, certificates and features still need something
 *  stable to address them by — a form posts back "the actual value for feature
 *  X" — and Firestore only generates ids through a collection handle. This
 *  names what is happening so the handle it borrows does not read as a write
 *  to that collection.
 */
export function newId(): string {
  return db().collection("_ids").doc().id;
}
