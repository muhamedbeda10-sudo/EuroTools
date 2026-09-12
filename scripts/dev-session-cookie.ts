/** Mint a session cookie for an existing account, for local testing.
 *
 *  The browser normally gets one by signing in and posting the resulting ID
 *  token to `createSession`. This does the same exchange from the command
 *  line, so the pages can be exercised against the emulators without driving a
 *  browser:
 *
 *      SESSION_EMAIL=qa.manager@example.com npm run dev:session
 *
 *  It prints a `Cookie:` header. It refuses to run outside the emulators: a
 *  script that hands out a twelve-hour session for any address has no business
 *  pointing at a real project.
 */

import { SESSION_MAX_AGE_MS } from "../lib/session-cookie";
import { adminAuth } from "../lib/server/firebase-admin";

async function main() {
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    console.error("\n  Refusing to run without FIREBASE_AUTH_EMULATOR_HOST set.\n");
    process.exit(1);
  }

  const email = process.env.SESSION_EMAIL;
  if (!email) {
    console.error("\n  SESSION_EMAIL is required.\n");
    process.exit(1);
  }

  const auth = adminAuth();
  const user = await auth.getUserByEmail(email);
  // A session cookie is minted from an ID token; a custom token exchanged
  // through the emulator's REST endpoint is the shortest way to one.
  const customToken = await auth.createCustomToken(user.uid);

  const response = await fetch(
    `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=emulator`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    }
  );
  if (!response.ok) throw new Error(`token exchange failed: ${await response.text()}`);

  const { idToken } = (await response.json()) as { idToken: string };
  const cookie = await auth.createSessionCookie(idToken, { expiresIn: SESSION_MAX_AGE_MS });

  console.log(`qc_session=${cookie}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
