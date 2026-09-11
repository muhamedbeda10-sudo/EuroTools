import "server-only";

import { prisma } from "@/lib/db";
import { requirePermission, requireUser } from "@/lib/server/auth";
import {
  analysisStatus,
  measurementResult,
  missingCertificates,
  travellerProgress,
} from "@/lib/domain/inspection";
import { PART_STAGES, STAGE_DEFS, type Stage } from "@/lib/domain/stages";

/** Every function below opens with this.
 *
 *  `proxy.ts` is an optimistic filter — it looks at whether a session cookie
 *  exists, not at whether it is genuine — so a forged cookie gets past it. The
 *  guard belongs next to the data, where it also covers any page written
 *  later without anyone having to remember to add it. A signed-out caller is
 *  redirected rather than shown an error, so the check costs nothing in
 *  usability.
 *
 *  It is memoised for the render pass, so a page calling two of these still
 *  resolves the session once.
 */

/** Everything the dashboard shows, in one pass. */
export async function getDashboard() {
  await requireUser();

  const [lots, parts, inspections] = await Promise.all([
    prisma.lot.findMany({
      include: { material: true, certificates: true, analyses: true },
      orderBy: { receivedAt: "desc" },
    }),
    prisma.part.findMany({ include: { material: true } }),
    prisma.inspection.findMany({
      orderBy: { inspectedAt: "desc" },
      take: 12,
      include: {
        part: { select: { serialNumber: true } },
        lot: { select: { lotNumber: true } },
      },
    }),
  ]);

  const lotCounts = {
    total: lots.length,
    pending: lots.filter((l) => l.status === "PENDING").length,
    accepted: lots.filter((l) => l.status === "ACCEPTED").length,
    rejected: lots.filter((l) => l.status === "REJECTED").length,
  };

  // Lots that cleared receiving but whose paperwork or analysis is unfinished.
  const blocked = lots
    .map((l) => ({
      lot: l,
      missingCerts: missingCertificates(l.material.requiredCerts, l.certificates),
      analysisPending:
        l.analyses.length > 0 && l.analyses.every((a) => a.status === "PENDING"),
      analysisRejected: l.analyses.some((a) => a.status === "REJECTED"),
    }))
    .filter(
      (r) =>
        r.lot.status !== "REJECTED" &&
        (r.missingCerts.length > 0 || r.analysisPending || r.analysisRejected)
    );

  const queues = PART_STAGES.map((stage) => ({
    stage,
    waiting: parts.filter(
      (p) =>
        p.currentStage === stage &&
        (p.status === "IN_PROCESS" || p.status === "REWORK")
    ).length,
    onHold: parts.filter((p) => p.currentStage === stage && p.status === "HOLD").length,
  }));

  const partCounts = {
    total: parts.length,
    inProcess: parts.filter((p) => p.status === "IN_PROCESS").length,
    rework: parts.filter((p) => p.status === "REWORK").length,
    hold: parts.filter((p) => p.status === "HOLD").length,
    released: parts.filter((p) => p.status === "RELEASED").length,
    rejected: parts.filter((p) => p.status === "REJECTED").length,
  };

  const closed = partCounts.released + partCounts.rejected;
  const firstPassYield = closed > 0 ? partCounts.released / closed : null;

  return { lotCounts, partCounts, queues, blocked, inspections, firstPassYield };
}

export async function getLots() {
  await requireUser();

  const lots = await prisma.lot.findMany({
    include: {
      material: true,
      supplier: true,
      certificates: true,
      analyses: { include: { results: true } },
      _count: { select: { parts: true } },
    },
    orderBy: { receivedAt: "desc" },
  });
  return lots.map((l) => ({
    ...l,
    missingCerts: missingCertificates(l.material.requiredCerts, l.certificates),
  }));
}

export async function getLot(id: number) {
  await requireUser();

  const lot = await prisma.lot.findUnique({
    where: { id },
    include: {
      material: { include: { features: { orderBy: { sortOrder: "asc" } } } },
      supplier: true,
      certificates: { orderBy: { id: "asc" } },
      analyses: {
        orderBy: { performedAt: "desc" },
        include: { results: { orderBy: { sortOrder: "asc" } } },
      },
      inspections: {
        orderBy: { inspectedAt: "desc" },
        include: { checks: true },
      },
      parts: { orderBy: { serialNumber: "asc" } },
    },
  });
  if (!lot) return null;
  return {
    ...lot,
    missingCerts: missingCertificates(lot.material.requiredCerts, lot.certificates),
  };
}

export async function getParts(filter?: { stage?: Stage; status?: string }) {
  await requireUser();

  const parts = await prisma.part.findMany({
    where: {
      ...(filter?.stage ? { currentStage: filter.stage } : {}),
      ...(filter?.status ? { status: filter.status } : {}),
    },
    include: {
      material: true,
      lot: { select: { lotNumber: true } },
      inspections: {
        orderBy: { inspectedAt: "desc" },
        take: 1,
        select: { stage: true, status: true, inspectedAt: true, inspector: true },
      },
    },
    orderBy: [{ status: "asc" }, { serialNumber: "asc" }],
  });
  return parts.map((p) => ({ ...p, progress: travellerProgress(p) }));
}

export async function getPart(id: number) {
  await requireUser();

  const part = await prisma.part.findUnique({
    where: { id },
    include: {
      material: { include: { features: { orderBy: { sortOrder: "asc" } } } },
      lot: { include: { supplier: true } },
      events: { orderBy: { at: "desc" } },
      inspections: {
        orderBy: { inspectedAt: "desc" },
        include: {
          checks: true,
          measurements: { orderBy: { sortOrder: "asc" } },
        },
      },
    },
  });
  if (!part) return null;
  return { ...part, progress: travellerProgress(part) };
}

/** Parts standing in each part-stage queue, waiting to be inspected. */
export async function getQueues() {
  await requireUser();

  const parts = await prisma.part.findMany({
    where: { status: { in: ["IN_PROCESS", "REWORK", "HOLD"] } },
    include: { material: true, lot: { select: { lotNumber: true } } },
    orderBy: { serialNumber: "asc" },
  });
  return PART_STAGES.map((stage) => ({
    stage,
    def: STAGE_DEFS.find((d) => d.stage === stage)!,
    parts: parts.filter((p) => p.currentStage === stage),
  }));
}

export async function getMaterials() {
  await requireUser();

  return prisma.material.findMany({
    include: {
      features: { orderBy: { sortOrder: "asc" } },
      _count: { select: { lots: true, parts: true } },
    },
    orderBy: { partNumber: "asc" },
  });
}

export async function getMaterial(id: number) {
  await requireUser();

  return prisma.material.findUnique({
    where: { id },
    include: { features: { orderBy: [{ stage: "asc" }, { sortOrder: "asc" }] } },
  });
}

export async function getSuppliers() {
  await requireUser();

  return prisma.supplier.findMany({ orderBy: { name: "asc" } });
}

/** Rejection / rework analysis used by the reports page. */
export async function getQualityReport() {
  await requireUser();

  const inspections = await prisma.inspection.findMany({
    include: {
      checks: true,
      measurements: true,
      part: { include: { material: true } },
      lot: { include: { material: true } },
    },
    orderBy: { inspectedAt: "desc" },
  });

  const byStage = STAGE_DEFS.map((def) => {
    const rows = inspections.filter((i) => i.stage === def.stage);
    const closed = rows.filter((i) => i.status !== "PENDING");
    const passed = rows.filter(
      (i) => i.status === "ACCEPTED" || i.status === "RELEASED"
    ).length;
    return {
      def,
      total: rows.length,
      passed,
      rework: rows.filter((i) => i.status === "REWORK").length,
      rejected: rows.filter((i) => i.status === "REJECTED").length,
      investigation: rows.filter((i) => i.status === "FURTHER_INVESTIGATION").length,
      pending: rows.filter((i) => i.status === "PENDING").length,
      passRate: closed.length > 0 ? passed / closed.length : null,
    };
  });

  // Which checklist lines actually fail, most-frequent first — the whole point
  // of keeping every answer rather than a single verdict.
  const failCounts = new Map<string, { stage: string; key: string; count: number }>();
  for (const insp of inspections) {
    for (const c of insp.checks) {
      if (c.ok !== false) continue;
      const id = `${insp.stage}::${c.key}`;
      const row = failCounts.get(id) ?? { stage: insp.stage, key: c.key, count: 0 };
      row.count += 1;
      failCounts.set(id, row);
    }
  }
  const topFailures = [...failCounts.values()].sort((a, b) => b.count - a.count);

  const outOfTolerance = inspections
    .flatMap((i) =>
      i.measurements
        .filter((m) => measurementResult(m) === "FAIL")
        .map((m) => ({
          measurement: m,
          stage: i.stage,
          inspectedAt: i.inspectedAt,
          subject: i.part?.serialNumber ?? i.lot?.lotNumber ?? "—",
          partNumber: i.part?.material.partNumber ?? i.lot?.material.partNumber ?? "—",
        }))
    )
    .slice(0, 50);

  const released = await prisma.part.findMany({
    where: { status: "RELEASED" },
    include: { material: true, lot: { select: { lotNumber: true } } },
    orderBy: { updatedAt: "desc" },
  });

  return { byStage, topFailures, outOfTolerance, released, total: inspections.length };
}

/** Re-derive an analysis verdict from its readings (used after an edit). */
export async function recomputeAnalysisStatus(analysisId: number) {
  await requireUser();

  const analysis = await prisma.analysis.findUnique({
    where: { id: analysisId },
    include: { results: true },
  });
  if (!analysis) return;
  await prisma.analysis.update({
    where: { id: analysisId },
    data: { status: analysisStatus(analysis.results) },
  });
}

// ───────────────────────── administration ─────────────────────────

/** Accounts and the recent history of who changed whose access.
 *
 *  Gated harder than the rest of this file: an ordinary signed-in caller has
 *  no business reading the staff list, so this asks for `user.manage` rather
 *  than merely a session.
 */
export async function getUsers() {
  const auth = await requirePermission("user.manage");
  if (!auth.ok) throw new Error(auth.error);

  const [users, events] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ active: "desc" }, { displayName: "asc" }],
      include: {
        createdBy: { select: { displayName: true } },
        _count: { select: { inspections: true } },
      },
    }),
    prisma.userAuditEvent.findMany({
      orderBy: { at: "desc" },
      take: 50,
      include: {
        subject: { select: { displayName: true } },
        actorUser: { select: { displayName: true } },
      },
    }),
  ]);

  return { users, events };
}
