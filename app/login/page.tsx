"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { LoginForm } from "@/components/LoginForm";
import { safeNextPath } from "@/lib/format";

function LoginPanel() {
  // `next` comes off the query string, so it is narrowed to somewhere inside
  // this application before anything navigates to it.
  const destination = safeNextPath(useSearchParams().get("next"));

  return (
    <div className="mx-auto grid w-full max-w-sm gap-6 py-10">
      <div className="grid justify-items-center gap-2 text-center">
        <span
          aria-hidden
          className="grid h-12 w-12 place-items-center rounded-xl bg-[var(--brand)] text-lg font-bold text-white"
        >
          QC
        </span>
        <h1 className="text-xl font-bold">فحص الجودة</h1>
        <p className="text-sm text-[var(--muted)]">
          سجّل دخولك للمتابعة. كل فحص يُوقَّع باسم صاحب الحساب.
        </p>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-5">
        <LoginForm destination={destination} />
      </div>
    </div>
  );
}

export default function LoginPage() {
  // A static export has no server to read the query string, so the component
  // that reads it has to be allowed to render on the client first.
  return (
    <Suspense fallback={null}>
      <LoginPanel />
    </Suspense>
  );
}
