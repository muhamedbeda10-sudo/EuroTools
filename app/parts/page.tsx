import Link from "next/link";

import { Card, Empty, PageHeader, StatusPill } from "@/components/ui";
import { getParts } from "@/lib/server/queries";
import { isStage, stageDef, STAGE_DEFS } from "@/lib/domain/stages";
import { fmtDate, pct } from "@/lib/format";

export const dynamic = "force-dynamic";

const STATUS_FILTERS = [
  { value: "", label: "الكل" },
  { value: "IN_PROCESS", label: "قيد التشغيل" },
  { value: "REWORK", label: "إعادة تشغيل" },
  { value: "HOLD", label: "موقوف" },
  { value: "RELEASED", label: "مُفرج عنه" },
  { value: "REJECTED", label: "مرفوض" },
];

export default async function PartsPage({ searchParams }: PageProps<"/parts">) {
  const sp = await searchParams;
  const statusRaw = typeof sp.status === "string" ? sp.status : "";
  const stageRaw = typeof sp.stage === "string" ? sp.stage : "";

  const status = STATUS_FILTERS.some((f) => f.value === statusRaw && f.value !== "")
    ? statusRaw
    : undefined;
  const stage = isStage(stageRaw) ? stageRaw : undefined;

  const parts = await getParts({ stage, status });

  const q = (next: Record<string, string>) => {
    const params = new URLSearchParams();
    if (next.status) params.set("status", next.status);
    if (next.stage) params.set("stage", next.stage);
    const s = params.toString();
    return s ? `/parts?${s}` : "/parts";
  };

  return (
    <>
      <PageHeader title="الأجزاء" subtitle="سجل تتبع كل جزء عبر المراحل" />

      <Card className="mb-4">
        <div className="flex flex-wrap gap-4">
          <div>
            <div className="label">الحالة</div>
            <div className="flex flex-wrap gap-1">
              {STATUS_FILTERS.map((f) => (
                <Link
                  key={f.value}
                  href={q({ status: f.value, stage: stageRaw })}
                  className={`rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-semibold ${
                    (status ?? "") === f.value
                      ? "bg-[var(--brand)] text-white"
                      : "bg-[var(--surface-2)] text-[var(--muted)]"
                  }`}
                >
                  {f.label}
                </Link>
              ))}
            </div>
          </div>

          <div>
            <div className="label">المرحلة</div>
            <div className="flex flex-wrap gap-1">
              <Link
                href={q({ status: statusRaw, stage: "" })}
                className={`rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-semibold ${
                  !stage ? "bg-[var(--brand)] text-white" : "bg-[var(--surface-2)] text-[var(--muted)]"
                }`}
              >
                الكل
              </Link>
              {STAGE_DEFS.filter((d) => d.subject === "PART").map((d) => (
                <Link
                  key={d.stage}
                  href={q({ status: statusRaw, stage: d.stage })}
                  className={`rounded-[var(--radius-sm)] px-2.5 py-1 text-xs font-semibold ${
                    stage === d.stage
                      ? "bg-[var(--brand)] text-white"
                      : "bg-[var(--surface-2)] text-[var(--muted)]"
                  }`}
                >
                  {d.ar}
                </Link>
              ))}
            </div>
          </div>
        </div>
      </Card>

      <Card action={<span className="pill pill-neutral">{parts.length} جزء</span>}>
        {parts.length === 0 ? (
          <Empty>لا توجد أجزاء مطابقة لهذا التصفية.</Empty>
        ) : (
          <div className="scroll-x">
            <table className="tbl">
              <thead>
                <tr>
                  <th>الرقم المسلسل</th>
                  <th>رقم الجزء</th>
                  <th>التشغيلة</th>
                  <th>المرحلة الحالية</th>
                  <th>التقدم</th>
                  <th>آخر فحص</th>
                  <th>الحالة</th>
                </tr>
              </thead>
              <tbody>
                {parts.map((p) => {
                  const last = p.inspections[0];
                  return (
                    <tr key={p.id}>
                      <td>
                        <Link
                          href={`/parts/${p.id}`}
                          className="ltr font-bold text-[var(--brand)]"
                        >
                          {p.serialNumber}
                        </Link>
                      </td>
                      <td className="ltr">{p.material.partNumber}</td>
                      <td className="ltr text-xs">{p.lot?.lotNumber ?? "—"}</td>
                      <td>
                        {p.currentStage === "DONE" ? (
                          <span className="text-xs text-[var(--muted)]">انتهى</span>
                        ) : (
                          stageDef(p.currentStage).ar
                        )}
                      </td>
                      <td>
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-[var(--surface-2)]">
                            <div
                              className="h-full rounded-full bg-[var(--brand)]"
                              style={{ width: `${p.progress * 100}%` }}
                            />
                          </div>
                          <span className="num text-xs text-[var(--muted)]">
                            {pct(p.progress)}
                          </span>
                        </div>
                      </td>
                      <td className="text-xs">
                        {last ? (
                          <>
                            <span className="num">{fmtDate(last.inspectedAt)}</span>
                            <span className="text-[var(--muted)]"> · {last.inspector}</span>
                          </>
                        ) : (
                          <span className="text-[var(--muted)]">—</span>
                        )}
                      </td>
                      <td>
                        <StatusPill status={p.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
