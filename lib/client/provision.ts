"use client";

import { deleteApp, getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  getAuth,
  signOut,
  updateProfile,
  connectAuthEmulator,
  type Auth,
} from "firebase/auth";

import { emulatorIsReachable } from "./emulator-host";

/** Creating somebody else's sign-in, from an administrator's browser.
 *
 *  There is no server here, so there is no Admin SDK: the only way to create a
 *  Firebase account is `createUserWithEmailAndPassword`, and that signs the
 *  *calling* browser in as whoever it just created. An administrator who added
 *  three inspectors would be signed out twice and end up logged in as the
 *  third.
 *
 *  The way round it is a second Firebase app object, with its own Auth
 *  instance, used for this one call and then thrown away. The session in the
 *  first one never notices. This is the supported way to do it without a
 *  server, and it is why this file exists rather than the call being made
 *  inline where it is needed.
 *
 *  What it does *not* do is grant anything. A Firebase account with no
 *  document in `users` can sign in and then read nothing at all — the rules
 *  require the document, and only an administrator may write one. Creating the
 *  sign-in and granting the access are two separate writes on purpose.
 */
const PROVISIONER = "provisioner";

function provisioningAuth(): { auth: Auth; app: FirebaseApp } {
  const primary = getApp();
  const app =
    getApps().find((a) => a.name === PROVISIONER) ??
    initializeApp(primary.options, PROVISIONER);

  const auth = getAuth(app);

  // The same wiring the primary instance gets, and for the same reason: a
  // second app object does not inherit it, and without this an account created
  // during local development would be created in the real project.
  const host = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST;
  if (host && typeof window !== "undefined" && emulatorIsReachable(host, window.location.hostname)) {
    try {
      connectAuthEmulator(auth, `http://${host}`, { disableWarnings: true });
    } catch {
      // Already wired: this app object is reused across several creations.
    }
  }

  return { auth, app };
}

export interface Provisioned {
  ok: true;
  uid: string;
}

export interface NotProvisioned {
  ok: false;
  error: string;
}

export async function createSignIn(
  email: string,
  password: string,
  displayName: string
): Promise<Provisioned | NotProvisioned> {
  const { auth, app } = provisioningAuth();

  try {
    const created = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(created.user, { displayName });
    return { ok: true, uid: created.user.uid };
  } catch (error) {
    return { ok: false, error: explain(error) };
  } finally {
    // Whatever happened, this browser must not be left holding the new
    // account's session.
    await signOut(auth).catch(() => undefined);
    await deleteApp(app).catch(() => undefined);
  }
}

function explain(error: unknown): string {
  const code = (error as { code?: string }).code ?? "";

  if (code.includes("email-already-in-use"))
    return "That address already has a sign-in. If they used to work here, an administrator can reactivate the existing account instead of creating a new one.";
  if (code.includes("invalid-email")) return "That email address is not valid.";
  if (code.includes("weak-password"))
    return "That password is too short. Firebase asks for at least six characters; use more.";
  if (code.includes("operation-not-allowed"))
    return "Email and password sign-in is switched off for this project. Turn it on under Authentication → Sign-in method.";
  if (code.includes("network"))
    return "Could not reach Firebase. Check the connection and try again.";

  return "Could not create the sign-in.";
}
