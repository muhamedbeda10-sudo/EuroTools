"use client";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { request } from "./api";
import { DATA_UPDATED } from "./useApi";

/** Latest tick of a stock: [last price, day change %, volume today]. */
export type Tick = [number, number | null, number | null];
type Store = {
  quotes: Map<string, Tick>;
  indices: Map<string, [number, number | null]>;
  listeners: Set<() => void>;
  version: number;
  state: "off" | "connecting" | "live" | "failed";
  at: number;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const EMPTY = new Map<string, Tick>();
const LiveContext = createContext<Store | null>(null);

/** Keeps one streaming connection to the server while the market is open and the tab is visible,
 *  and holds the latest price of every stock for whatever is on screen to read.
 *  Prices are pushed as trades happen; nothing here polls on a timer. */
export function LiveProvider({ enabled, children }: { enabled: boolean; children: React.ReactNode }) {
  const store = useRef<Store>({ quotes: new Map(), indices: new Map(), listeners: new Set(), version: 0, state: "off", at: 0 }).current;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let current: AbortController | null = null;
    let pending = false;
    const notify = () => {
      // at most ~5 screen updates a second, however fast the market is trading
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        store.version++;
        store.listeners.forEach((l) => l());
      }, 200);
    };
    const setState = (s: Store["state"]) => { if (store.state !== s) { store.state = s; notify(); } };
    // A tick is only worth showing while the stream that brought it is alive: when it stops, for
    // whatever reason, every screen goes back to the server's figures instead of a frozen price.
    const drop = (s: Store["state"]) => { store.quotes.clear(); store.indices.clear(); store.state = s; notify(); };

    const run = async () => {
      let failures = 0;
      setState("connecting");
      while (!stopped) {
        if (document.visibilityState !== "visible") { await sleep(1500); continue; }
        current = new AbortController();
        let ended = false;
        try {
          const res = await request("/api/v1/market/stream", { signal: current.signal });
          const reader = res.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let cut: number;
            while ((cut = buffer.indexOf("\n\n")) >= 0) {
              const block = buffer.slice(0, cut);
              buffer = buffer.slice(cut + 2);
              let event = "message", data: any = null;
              for (const line of block.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data = JSON.parse(line.slice(5));
              }
              if (event === "message" && data) {
                failures = 0;
                for (const [symbol, tick] of Object.entries(data.q ?? {})) store.quotes.set(symbol, tick as Tick);
                for (const [id, tick] of Object.entries(data.i ?? {})) store.indices.set(names.get(id) ?? id, tick as [number, number | null]);
                store.at = Date.now();
                store.state = "live";
                notify();
              } else if (event === "hello") {
                // A greeting proves nothing about the feed: only real prices clear the failure count.
                for (const [id, name] of Object.entries(data?.indices ?? {})) names.set(id, name as string);
                if (data?.market_open === false) {
                  // The session is over: stop streaming and let every screen re-read the closing figures.
                  stopped = true;
                  current?.abort();
                  drop("off");
                  window.dispatchEvent(new Event(DATA_UPDATED));
                  return;
                }
              } else if (event === "failed") {
                throw new Error(data?.detail ?? "stream failed");
              } else if (event === "end") {
                ended = true;
              }
            }
          }
          if (!ended && !stopped && document.visibilityState === "visible") failures++;
        } catch (e: any) {
          if (stopped) return;
          if (e?.name !== "AbortError") failures++;
        }
        if (failures >= 3) { drop("failed"); return; } // the 15-second refresh carries on underneath
        await sleep(failures ? 1500 * failures : 150);
      }
    };
    const names = new Map<string, string>();
    run();
    const onVisibility = () => { if (document.visibilityState !== "visible") current?.abort(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      current?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
      drop("off");
    };
  }, [enabled, store]);

  return <LiveContext.Provider value={store}>{children}</LiveContext.Provider>;
}

function useStore<T>(read: (s: Store) => T, fallback: T): T {
  const store = useContext(LiveContext);
  return useSyncExternalStore(
    (l) => { store?.listeners.add(l); return () => { store?.listeners.delete(l); }; },
    () => (store ? read(store) : fallback),
    () => fallback,
  );
}

/** The live tick of one stock, or undefined when nothing has streamed for it. Re-renders only when it changes. */
export const useTick = (symbol: string): Tick | undefined =>
  useStore((s) => (s.state === "live" ? s.quotes.get(symbol) : undefined), undefined);
export const useIndexTick = (name: string) => useStore((s) => (s.state === "live" ? s.indices.get(name) : undefined), undefined);
/** Connection state and a counter that moves whenever any price moved (for lists that re-rank). */
export const useLiveState = () => {
  const state = useStore((s) => s.state, "off" as Store["state"]);
  const version = useStore((s) => s.version, 0);
  const store = useContext(LiveContext);
  // Ticks are handed out only while the stream is live, so nothing ranks or colours from leftovers.
  const quotes = state === "live" && store ? store.quotes : EMPTY;
  return { state, version, quotes, at: store?.at ?? 0 };
};

/** A number that flashes green or red for a moment when it changes. */
export function Flash({ value, children, className = "" }: { value: number | null | undefined; children: React.ReactNode; className?: string }) {
  const previous = useRef(value);
  const [dir, setDir] = useState<"" | "tick-up" | "tick-down">("");
  useEffect(() => {
    if (value == null || previous.current == null || value === previous.current) { previous.current = value; return; }
    setDir(value > previous.current ? "tick-up" : "tick-down");
    previous.current = value;
    const t = setTimeout(() => setDir(""), 600);
    return () => clearTimeout(t);
  }, [value]);
  return <span className={`${className} ${dir}`.trim()}>{children}</span>;
}
