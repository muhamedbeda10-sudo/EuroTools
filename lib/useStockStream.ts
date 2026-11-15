"use client";
import { useEffect, useState } from "react";
import { request } from "./api";

export type StreamState = "connecting" | "live" | "failed";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tick-by-tick quote and order book of one stock, pushed by the server as it changes.
 *
 *  The server holds the connection to the data feed (its credentials never reach
 *  this page) and ends each stream before its own time limit, so this simply
 *  opens the next one. The stream is dropped while the tab is hidden and picked
 *  up again when it is back. After three failures in a row it gives up and
 *  reports `failed`, so the caller can fall back to polling.
 */
export function useStockStream(symbol: string, enabled: boolean) {
  const [tick, setTick] = useState<any>(null);
  const [state, setState] = useState<StreamState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [at, setAt] = useState<Date | null>(null);
  const [open, setOpen] = useState(true);   // is a session running, as the server sees it

  useEffect(() => {
    if (!enabled || !symbol) return;
    let stopped = false;
    let current: AbortController | null = null;
    setTick(null);
    setState("connecting");
    setError(null);

    const run = async () => {
      let failures = 0;
      while (!stopped) {
        if (document.visibilityState !== "visible") {
          await sleep(1500);
          continue;
        }
        current = new AbortController();
        let ended = false;
        try {
          const res = await request(`/api/v1/stocks/${symbol}/stream`, { signal: current.signal });
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
              let event = "message";
              let data: any = null;
              for (const line of block.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) data = JSON.parse(line.slice(5));
              }
              if (event === "message" && data) {
                failures = 0;
                setTick(data);
                setAt(new Date());
                setState("live");
                setError(null);
              } else if (event === "hello") {
                // a greeting proves nothing about the feed: only real prices clear the failure count
                setOpen(data?.market_open !== false);
              } else if (event === "failed") {
                throw new Error(data?.detail ?? "The live stream failed.");
              } else if (event === "end") {
                ended = true;
              }
            }
          }
          if (!ended && !stopped && document.visibilityState === "visible") failures++; // cut off mid-stream
        } catch (e: any) {
          if (stopped) return;
          if (e?.name !== "AbortError") {
            failures++;
            setError(e.message);
          }
        }
        if (failures >= 3) {
          setTick(null);   // the last tick is not shown as if it were still arriving
          setState("failed");
          return;
        }
        await sleep(failures ? 1500 * failures : 150);
      }
    };
    run();
    const onVisibility = () => {
      if (document.visibilityState !== "visible") current?.abort(); // nobody is looking: free the connection
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      current?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [symbol, enabled]);

  return { tick, state, error, at, open };
}
