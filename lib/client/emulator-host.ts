/** Whether an emulator address is one this page could actually reach.
 *
 *  Kept apart from `firebase.ts` because it is a plain decision with no SDK in
 *  it, and because it is the last thing standing between a mistake in the
 *  build and an application that loads perfectly and then fails every read.
 *
 *  The mistake is easy to make. Next.js merges `.env` into *every* build, and
 *  a `.env.production` that simply omits the emulator hosts inherits them
 *  instead of clearing them. They are then inlined into the bundle as string
 *  literals, and a tablet on the shop floor is told to fetch its data from
 *  127.0.0.1 — its own loopback, where nothing is listening.
 *
 *  So: a loopback emulator address is only meaningful if the page itself came
 *  from that same machine. A deliberate LAN address is left alone — pointing a
 *  real tablet at the emulators on a workstation is a real thing to do, and
 *  such an address cannot arrive by accident from a committed `.env`.
 */

/** Addresses that mean "the machine this code is running on". */
function isLoopback(host: string): boolean {
  const bare = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return (
    bare === "localhost" ||
    bare === "::1" ||
    bare === "0.0.0.0" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
  );
}

/** Split `host:port`, tolerating an IPv6 address in brackets. Returns null for
 *  anything that is not a usable pair, which the caller treats as "no
 *  emulator" rather than guessing at a port. */
export function parseEmulatorHost(value: string): { host: string; port: number } | null {
  const trimmed = value.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon <= 0) return null;

  const host = trimmed.slice(0, colon);
  const port = Number(trimmed.slice(colon + 1));
  if (host === "" || !Number.isInteger(port) || port < 1 || port > 65535) return null;

  return { host, port };
}

/** True when `emulatorHost` is worth connecting to from a page served by
 *  `pageHostname` (the value of `window.location.hostname`). */
export function emulatorIsReachable(emulatorHost: string, pageHostname: string): boolean {
  const parsed = parseEmulatorHost(emulatorHost);
  if (!parsed) return false;
  if (!isLoopback(parsed.host)) return true;
  return isLoopback(pageHostname);
}
