"use client";
import { ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type Time } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { useTheme } from "./Shell";

/** Chart colours come from the design tokens, so both themes are selected rather than flipped. */
function palette() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    text: v("--muted"), grid: v("--border"), up: v("--up"), down: v("--down"), bg: v("--surface"),
    series: [v("--series-1"), v("--series-2"), v("--series-3")],
  };
}

function base(el: HTMLDivElement, height: number): IChartApi {
  const p = palette();
  return createChart(el, {
    height,
    autoSize: true,
    // The TradingView mark is replaced by a text credit and link in the page footer (see Shell).
    layout: { background: { type: ColorType.Solid, color: p.bg }, textColor: p.text, fontSize: 11, fontFamily: getComputedStyle(document.body).fontFamily,
              attributionLogo: false },
    // recessive, hairline, solid: the data is the only thing allowed to be loud
    grid: { vertLines: { visible: false }, horzLines: { color: p.grid, style: LineStyle.Solid } },
    rightPriceScale: { borderVisible: false },
    timeScale: { borderVisible: false },
    crosshair: { mode: CrosshairMode.Normal, vertLine: { color: p.text, width: 1, style: LineStyle.Solid, labelBackgroundColor: p.text },
                 horzLine: { color: p.text, width: 1, style: LineStyle.Solid, labelBackgroundColor: p.text } },
    handleScale: { axisPressedMouseMove: true },
  });
}

export type Bar = {
  time: string; open: number; high: number; low: number; close: number; volume: number;
  sma20: number | null; sma50: number | null; sma200: number | null;
  rsi: number | null; macd: number | null; macd_signal: number | null; macd_hist: number | null;
};

const line = (bars: Bar[], key: keyof Bar) =>
  bars.filter((b) => b[key] != null).map((b) => ({ time: b.time as Time, value: b[key] as number }));

/** The three averages take the chart palette's three series slots, in fixed order. */
export const SMA_KEYS = ["sma20", "sma50", "sma200"] as const;
export const SMA_VARS = { sma20: "var(--series-1)", sma50: "var(--series-2)", sma200: "var(--series-3)" };
export const SMA_COLORS = SMA_VARS;

export function PriceChart({ bars, support, resistance, show = { sma20: true, sma50: true, sma200: true, volume: true }, height = 420 }: {
  bars: Bar[]; support?: number; resistance?: number; height?: number;
  show?: { sma20: boolean; sma50: boolean; sma200: boolean; volume: boolean };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  useEffect(() => {
    if (!ref.current) return;
    const p = palette();
    const chart = base(ref.current, height);
    const candles = chart.addCandlestickSeries({ upColor: p.up, downColor: p.down, wickUpColor: p.up, wickDownColor: p.down, borderVisible: false });
    candles.setData(bars.map((b) => ({ time: b.time as Time, open: b.open, high: b.high, low: b.low, close: b.close })));
    SMA_KEYS.forEach((k, i) => {
      if (!show[k]) return;
      chart.addLineSeries({ color: p.series[i], lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }).setData(line(bars, k));
    });
    if (support) candles.createPriceLine({ price: support, color: p.text, lineStyle: LineStyle.Dashed, lineWidth: 1, title: "support", axisLabelVisible: true });
    if (resistance) candles.createPriceLine({ price: resistance, color: p.text, lineStyle: LineStyle.Dashed, lineWidth: 1, title: "resistance", axisLabelVisible: true });
    if (show.volume) {
      const vol = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
      vol.setData(bars.map((b) => ({ time: b.time as Time, value: b.volume, color: (b.close >= b.open ? p.up : p.down) + "55" })));
    }
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [bars, support, resistance, theme, height, show.sma20, show.sma50, show.sma200, show.volume]);
  return <div ref={ref} className="chart" role="img" aria-label="Candlestick price chart with moving averages and volume" />;
}

export function RsiChart({ bars }: { bars: Bar[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  useEffect(() => {
    if (!ref.current) return;
    const p = palette();
    const chart = base(ref.current, 130);
    const s = chart.addLineSeries({ color: p.series[0], lineWidth: 2, priceLineVisible: false });
    s.setData(line(bars, "rsi"));
    s.createPriceLine({ price: 70, color: p.text, lineStyle: LineStyle.Dashed, lineWidth: 1, title: "overbought" });
    s.createPriceLine({ price: 30, color: p.text, lineStyle: LineStyle.Dashed, lineWidth: 1, title: "oversold" });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [bars, theme]);
  return <div ref={ref} className="chart" role="img" aria-label="RSI chart" />;
}

export function MacdChart({ bars }: { bars: Bar[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  useEffect(() => {
    if (!ref.current) return;
    const p = palette();
    const chart = base(ref.current, 130);
    chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }).setData(
      bars.filter((b) => b.macd_hist != null).map((b) => ({ time: b.time as Time, value: b.macd_hist as number, color: ((b.macd_hist as number) >= 0 ? p.up : p.down) + "88" })),
    );
    chart.addLineSeries({ color: p.series[0], lineWidth: 2, priceLineVisible: false, lastValueVisible: false }).setData(line(bars, "macd"));
    chart.addLineSeries({ color: p.series[1], lineWidth: 2, priceLineVisible: false, lastValueVisible: false }).setData(line(bars, "macd_signal"));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [bars, theme]);
  return <div ref={ref} className="chart" role="img" aria-label="MACD chart" />;
}

export const LINE_COLORS = ["var(--series-1)", "var(--series-2)", "var(--series-3)"];

/** Up to three series on one axis. One series is drawn as an area and needs no legend; more get one. */
export function LinesChart({ series, height = 300 }: { series: { name: string; points: { date: string; value: number }[] }[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const theme = useTheme();
  useEffect(() => {
    if (!ref.current) return;
    const p = palette();
    const chart = base(ref.current, height);
    // money on the axis: whole pounds with thousands separators, not 52000.00
    const money = { type: "custom" as const, minMove: 1, formatter: (v: number) => Math.round(v).toLocaleString("en-US") };
    series.forEach((s, i) => {
      const data = s.points.map((pt) => ({ time: pt.date as Time, value: pt.value }));
      if (series.length === 1) {
        chart.addAreaSeries({ lineColor: p.series[0], lineWidth: 2, topColor: p.series[0] + "2e", bottomColor: p.series[0] + "00", priceLineVisible: false, priceFormat: money }).setData(data);
      } else {
        chart.addLineSeries({ color: p.series[i % 3], lineWidth: 2, priceLineVisible: false, lastValueVisible: i === 0, priceFormat: money }).setData(data);
      }
    });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [series, height, theme]);
  return (
    <>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s, i) => <span key={s.name}><i style={{ background: LINE_COLORS[i % 3] }} />{s.name}</span>)}
        </div>
      )}
      <div ref={ref} className="chart" role="img" aria-label={`Line chart: ${series.map((s) => s.name).join(", ")}`} />
    </>
  );
}
