"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

/** Fired on `window` when new market data has been saved. */
export const DATA_UPDATED = "egx:data-updated";
const PRICE_PATHS = ["/api/v1/status", "/api/v1/market", "/api/v1/stocks", "/api/v1/watchlist", "/api/v1/portfolio", "/api/v1/trades", "/api/v1/signals", "/api/v1/orders"];

/** Parts of a page that show the same thing (the market strip and the dashboard both read the portfolio) ask the
 *  server at the same moment. They share one request: every request costs the database reads, and it has a daily
 *  allowance. Only requests started together are shared; one already on its way is never reused, so a screen that
 *  re-reads after a change gets what the server holds after it. */
const SAME_MOMENT_MS = 100;
const started = new Map<string, { at: number; answer: Promise<any> }>();

function read<T>(path: string, fresh: boolean): Promise<T> {
  const now = Date.now();
  const running = started.get(path);
  if (running && !fresh && now - running.at < SAME_MOMENT_MS) return running.answer;
  const entry = { at: now, answer: api<T>(path) };
  started.set(path, entry);
  const forget = () => { if (started.get(path) === entry) started.delete(path); };
  entry.answer.then(forget, forget);
  return entry.answer;
}

export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  const fresh = useRef(false);   // the screen asked for this read itself (after saving something): never a shared one
  const reload = useCallback(() => { fresh.current = true; setTick((t) => t + 1); }, []);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path) return;
    let live = true;
    setLoading(true);
    const own = fresh.current;
    fresh.current = false;
    read<T>(path, own)
      .then((d) => live && (setData(d), setError(null), setStatus(200)))
      .catch((e) => live && (setError(e.message), setStatus(e.status ?? 0)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [path, tick]);

  // Fresh market data arrived: every screen re-reads what it shows, without a page reload.
  // Only screens that show prices do this; forms being edited (fees, strategies) are left alone.
  const showsPrices = !!path && PRICE_PATHS.some((p) => path.startsWith(p));
  useEffect(() => {
    if (!showsPrices) return;
    window.addEventListener(DATA_UPDATED, refresh);
    return () => window.removeEventListener(DATA_UPDATED, refresh);
  }, [refresh, showsPrices]);

  return { data, error, status, loading, reload };
}
