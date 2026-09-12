/** Session configuration with no dependencies.
 *
 *  `proxy.ts` runs outside the application's module graph and must not pull in
 *  anything server-only, and the command-line scripts must not pull in
 *  `next/navigation`. So the two values both of them need live here on their
 *  own, rather than in `lib/server/auth.ts` with the rest of the session
 *  handling.
 */

export const SESSION_COOKIE = "qc_session";

/** One shift. Long enough that an inspector is not signing in again in the
 *  middle of a job, short enough that a tablet left on the shop floor has
 *  stopped being a way in by the next morning. */
export const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
