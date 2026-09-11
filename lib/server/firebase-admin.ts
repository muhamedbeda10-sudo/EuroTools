import "server-only";

import { applicationDefault, getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";

/** The Admin SDK, created once per server instance and never at build time.
 *
 *  Credentials come from Application Default Credentials, which is exactly
 *  what App Hosting hands the container: the Cloud Run runtime service
 *  account, with no key file anywhere in the image or the repository. That
 *  service account needs the Service Account Token Creator role on itself,
 *  because minting a session cookie is a signing operation — see the
 *  deployment section of the README.
 *
 *  Locally, point GOOGLE_APPLICATION_CREDENTIALS at a service-account key that
 *  is never committed.
 */
const globalForFirebase = globalThis as unknown as { qcAdminApp?: App };

function adminApp(): App {
  if (globalForFirebase.qcAdminApp) return globalForFirebase.qcAdminApp;

  const existing = getApps();
  const app =
    existing.length > 0
      ? existing[0]
      : initializeApp({
          credential: applicationDefault(),
          projectId:
            process.env.FIREBASE_PROJECT_ID ?? process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
        });

  globalForFirebase.qcAdminApp = app;
  return app;
}

/** Resolved per call rather than at module load, so importing this file during
 *  the build never reaches for credentials that only exist at runtime. */
export function adminAuth(): Auth {
  return getAuth(adminApp());
}
