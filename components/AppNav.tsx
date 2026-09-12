"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { BrandLink } from "./Brand";
import { Menu, MenuHeading, MenuItem } from "./Menu";
import { ThemeToggle } from "./ThemeToggle";
import { GearIcon, SignOutIcon, SlidersIcon, UsersIcon } from "./icons";
import { ROLE_LABELS, allows, describeOverrides } from "@/lib/domain/roles";
import { signOut, useSession } from "@/lib/client/session";

/** The places a shift actually goes. Settings and accounts are not among
 *  them — they are set up once and then left alone, so they live behind the
 *  gear rather than taking a tab somebody passes over all day. */
const LINKS = [
  { href: "/", label: "Dashboard" },
  { href: "/planning", label: "Planning" },
  { href: "/queue", label: "Inspection" },
] as const;

export function AppNav() {
  const { user } = useSession();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Signed out — on the login page, or still restoring a session. There is
  // nowhere useful to navigate to yet.
  if (!user) return null;

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  // Hiding what an account cannot use is a courtesy, not a control: the
  // security rules refuse the writes behind it either way.
  const maySetUp = allows(user, "config.manage") || allows(user, "user.manage");
  const overrides = describeOverrides(user);

  const setUpMenu = (
    <>
      <MenuHeading>Set up once</MenuHeading>
      {allows(user, "config.manage") && (
        <MenuItem href="/settings/" icon={<SlidersIcon />}>
          Dimensions &amp; defects
        </MenuItem>
      )}
      {allows(user, "user.manage") && (
        <MenuItem href="/admin/users/" icon={<UsersIcon />}>
          People &amp; permissions
        </MenuItem>
      )}
    </>
  );

  return (
    <>
      <header className="no-print sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur">
      {/* Equal outer tracks, so the tabs sit on the centre line of the window
          rather than in whatever the mark and the account controls leave. */}
      <div className="grid grid-cols-[auto_1fr] items-center gap-2 px-3 py-2 lg:grid-cols-[1fr_auto_1fr] lg:gap-3 lg:px-4 lg:py-2.5">
        <div className="flex items-center gap-2">
          {maySetUp && (
            <Menu
              align="start"
              title="Set up"
              buttonClassName="btn btn-icon"
              label={<GearIcon className="h-5 w-5" />}
            >
              {setUpMenu}
            </Menu>
          )}
          <BrandLink />
        </div>

        <nav className="hidden items-center justify-center gap-0.5 lg:flex xl:gap-1">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`nav-tab ${isActive(l.href) ? "nav-tab-on" : ""}`}
            >
              {l.label}
            </Link>
          ))}
        </nav>

        <div className="flex items-center justify-end gap-2">
          <div className="hidden lg:block">
            <Menu
              align="end"
              buttonClassName="btn"
              label={
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="grid h-7 w-7 place-items-center rounded-full bg-[var(--brand-light)] text-xs font-bold text-[var(--brand-dark)]"
                  >
                    {initials(user.displayName)}
                  </span>
                  <span className="hidden text-sm font-semibold xl:inline">{user.displayName}</span>
                </span>
              }
            >
              <MenuHeading>
                <div className="font-semibold text-[var(--foreground)]">{user.displayName}</div>
                <div>{ROLE_LABELS[user.role].en}</div>
                {overrides.length > 0 && (
                  <div className="mt-1 text-[var(--brand)]">{overrides.join(" · ")}</div>
                )}
              </MenuHeading>
              <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
                <span className="text-sm font-semibold">Theme</span>
                <ThemeToggle />
              </div>
              <MenuItem icon={<SignOutIcon />} tone="bad" onClick={() => void signOut()}>
                Sign out
              </MenuItem>
            </Menu>
          </div>

          {/* One control on a phone. Everything else moves into the sheet
              below, where a gloved thumb can hit it. */}
          <button
            type="button"
            className="btn btn-icon lg:hidden"
            aria-expanded={open}
            aria-controls="app-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((v) => !v)}
          >
            <span aria-hidden className="text-lg leading-none">☰</span>
          </button>
        </div>
      </div>

      </header>

      {/* On a phone the menu comes in from the side rather than pushing the
          page down: a drawer keeps the header where the thumb left it, and a
          list that unfolds downwards moves everything the eye was reading. */}
      {open && (
        <div className="lg:hidden">
          <div
            className="fade-in fixed inset-0 z-40 bg-black/50"
            onClick={() => setOpen(false)}
            aria-hidden
          />

          <div
            id="app-menu"
            role="dialog"
            aria-modal="true"
            aria-label="Menu"
            className="drawer fixed inset-y-0 start-0 z-50 flex w-[min(19rem,85vw)] flex-col border-e border-[var(--border-strong)] bg-[var(--surface)] shadow-[var(--shadow-lg)]"
          >
            <div className="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2.5">
              <BrandLink />
              <button
                type="button"
                className="btn btn-icon"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
              >
                <span aria-hidden className="text-lg leading-none">✕</span>
              </button>
            </div>

            <nav className="grid gap-1 overflow-y-auto p-3">
              {LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className={`nav-tab flex min-h-11 items-center ${isActive(l.href) ? "nav-tab-on" : ""}`}
                >
                  {l.label}
                </Link>
              ))}

              {maySetUp && (
                <>
                  <p className="mt-3 px-3 text-xs text-[var(--muted)]">Set up once</p>
                  {allows(user, "config.manage") && (
                    <Link
                      href="/settings/"
                      onClick={() => setOpen(false)}
                      className="nav-tab flex min-h-11 items-center gap-2.5"
                    >
                      <SlidersIcon /> Dimensions &amp; defects
                    </Link>
                  )}
                  {allows(user, "user.manage") && (
                    <Link
                      href="/admin/users/"
                      onClick={() => setOpen(false)}
                      className="nav-tab flex min-h-11 items-center gap-2.5"
                    >
                      <UsersIcon /> People &amp; permissions
                    </Link>
                  )}
                </>
              )}
            </nav>

            <div className="mt-auto border-t border-[var(--border)] p-3">
              <div className="mb-2 flex items-center gap-2.5">
                <span
                  aria-hidden
                  className="grid h-9 w-9 place-items-center rounded-full bg-[var(--brand-light)] text-sm font-bold text-[var(--brand-dark)]"
                >
                  {initials(user.displayName)}
                </span>
                <div className="leading-tight">
                  <div className="text-sm font-semibold">{user.displayName}</div>
                  <div className="text-xs text-[var(--muted)]">{ROLE_LABELS[user.role].en}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <ThemeToggle />
                <button
                  type="button"
                  className="btn min-h-11 flex-1"
                  onClick={() => void signOut()}
                >
                  <SignOutIcon /> Sign out
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Two letters for the avatar. A name people actually have, not a formula:
 *  one word gives one letter rather than a doubled one. */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 1).toUpperCase();
  return (words[0][0] + words[words.length - 1][0]).toUpperCase();
}
