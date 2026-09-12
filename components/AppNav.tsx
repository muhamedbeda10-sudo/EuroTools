"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ThemeToggle } from "./ThemeToggle";
import { ROLE_LABELS, can } from "@/lib/domain/roles";
import { signOut, useSession } from "@/lib/client/session";

const LINKS = [
  { href: "/", label: "لوحة المتابعة" },
  { href: "/lots", label: "استلام الخامات" },
  { href: "/queue", label: "طوابير الفحص" },
  { href: "/parts", label: "الأجزاء" },
  { href: "/materials", label: "المواصفات" },
  { href: "/reports", label: "التقارير" },
];

export function AppNav() {
  const { user } = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Hiding a link the account cannot use is a courtesy, not a control: the
  // security rules refuse the reads behind it either way.
  const links = user && can(user.role, "user.manage")
    ? [...LINKS, { href: "/admin/users", label: "المستخدمون" }]
    : LINKS;

  // Signed out — on the login page, or still restoring a session. There is
  // nowhere useful to navigate to yet.
  if (!user) return null;

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <header className="no-print sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--surface)]">
      <div className="flex items-center gap-3 px-4 py-2.5 md:px-6">
        <Link href="/" className="flex items-center gap-2 font-bold">
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-lg bg-[var(--brand)] text-sm text-white"
          >
            QC
          </span>
          <span className="hidden sm:inline">فحص الجودة</span>
        </Link>

        <nav className="hidden flex-1 items-center gap-1 md:flex">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                isActive(l.href)
                  ? "bg-[var(--brand-light)] text-[var(--brand-dark)]"
                  : "text-[var(--muted)] hover:bg-[var(--surface-2)]"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="ms-auto flex items-center gap-2 md:ms-0">
          <div className="hidden text-end leading-tight sm:block">
            <div className="text-sm font-semibold">{user.displayName}</div>
            <div className="text-xs text-[var(--muted)]">{ROLE_LABELS[user.role].ar}</div>
          </div>

          <button
            type="button"
            className="btn"
            title="تسجيل الخروج"
            onClick={() => void signOut()}
          >
            خروج
          </button>

          <ThemeToggle />
          <button
            type="button"
            className="btn md:hidden"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            القائمة
          </button>
        </div>
      </div>

      {open && (
        <nav className="grid gap-1 border-t border-[var(--border)] px-4 py-2 md:hidden">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              onClick={() => setOpen(false)}
              className={`rounded-lg px-3 py-2 text-sm font-semibold ${
                isActive(l.href)
                  ? "bg-[var(--brand-light)] text-[var(--brand-dark)]"
                  : "text-[var(--muted)]"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}
