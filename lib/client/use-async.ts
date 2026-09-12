"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** Re-run the query. Forms call this after a successful write, which is what
   *  replaces `revalidatePath` now that there is no server to revalidate. */
  refresh: () => void;
}

/** Run a query and keep the page in step with it.
 *
 *  The data used to be fetched on the server and handed to the page already
 *  resolved. Reading from the browser means every page needs the same three
 *  states — loading, failed, loaded — and the same way to re-read after a
 *  write, so it lives here once rather than in each of them.
 *
 *  `loading` is derived rather than stored: the result carries the inputs that
 *  produced it, so anything that does not match the current inputs is by
 *  definition still loading. Storing it would mean setting state synchronously
 *  whenever the inputs change, which costs an extra render of every row on the
 *  page for no information nobody already had.
 *
 *  A stale response is dropped rather than rendered: switching parts quickly
 *  would otherwise let a slow first request overwrite the second one's result.
 */
export function useAsync<T>(run: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [nonce, setNonce] = useState(0);
  const key = useMemo(() => `${nonce}:${JSON.stringify(deps)}`, [nonce, deps]);

  const [result, setResult] = useState<{ key: string; data: T | null; error: string | null }>({
    key: "",
    data: null,
    error: null,
  });

  // Identifies the request in flight, so an earlier one that finishes later is
  // ignored instead of clobbering the current answer.
  const latest = useRef("");

  useEffect(() => {
    latest.current = key;

    run()
      .then((data) => {
        if (latest.current !== key) return;
        setResult({ key, data, error: null });
      })
      .catch((cause: unknown) => {
        if (latest.current !== key) return;
        const code = (cause as { code?: string }).code ?? "";
        setResult({
          key,
          data: null,
          error: code.includes("permission-denied")
            ? "You do not have permission to view this."
            : "Could not load this. Check the connection and try again.",
        });
      });

    // `run` is rebuilt on every render by design; `key` says when the query
    // actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return {
    data: result.key === key ? result.data : null,
    error: result.key === key ? result.error : null,
    loading: result.key !== key,
    refresh,
  };
}
