/** The session cookie's name, and nothing else.
 *
 *  `proxy.ts` runs outside the application's module graph and must not pull in
 *  anything server-only, so this constant lives on its own rather than in
 *  `lib/server/auth.ts` where the rest of the session handling is.
 */
export const SESSION_COOKIE = "qc_session";
