"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BrandLink } from "./Brand";
import { ThemeToggle } from "./ThemeToggle";
import { ROLE_LABELS, can } from "@/lib/domain/roles";
import { signOut, useSession } from "@/lib/client/session";

const LINKS = [
  { href: "/", label: "Dashboard", permission: null },
  { href: "/planning", label: "Planning", permission: null },
  { href: "/queue", label: "Inspection", permission: null },
  { href: "/settings", label: "Settings", permission: "config.manage" },
  { href: "/admin/users", label: "Users", permission: "user.manage" },
] as const;

export function AppNav() {
  const { user } = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Hiding a link the account cannot use is a courtesy, not a control: the
  // security rules refuse the reads behind it either way.
  const links = user && can(user.role, "user.manage")
    ? [...LINKS, { href: "/admin/users", label: "Users" }]
    : LINKS;

  // Signed out — on the login page, or still restoring a session. There is
  // nowhere useful to navigate to yet.
  if (!user) return null;

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  return (
    <header className="no-print sticky top-0 z-20 border-b border-[var(--border)] bg-[var(--surface)]">
      {/* Three columns with equal outer tracks, so the tabs sit on the centre
          line of the window rather than in whatever space the mark and the
          account controls happen to leave over. */}
      <div className="grid grid-cols-[auto_1fr] items-center gap-3 px-3 py-2 lg:grid-cols-[1fr_auto_1fr] lg:px-6 lg:py-2.5">
        <BrandLink />

        <nav className="hidden items-center justify-center gap-0.5 lg:flex xl:gap-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-lg px-2.5 py-1.5 text-sm font-semibold whitespace-nowrap transition xl:px-3 ${
                isActive(l.href)
                  ? "bg-[var(--brand-light)] text-[var(--brand-dark)]"
                  : "text-[var(--muted)] hover:bg-[var(--surface-2)]"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center justify-end gap-2">
          <div className="hidden text-end leading-tight xl:block">
            <div className="text-sm font-semibold">{user.displayName}</div>
            <div className="text-xs text-[var(--muted)]">{ROLE_LABELS[user.role].en}</div>
          </div>

          <div className="hidden lg:flex lg:items-center lg:gap-2">
            <button type="button" className="btn" title="Sign out" onClick={() => void signOut()}>
              Sign out
            </button>
            <ThemeToggle />
          </div>

          {/* One control on a phone. Everything else moves into the sheet
              below, where a gloved thumb can actually hit it. */}
          <button
            type="button"
            className="btn min-h-11 px-3 lg:hidden"
            aria-expanded={open}
            aria-controls="app-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            <span aria-hidden className="text-lg leading-none">
              {open ? "✕" : "☰"}
            </span>
          </button>
        </div>
      </div>

      {open && (
        <div id="app-menu" className="border-t border-[var(--border)] lg:hidden">
          <nav className="grid gap-1 px-3 py-2">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className={`flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold ${
                  isActive(l.href)
                    ? "bg-[var(--brand-light)] text-[var(--brand-dark)]"
                    : "text-[var(--muted)]"
                }`}
              >
                {l.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center justify-between gap-2 border-t border-[var(--border)] px-3 py-2">
            <div className="leading-tight">
              <div className="text-sm font-semibold">{user.displayName}</div>
              <div className="text-xs text-[var(--muted)]">{ROLE_LABELS[user.role].en}</div>
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <button
                type="button"
                className="btn min-h-11"
                onClick={() => void signOut()}
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
