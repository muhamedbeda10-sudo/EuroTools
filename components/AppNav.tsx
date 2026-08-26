"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { ThemeToggle } from "./ThemeToggle";

const LINKS = [
  { href: "/", label: "لوحة المتابعة" },
  { href: "/lots", label: "استلام الخامات" },
  { href: "/queue", label: "طوابير الفحص" },
  { href: "/parts", label: "الأجزاء" },
  { href: "/materials", label: "المواصفات" },
  { href: "/reports", label: "التقارير" },
];

export function AppNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

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
          {LINKS.map((l) => (
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
          {LINKS.map((l) => (
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
