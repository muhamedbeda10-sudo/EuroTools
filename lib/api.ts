import { clientAuth, firebaseConfigured } from "./client/firebase";

const BASE = (process.env.NEXT_PUBLIC_API_BASE_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function detail(body: unknown, fallback: string): string {
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    return d
      .map((e: { msg?: string; loc?: unknown[] }) => `${(e.loc ?? []).slice(1).join(".")}: ${e.msg ?? ""}`.replace(/^: /, ""))
      .join("; ");
  }
  return fallback;
}

/** The signed-in user's token. The API forwards it to the database, which is what checks it. */
async function authHeaders(): Promise<Record<string, string>> {
  if (!firebaseConfigured) return {}; // local development against the SQLite backend
  const user = clientAuth().currentUser;
  if (!user) throw new ApiError("You are signed out. Sign in again.", 401);
  return { Authorization: `Bearer ${await user.getIdToken()}` };
}

/** Low-level request with authentication; resolves to the raw Response once it is OK. */
export async function request(path: string, init?: RequestInit): Promise<Response> {
  const headers = { ...(await authHeaders()), ...((init?.headers as Record<string, string>) || {}) };
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, cache: "no-store" });
  } catch {
    throw new ApiError("Cannot reach the server. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {}
    throw new ApiError(detail(body, `Request failed (${res.status})`), res.status);
  }
  return res;
}

export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const opts: RequestInit = { ...init };
  if (init?.json !== undefined) {
    opts.body = JSON.stringify(init.json);
    opts.headers = { "Content-Type": "application/json", ...(init.headers || {}) };
  }
  return (await request(path, opts)).json();
}

/** Fetch a file with authentication and hand it to the browser as a download. */
export async function download(path: string, filename: string): Promise<void> {
  const blob = await (await request(path)).blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
