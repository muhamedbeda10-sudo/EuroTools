"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  setPersistence,
  type Auth,
} from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";

/** Firebase, from the browser, which is now the only place it is used.
 *
 *  There is no server in this application any more: it is static files served
 *  by Firebase Hosting, and every read and write goes straight from the page
 *  to Firestore. That makes `firestore.rules` the entire security boundary —
 *  see the long note at the top of that file for what it does and does not
 *  guarantee.
 *
 *  The configuration below reaches the browser by design. It identifies the
 *  project; it grants nothing. Anyone can read it out of the bundle and the
 *  rules are what stops them doing anything with it.
 *
 *  Sessions persist in browser storage rather than in an httpOnly cookie,
 *  because there is no server left to set one. That is a real difference: the
 *  session is now readable by anything running in the page. It is also why
 *  deactivating an account is checked on every rule evaluation rather than
 *  trusted from a token — a retired inspector's stored session stops working
 *  on their next click, not when it expires.
 */
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

/** Emulator wiring happens once per SDK instance, and calling it twice throws.
 *  The app object is the natural place to remember that it has been done. */
let wired = false;

function app(): FirebaseApp {
  return getApps().length > 0 ? getApp() : initializeApp(config);
}

function connectEmulatorsOnce(auth: Auth, firestore: Firestore): void {
  if (wired) return;
  wired = true;

  const firestoreHost = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST;
  const authHost = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
  if (!firestoreHost && !authHost) return;

  if (firestoreHost) {
    const [host, port] = firestoreHost.split(":");
    connectFirestoreEmulator(firestore, host, Number(port));
  }
  if (authHost) connectAuthEmulator(auth, `http://${authHost}`, { disableWarnings: true });
}

export function clientAuth(): Auth {
  const auth = getAuth(app());
  connectEmulatorsOnce(auth, getFirestore(app()));
  // Survives a reload and a closed tab, which a shop-floor tablet needs.
  void setPersistence(auth, browserLocalPersistence);
  return auth;
}

export function clientDb(): Firestore {
  const firestore = getFirestore(app());
  connectEmulatorsOnce(getAuth(app()), firestore);
  return firestore;
}
