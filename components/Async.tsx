"use client";

import type { ReactNode } from "react";

import { Empty } from "./ui";

/** The three states every page now has, rendered the same way in each.
 *
 *  Reading from the browser means a page exists before its data does. Saying
 *  so plainly beats a flash of an empty table that looks like "no parts".
 */
export function Async<T>({
  state,
  empty,
  children,
}: {
  state: { data: T | null; loading: boolean; error: string | null };
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.loading)
    return (
      <div className="grid place-items-center py-16 text-sm text-[var(--muted)]">
        جارٍ التحميل…
      </div>
    );

  if (state.error)
    return (
      <p
        role="alert"
        className="rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm font-semibold text-[var(--bad-fg)]"
      >
        {state.error}
      </p>
    );

  if (state.data == null) return <>{empty ?? <Empty>لا توجد بيانات.</Empty>}</>;

  return <>{children(state.data)}</>;
}
