"use client";

import {
  collection,
  doc,
  type CollectionReference,
  type DocumentReference,
} from "firebase/firestore";

import { COLLECTIONS, SUBCOLLECTIONS } from "@/lib/model";
import { clientDb } from "@/lib/client/firebase";

/** Handles to the collections, named once.
 *
 *  Functions rather than constants because `clientDb()` initialises the SDK on
 *  first use, and a module-level constant would do that while the page is
 *  still being imported — before the emulator wiring has had a chance to run.
 */
export const users = () => collection(clientDb(), COLLECTIONS.users);
export const userAuditEvents = () => collection(clientDb(), COLLECTIONS.userAuditEvents);
export const planningLines = () => collection(clientDb(), COLLECTIONS.planningLines);
export const pieces = () => collection(clientDb(), COLLECTIONS.pieces);
export const inspections = () => collection(clientDb(), COLLECTIONS.inspections);
export const reworks = () => collection(clientDb(), COLLECTIONS.reworks);
export const itemConfigs = () => collection(clientDb(), COLLECTIONS.itemConfigs);
export const config = () => collection(clientDb(), COLLECTIONS.config);
export const stats = () => collection(clientDb(), COLLECTIONS.stats);

/** Thumbnails of an inspection's photographs — what a gallery reads. */
export const photosOf = (inspectionId: string): CollectionReference =>
  collection(clientDb(), COLLECTIONS.inspections, inspectionId, SUBCOLLECTIONS.photos);

/** The full pictures, read one at a time when somebody opens one. */
export const photoDataOf = (inspectionId: string): CollectionReference =>
  collection(clientDb(), COLLECTIONS.inspections, inspectionId, SUBCOLLECTIONS.photoData);

export const docIn = (ref: CollectionReference, id?: string): DocumentReference =>
  id ? doc(ref, id) : doc(ref);

/** A fresh Firestore id for something embedded in a document.
 *
 *  A dimension added on the sheet still needs something stable to address it
 *  by, and the SDK only generates ids through a collection handle. This names
 *  what is happening so the handle it borrows does not read as a write.
 */
export function newId(): string {
  return doc(collection(clientDb(), "_ids")).id;
}
