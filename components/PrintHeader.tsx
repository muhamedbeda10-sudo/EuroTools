"use client";

import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

import { Brand } from "./Brand";
import { fmtDateTime } from "@/lib/format";

/** The letterhead on anything this application prints.
 *
 *  A printed sheet leaves the building. It is filed, posted to a customer,
 *  pinned beside a machine, and read a year later by somebody who was not
 *  here — so it has to say, on the paper itself, whose record it is, what it
 *  covers, when it was taken off the system and by whom. A page of tables with
 *  no heading is not a quality record; it is a printout.
 *
 *  Shown only on paper. On screen the header bar already says all of this, and
 *  saying it twice would cost the shop-floor tablet a third of its screen.
 */
export function PrintHeader({
  title,
  subtitle,
  by,
}: {
  title: string;
  subtitle?: ReactNode;
  by?: string;
}) {
  /** Stamped into the DOM rather than held in state, and re-stamped when the
   *  print dialog opens.
   *
   *  Two reasons. The page is prerendered at build time, so a date rendered
   *  during render would be the build's and would disagree with the browser on
   *  hydration. And the useful date is the moment the paper came out, not the
   *  moment the tab was opened — a queue left open all shift would otherwise
   *  print this morning's time. Writing it directly is also the only way to be
   *  sure it is on the page before the browser takes its snapshot; a state
   *  update is not guaranteed to have rendered by then. */
  const stamped = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const stamp = () => {
      if (stamped.current) stamped.current.textContent = fmtDateTime(new Date());
    };
    stamp();
    window.addEventListener("beforeprint", stamp);
    return () => window.removeEventListener("beforeprint", stamp);
  }, []);

  return (
    <header className="print-only print-head">
      <div className="print-mark">
        <Brand size="sm" />
      </div>

      <div className="min-w-0 flex-1 px-4">
        <h1>{title}</h1>
        {subtitle && <p className="text-xs text-[var(--muted)]">{subtitle}</p>}
      </div>

      <div className="meta">
        <div><span ref={stamped} /></div>
        {by && <div>Printed by {by}</div>}
      </div>
    </header>
  );
}
