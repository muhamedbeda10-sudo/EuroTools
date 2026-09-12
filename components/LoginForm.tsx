"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { signInWithEmailAndPassword } from "firebase/auth";

import { clientAuth } from "@/lib/client/firebase";
import { useSession } from "@/lib/client/session";

/** Signing in is two checks, and both have to pass.
 *
 *  Firebase checks the password. The session provider then reads the user
 *  document and refuses an account this plant has not provisioned or has
 *  deactivated — and so, independently, do the security rules on every
 *  subsequent read. A password Firebase accepts still gets nowhere without a
 *  role granted here.
 *
 *  Failures are reported the same way whatever went wrong, so the form never
 *  tells a stranger whether an address exists.
 */
export function LoginForm({ destination }: { destination: string }) {
  const router = useRouter();
  const { user, rejection } = useSession();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // "Wrong password" and "not provisioned here" are different problems with
  // different fixes, so they are shown as they are rather than collapsed. The
  // session's verdict is read straight through instead of copied into state,
  // which would mean re-rendering the page to say what it already knew.
  const message = error ?? rejection;
  const busy = pending && !rejection;

  // The session provider is what actually decides; when it accepts somebody,
  // this page has no reason to still be on screen.
  useEffect(() => {
    if (user) router.replace(destination);
  }, [user, destination, router]);

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
      await signInWithEmailAndPassword(clientAuth(), email, password);
      // The session provider takes it from here; the effect above navigates.
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

      {message && (
        <p
          role="alert"
          className="rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm font-semibold text-[var(--bad-fg)]"
        >
          {message}
        </p>
      )}

      <button type="submit" className="btn btn-primary w-full justify-center" disabled={busy}>
        {busy ? "جارٍ الدخول…" : "تسجيل الدخول"}
      </button>

      <p className="text-center text-xs text-[var(--muted)]">
        الحسابات يُنشئها مدير النظام. لا يوجد تسجيل ذاتي.
      </p>
    </form>
  );
}
