import { redirect } from "next/navigation";

import { LoginForm } from "@/components/LoginForm";
import { safeNextPath } from "@/lib/format";
import { currentUser } from "@/lib/server/auth";

export const dynamic = "force-dynamic";

export const metadata = { title: "تسجيل الدخول — فحص الجودة" };

export default async function LoginPage(props: PageProps<"/login">) {
  // Someone arriving here with a live session has no business seeing a login
  // form; send them back to work.
  if (await currentUser()) redirect("/");

  // `next` comes off the query string, so it is narrowed to somewhere inside
  // this application before it is handed to the form.
  const { next } = await props.searchParams;
  const destination = safeNextPath(Array.isArray(next) ? next[0] : next);

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
