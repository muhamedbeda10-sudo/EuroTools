"use client";
import Link from "next/link";

export const CATEGORIES: Record<string, string> = {
  news: "News article", disclosure: "EGX disclosure", announcement: "Company announcement", financials: "Financial statements",
  broker_report: "Broker research", presentation: "Investor presentation", economic: "Economic report", other: "Other",
};
export function ResearchItem({ item, onEdit, onDelete }: { item: any; onEdit?: () => void; onDelete?: () => void }) {
  const tone = item.sentiment === "positive" ? "up" : item.sentiment === "negative" ? "down" : "muted";
  return (
    <div style={{ padding: "12px 0", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between" }}>
        <strong>{item.url ? <a href={item.url} target="_blank" rel="noopener noreferrer nofollow">{item.title} ↗</a> : item.title}</strong>
        <span className="muted" style={{ fontSize: 12 }}>{item.published ?? item.created_at.slice(0, 10)}{item.source ? ` · ${item.source}` : ""}</span>
      </div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "6px 0" }}>
        <span className="badge">{CATEGORIES[item.category] ?? item.category}</span>
        <span className={`badge ${tone}`}>{item.sentiment}</span>
        <span className="badge">importance {"●".repeat(item.importance)}{"○".repeat(3 - item.importance)}</span>
        <span className={`badge ${item.verified ? "ok" : "warn"}`}>{item.verified ? "verified" : "not verified"} · {item.reliability}</span>
        {item.symbols.map((s: string) => <Link key={s} className="badge" href={`/stock?symbol=${s}`}>{s}</Link>)}
        {item.sectors.map((s: string) => <span key={s} className="badge">{s}</span>)}
      </div>
      {item.summary && <p style={{ margin: "4px 0" }}>{item.summary}</p>}
      {item.notes && <p className="muted" style={{ margin: "4px 0", whiteSpace: "pre-wrap" }}>{item.notes}</p>}
      {(onEdit || onDelete) && (
        <div style={{ marginTop: 6 }}>
          {onEdit && <button className="small" onClick={onEdit}>Edit</button>}{" "}
          {onDelete && <button className="small danger" onClick={onDelete}>Delete</button>}
        </div>
      )}
    </div>
  );
}
