"use client";

import { useActionState } from "react";
import type { ReactNode } from "react";
import type { ActionResult } from "@/lib/client/actions";

type Action = (formData: FormData) => Promise<ActionResult>;

/** A <form> that shows the action's own error/info line and disables its
 *  submit while in flight. Server actions here return a result object rather
 *  than throwing, so a validation failure never loses what was typed. */
export function ActionForm({
  action,
  submitLabel,
  children,
  className = "",
  submitClassName = "btn-primary",
  confirm,
  id,
  secondary,
  onSuccess,
}: {
  action: Action;
  submitLabel: string;
  children: ReactNode;
  className?: string;
  submitClassName?: string;
  confirm?: string;
  id?: string;
  /** A way out, beside the way forward. Rendered next to the submit rather
   *  than left among the fields, where it reads as one of them. */
  secondary?: ReactNode;
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
      id={id}
      action={formAction}
      className={className}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {children}

      {state?.error && (
        <p className="mt-3 rounded-lg bg-[var(--bad-bg)] px-3 py-2 text-sm font-semibold text-[var(--bad-fg)]">
          {state.error}
        </p>
      )}
      {state?.ok && state.info && (
        <p className="mt-3 rounded-lg bg-[var(--ok-bg)] px-3 py-2 text-sm font-semibold text-[var(--ok-fg)]">
          {state.info}
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="submit" className={`btn ${submitClassName}`} disabled={pending}>
          {pending ? "Saving…" : submitLabel}
        </button>
        {secondary}
      </div>
    </form>
  );
}
