"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";

import { clientAuth } from "@/lib/firebase/client";
import { createSession } from "@/lib/server/session-actions";

/** Sign-in is a two-step exchange, and both steps have to succeed.
 *
 *  Firebase checks the password in the browser and returns an ID token. The
 *  server then checks that the account is provisioned and active here before
 *  it issues the session cookie. A password that Firebase accepts still gets
 *  no session if this plant has not granted the account a role.
 *
 *  Failures are reported the same way whatever went wrong, so the form never
 *  tells a stranger whether an address exists.
 */
export function LoginForm({ destination }: { destination: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");

    if (!email || !password) {
      setError("البريد الإلكتروني وكلمة المرور مطلوبان.");
      setPending(false);
      return;
    }

    try {
      const credential = await signInWithEmailAndPassword(clientAuth(), email, password);
      const idToken = await credential.user.getIdToken();

      const result = await createSession(idToken);
      if (!result.ok) {
        setError(result.error ?? "تعذّر تسجيل الدخول.");
        setPending(false);
        return;
      }

      // The session cookie is set; re-render the tree so the server sees it.
      router.replace(destination);
      router.refresh();
    } catch {
      setError("البريد الإلكتروني أو كلمة المرور غير صحيحة.");
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <label className="grid gap-1.5">
        <span className="text-sm font-semibold">البريد الإلكتروني</span>
        <input
          className="input"
          name="email"
          type="email"
          autoComplete="username"
          dir="ltr"
          required
          autoFocus
        />
      </label>

      <label className="grid gap-1.5">
        <span className="text-sm font-semibold">كلمة المرور</span>
        <input
          className="input"
          name="password"
          type="password"
          autoComplete="current-password"
          dir="ltr"
          required
        />
      </label>

      {error && (
        <p
          role="alert"
          className="rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm font-semibold text-[var(--bad-fg)]"
        >
          {error}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full justify-center" disabled={pending}>
        {pending ? "جارٍ الدخول…" : "تسجيل الدخول"}
      </button>

      <p className="text-center text-xs text-[var(--muted)]">
        الحسابات يُنشئها مدير النظام. لا يوجد تسجيل ذاتي.
      </p>
    </form>
  );
}
