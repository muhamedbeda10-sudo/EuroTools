"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/** A button that opens a panel under it.
 *
 *  Small on purpose. It closes on Escape, on a click anywhere else, and when
 *  anything inside it is clicked — the last one because every item in these
 *  menus navigates or acts, and a menu that stays open over the page you just
 *  asked for is a menu somebody has to close twice.
 */
export function Menu({
  label,
  align = "start",
  children,
  buttonClassName = "btn",
  title,
}: {
  label: ReactNode;
  align?: "start" | "end";
  children: ReactNode;
  buttonClassName?: string;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={root}>
      <button
        type="button"
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>

      {open && (
        <div
          role="menu"
          className={`menu-pop absolute top-[calc(100%+0.4rem)] z-40 min-w-56 overflow-hidden rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--surface)] shadow-[var(--shadow-lg)] ${
            align === "end" ? "end-0" : "start-0"
          }`}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** One row of a menu. A link or a button, styled the same either way, because
 *  which one it is is an implementation detail to the hand using it. */
export function MenuItem({
  icon,
  children,
  onClick,
  href,
  tone,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  href?: string;
  tone?: "bad";
}) {
  const className = `flex min-h-11 w-full items-center gap-2.5 px-3 text-start text-sm font-semibold transition-colors hover:bg-[var(--surface-2)] ${
    tone === "bad" ? "text-[var(--bad-fg)]" : ""
  }`;

  if (href)
    return (
      <a href={href} className={className} role="menuitem">
        {icon}
        {children}
      </a>
    );

  return (
    <button type="button" className={className} role="menuitem" onClick={onClick}>
      {icon}
      {children}
    </button>
  );
}

export function MenuHeading({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">
      {children}
    </div>
  );
}
