"use client";

import { getApp, getApps, initializeApp } from "firebase/app";
import { getAuth, inMemoryPersistence, type Auth } from "firebase/auth";

/** Browser-side Firebase, used for one thing only: exchanging an email and
 *  password for an ID token, which is then posted to the server and traded for
 *  an httpOnly session cookie.
 *
 *  Persistence is deliberately in-memory. The Firebase SDK would otherwise
 *  keep its own copy of the session in IndexedDB, leaving two sources of truth
 *  about who is signed in — and the one the server cannot see would outlive a
 *  sign-out. The cookie is the session; nothing else is.
 */
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
};

export function clientAuth(): Auth {
  const app = getApps().length > 0 ? getApp() : initializeApp(config);
  const auth = getAuth(app);
  void auth.setPersistence(inMemoryPersistence);
  return auth;
}
