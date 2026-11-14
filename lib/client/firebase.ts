"use client";

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { browserLocalPersistence, connectAuthEmulator, getAuth, setPersistence, type Auth } from "firebase/auth";

/** Sign-in for the app. The database is never touched from the browser: the
 *  page only obtains a sign-in token here and sends it to the API.
 *
 *  These values identify the Firebase project and grant nothing. They are
 *  public by design (every Firebase web app ships them in its bundle); access
 *  is decided by firestore.rules. Environment variables override them, which
 *  is how local development points at the emulator project instead.
 */
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? "AIzaSyA9XdUMM1KXbkthRnUGpgbqVnTjJbWWdlE",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN ?? "eurotools-a1ea6.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? "eurotools-a1ea6",
};

/** Set NEXT_PUBLIC_AUTH=off to run locally without sign-in against a SQLite-backed API. */
export const firebaseConfigured = process.env.NEXT_PUBLIC_AUTH !== "off";

let wired = false;

function app(): FirebaseApp {
  return getApps().length > 0 ? getApp() : initializeApp(config);
}

export function clientAuth(): Auth {
  const auth = getAuth(app());
  if (!wired) {
    wired = true;
    const emulator = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
    // Only ever honoured on a developer machine; a deployed page ignores it.
    if (emulator && typeof window !== "undefined" && ["localhost", "127.0.0.1"].includes(window.location.hostname)) {
      connectAuthEmulator(auth, `http://${emulator}`, { disableWarnings: true });
    }
    void setPersistence(auth, browserLocalPersistence);
  }
  return auth;
}
