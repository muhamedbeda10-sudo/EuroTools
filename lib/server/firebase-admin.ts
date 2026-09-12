import "server-only";

import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

/** The Admin SDK, created once per server instance and never at build time.
 *
 *  In production, credentials come from Application Default Credentials, which
 *  is exactly what App Hosting hands the container: the Cloud Run runtime
 *  service account, with no key file anywhere in the image or the repository.
 *  That service account needs the Service Account Token Creator role on
 *  itself, because minting a session cookie is a signing operation — see the
 *  deployment section of the README.
 *
 *  Against the emulators there are no credentials to find, and asking for them
 *  would throw. The emulator host variables are the signal, and they are set
 *  by `npm run emulators`, so a developer can run the whole app locally
 *  without a service-account key ever existing on their machine. That is worth
 *  having on its own: a key that is never created cannot be committed.
 */
const globalForFirebase = globalThis as unknown as { qcAdminApp?: App };

function usingEmulators(): boolean {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST);
}

function projectId(): string | undefined {
  return (
    process.env.FIREBASE_PROJECT_ID ??
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ??
    process.env.GCLOUD_PROJECT
  );
}

export function adminApp(): App {
  if (globalForFirebase.qcAdminApp) return globalForFirebase.qcAdminApp;

  const existing = getApps();
  const app =
    existing.length > 0
      ? existing[0]
      : initializeApp(
          usingEmulators()
            ? { projectId: projectId() }
            : { credential: applicationDefault(), projectId: projectId() }
        );

  globalForFirebase.qcAdminApp = app;
  return app;
}

/** Resolved per call rather than at module load, so importing this file during
 *  the build never reaches for credentials that only exist at runtime. */
export function adminAuth(): Auth {
  return getAuth(adminApp());
}
