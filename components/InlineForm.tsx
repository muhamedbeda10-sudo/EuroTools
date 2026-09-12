"use client";

import { useActionState } from "react";
import type { ReactNode } from "react";
import type { ActionResult } from "@/lib/client/actions";

/** A compact inline form for table/list rows: the submit sits among the
 *  fields rather than below them, and any error appears under the row. */
export function InlineForm({
  action,
  submitLabel,
  children,
  className = "flex flex-wrap items-end gap-2",
  submitClassName = "",
  confirm,
  onSuccess,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  submitLabel: string;
  children: ReactNode;
  className?: string;
  submitClassName?: string;
  confirm?: string;
  /** Re-read the page's data. Replaces `revalidatePath`, which needed a
   *  server. */
  onSuccess?: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    async (_prev: ActionResult | null, formData: FormData) => {
      const result = await action(formData);
      if (result.ok) onSuccess?.();
      return result;
    },
    null
  );

  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      <div className={className}>
        {children}
        <button type="submit" className={`btn ${submitClassName}`} disabled={pending}>
          {pending ? "…" : submitLabel}
        </button>
      </div>

      {state?.error && (
        <p className="mt-1 text-xs font-semibold text-[var(--bad-fg)]">{state.error}</p>
      )}
      {state?.ok && state.info && (
        <p className="mt-1 text-xs font-semibold text-[var(--ok-fg)]">{state.info}</p>
      )}
    </form>
  );
}
