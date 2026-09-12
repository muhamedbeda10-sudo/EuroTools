"use client";

import {
  collection,
  doc,
  type CollectionReference,
  type DocumentReference,
} from "firebase/firestore";

import { COLLECTIONS, SUBCOLLECTIONS } from "@/lib/model";
import { clientDb } from "@/lib/client/firebase";

/** Collection handles, so a path is spelled once.
 *
 *  The layout itself is described in `lib/model.ts`, which imports no SDK and
 *  is shared with the command-line scripts. This module is only the browser's
 *  way of reaching it.
 */

export const users = () => collection(clientDb(), COLLECTIONS.users);
export const userAuditEvents = () => collection(clientDb(), COLLECTIONS.userAuditEvents);
export const uniques = () => collection(clientDb(), COLLECTIONS.uniques);
export const suppliers = () => collection(clientDb(), COLLECTIONS.suppliers);
export const materials = () => collection(clientDb(), COLLECTIONS.materials);
export const lots = () => collection(clientDb(), COLLECTIONS.lots);
export const parts = () => collection(clientDb(), COLLECTIONS.parts);
export const inspections = () => collection(clientDb(), COLLECTIONS.inspections);
export const stats = () => collection(clientDb(), COLLECTIONS.stats);

export const analysesOf = (lotId: string): CollectionReference =>
  collection(clientDb(), COLLECTIONS.lots, lotId, SUBCOLLECTIONS.analyses);

export const eventsOf = (partId: string): CollectionReference =>
  collection(clientDb(), COLLECTIONS.parts, partId, SUBCOLLECTIONS.events);

/** Thumbnails of an inspection's photographs — what a gallery reads. */
export const photosOf = (inspectionId: string): CollectionReference =>
  collection(clientDb(), COLLECTIONS.inspections, inspectionId, SUBCOLLECTIONS.photos);

/** The full pictures, read one at a time when somebody opens one. */
export const photoDataOf = (inspectionId: string): CollectionReference =>
  collection(clientDb(), COLLECTIONS.inspections, inspectionId, SUBCOLLECTIONS.photoData);

/** A fresh Firestore id, for entries embedded in a document.
 *
 *  Embedded checklist answers, certificates and features still need something
 *  stable to address them by — a form posts back "the measured value for
 *  feature X" — and the SDK only generates ids through a collection handle.
 *  This names what is happening so the handle it borrows does not read as a
 *  write to that collection.
 */
export function newId(): string {
  return doc(collection(clientDb(), "_ids")).id;
}

export const docIn = (ref: CollectionReference, id?: string): DocumentReference =>
  id ? doc(ref, id) : doc(ref);
