"use client";
import type { LucideIcon } from "lucide-react";
import { egp, pct, tone } from "@/lib/format";

/** Loading and error handling for a block that depends on a request. */
export function State({ loading, error, children, skeleton }: {
  loading: boolean; error: string | null; children?: React.ReactNode; skeleton?: React.ReactNode;
}) {
  if (error) return <div className="note danger" role="alert">{error}</div>;
  if (loading && !children) return <>{skeleton ?? <Skeleton lines={3} />}</>;
  return <>{children}</>;
}

export function Skeleton({ lines = 3, height = 14 }: { lines?: number; height?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading" style={{ display: "grid", gap: 10, padding: "4px 0" }}>
      {Array.from({ length: lines }, (_, i) => <span key={i} className="skel" style={{ height, width: `${92 - ((i * 17) % 40)}%` }} />)}
    </div>
  );
}

const arrow = (v?: number | null) => (v == null || v === 0 ? "" : v > 0 ? "▲ " : "▼ ");

/** A signed percentage. Direction is carried by the sign and the arrow, with colour on top. */
export function Chg({ v }: { v?: number | null }) {
  return <span className={tone(v)}><span aria-hidden="true" style={{ fontSize: "0.72em" }}>{arrow(v)}</span>{pct(v)}</span>;
}

/** The same, as a compact chip for stat tiles and headers. */
export function Delta({ v, children }: { v?: number | null; children?: React.ReactNode }) {
  return (
    <span className={`delta ${tone(v)}`}>
      <span aria-hidden="true" style={{ fontSize: "0.7em" }}>{arrow(v)}</span>{children ?? pct(v)}
    </span>
  );
}

/** Stat tile: label, value, optional signed delta and context line. */
export function Kpi({ label, value, hint, toneOf, delta }: {
  label: string; value: React.ReactNode; hint?: React.ReactNode; toneOf?: number | null; delta?: number | null;
}) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className={`value ${toneOf === undefined ? "" : tone(toneOf)}`}>{value}</div>
      {(hint || delta !== undefined) && (
        <div className="hint">{delta !== undefined && <><Delta v={delta} />{" "}</>}{hint}</div>
      )}
    </div>
  );
}

/** Every profit figure in the app goes through this: gross and net are always shown side by side. */
export function Profit({ label, gross, net, netLabel = "Net after fees", pctNet }: {
  label: string; gross?: number | null; net?: number | null; netLabel?: string; pctNet?: number | null;
}) {
  return (
    <div className="card kpi">
      <div className="label">{label}</div>
      <div className="pair" style={{ marginTop: 10 }}>
        <div>
          <div className="label">Gross</div>
          <div className={`v ${tone(gross)}`}>{egp(gross)}</div>
        </div>
        <div>
          <div className="label">{netLabel}</div>
          <div className={`v ${tone(net)}`}>{egp(net)}{pctNet != null && <span className="muted" style={{ fontWeight: 500 }}> ({pct(pctNet)})</span>}</div>
        </div>
      </div>
    </div>
  );
}

/** Nothing to show yet: say what belongs here and how to put it there. */
export function Empty({ icon: Icon, title, children, action, left }: {
  icon?: LucideIcon; title: React.ReactNode; children?: React.ReactNode; action?: React.ReactNode; left?: boolean;
}) {
  return (
    <div className={`empty-state ${left ? "left" : ""}`}>
      {Icon && <span className="ico" aria-hidden="true"><Icon size={18} /></span>}
      <strong>{title}</strong>
      {children && <p>{children}</p>}
      {action && <div className="act">{action}</div>}
    </div>
  );
}

export function Spark({ data, width = 90, height = 26 }: { data?: number[]; width?: number; height?: number }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data), span = max - min || 1;
  const pts = data.map((v, i) => `${((i / (data.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`).join(" ");
  const up = data[data.length - 1] >= data[0];
  return (
    <svg width={width} height={height} aria-hidden="true" style={{ verticalAlign: "middle" }}>
      <polyline points={pts} fill="none" stroke={up ? "var(--up)" : "var(--down)"} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function SourceTag({ source, live }: { source?: string | null; live?: boolean }) {
  if (live) return <span className="badge ok" title="Price from the running session; today's bar is still forming">live</span>;
  if (source === "sample") return <span className="badge warn" title="Synthetic test data, not a market quote">sample</span>;
  if (source === "csv") return <span className="badge" title="Imported from CSV; not live">csv</span>;
  return null;
}

export function CardHead({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  return <div className="card-head"><h2>{title}</h2>{children}</div>;
}
