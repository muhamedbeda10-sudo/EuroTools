import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE } from "@/lib/session-cookie";

/** Routes reachable without a session. */
const PUBLIC_PATHS = new Set(["/login"]);

/** Keeps signed-out traffic off the application, and nothing more.
 *
 *  This is an optimistic check on purpose: it looks at whether a session
 *  cookie is present, never at whether it is valid, and never touches the
 *  database. Proxy runs on every request including prefetches, so a query here
 *  would be a query on every hovered link.
 *
 *  It is not a security boundary. `requirePermission` in `lib/server/auth.ts`
 *  is, and it runs next to the data on every write.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);

  if (hasSession || PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  // Carry the destination so an inspector who opened a part directly lands
  // back on it rather than on the dashboard. The login page validates this
  // before using it.
  if (pathname !== "/") url.searchParams.set("next", pathname + request.nextUrl.search);

  return NextResponse.redirect(url);
}

export const config = {
  /** Everything except Next.js internals and static files. Auth is meant to
   *  run on all routes, so the exclusions are only for things that never carry
   *  a session. */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|.*\\.(?:png|jpg|jpeg|svg|webp)$).*)"],
};
