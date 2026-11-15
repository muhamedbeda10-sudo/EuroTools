"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/** Fired on `window` when new market data has been saved. */
export const DATA_UPDATED = "egx:data-updated";
const PRICE_PATHS = ["/api/v1/status", "/api/v1/market", "/api/v1/stocks", "/api/v1/watchlist", "/api/v1/portfolio", "/api/v1/trades", "/api/v1/signals", "/api/v1/orders"];

export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!path) return;
    let live = true;
    setLoading(true);
    api<T>(path)
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
    window.addEventListener(DATA_UPDATED, reload);
    return () => window.removeEventListener(DATA_UPDATED, reload);
  }, [reload, showsPrices]);

  return { data, error, status, loading, reload };
}
