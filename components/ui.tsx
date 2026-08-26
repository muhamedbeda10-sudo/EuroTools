import Link from "next/link";
import type { ReactNode } from "react";
import { STATUS_LABELS, type Status } from "@/lib/domain/stages";

/** One colour per verdict, used by every table, card and header. */
const STATUS_TONE: Record<string, string> = {
  ACCEPTED: "pill-ok",
  RELEASED: "pill-ok",
  PASS: "pill-ok",
  IN_PROCESS: "pill-info",
  PENDING: "pill-neutral",
  REWORK: "pill-warn",
  HOLD: "pill-warn",
  FURTHER_INVESTIGATION: "pill-warn",
  REJECTED: "pill-bad",
  FAIL: "pill-bad",
};

const EXTRA_LABELS: Record<string, string> = {
  IN_PROCESS: "قيد التشغيل",
  HOLD: "موقوف",
  DONE: "منتهي",
  PASS: "مطابق",
  FAIL: "غير مطابق",
};

export function StatusPill({ status }: { status: string }) {
  const label =
    STATUS_LABELS[status as Status]?.ar ?? EXTRA_LABELS[status] ?? status;
  return <span className={`pill ${STATUS_TONE[status] ?? "pill-neutral"}`}>{label}</span>;
}

export function Card({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div>
            {title && <h2 className="font-bold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-[var(--muted)]">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-[var(--muted)]">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone = "neutral",
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "neutral" | "ok" | "warn" | "bad" | "info";
  href?: string;
}) {
  const toneClass = {
    neutral: "text-[var(--foreground)]",
    ok: "text-[var(--ok-fg)]",
    warn: "text-[var(--warn-fg)]",
    bad: "text-[var(--bad-fg)]",
    info: "text-[var(--info-fg)]",
  }[tone];

  const body = (
    <>
      <div className="text-xs font-semibold text-[var(--muted)]">{label}</div>
      <div className={`num mt-1 text-2xl font-bold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-[var(--muted)]">{hint}</div>}
    </>
  );

  if (href) {
    return (
      <Link href={href} className="card block p-4 transition hover:shadow-md">
        {body}
      </Link>
    );
  }
  return <div className="card p-4">{body}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="py-8 text-center text-sm text-[var(--muted)]">{children}</p>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-[var(--muted)]">{hint}</p>}
    </div>
  );
}

/** A short read-only key/value line, for spec panels. */
export function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-[var(--border)] py-1.5 last:border-0">
      <span className="text-xs text-[var(--muted)]">{k}</span>
      <span className="text-sm font-semibold">{v}</span>
    </div>
  );
}
