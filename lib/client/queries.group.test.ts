import { describe, expect, it } from "vitest";

import { groupByLine, type QueueRow } from "./queries";

const piece = (over: Partial<QueueRow>): QueueRow => ({
  id: "x",
  lineId: "l1",
  project: "MM260001",
  itemCode: "Core",
  itemName: "Core insert",
  serial: "MM260001-Core-001",
  pieceNo: 1,
  measuringType: "CMM",
  priority: "A",
  stage: "ROUGHING",
  state: "WAITING_QC",
  holdDepartment: null,
  round: 0,
  measuredTimes: 0,
  plannedAt: new Date("2026-09-12T08:00:00Z"),
  lastInspectedAt: null,
  qcMs: 0,
  ...over,
});

describe("standing the pieces of one line together", () => {
  it("puts five pieces of the same part under one heading", () => {
    // Five rows saying the same thing five times is what makes a queue
    // unreadable.
    const rows = [1, 2, 3, 4, 5].map((n) =>
      piece({ id: `p${n}`, pieceNo: n, serial: `MM260001-Core-00${n}` })
    );
    const groups = groupByLine(rows);

    expect(groups).toHaveLength(1);
    expect(groups[0].project).toBe("MM260001");
    expect(groups[0].pieces).toHaveLength(5);
  });

  it("keeps different lines apart, even in the same project", () => {
    const groups = groupByLine([
      piece({ id: "a", lineId: "l1", itemCode: "Core" }),
      piece({ id: "b", lineId: "l2", itemCode: "Cavity" }),
    ]);
    expect(groups.map((g) => g.itemCode)).toEqual(["Core", "Cavity"]);
  });

  it("orders the pieces inside a group by their number, not by arrival", () => {
    const groups = groupByLine([
      piece({ id: "c", pieceNo: 3 }),
      piece({ id: "a", pieceNo: 1 }),
      piece({ id: "b", pieceNo: 2 }),
    ]);
    expect(groups[0].pieces.map((p) => p.pieceNo)).toEqual([1, 2, 3]);
  });

  it("takes a group's wait from its worst piece", () => {
    // What makes a group urgent is the one that has been standing longest,
    // not the average of the five.
    const groups = groupByLine([
      piece({ id: "a", qcMs: 1000 }),
      piece({ id: "b", qcMs: 90_000 }),
      piece({ id: "c", qcMs: 5000 }),
    ]);
    expect(groups[0].longestWaitMs).toBe(90_000);
  });

  it("puts the highest priority first, then the longest wait", () => {
    const groups = groupByLine([
      piece({ id: "b", lineId: "l2", priority: "B" }),
      piece({ id: "a", lineId: "l1", priority: "A" }),
      piece({
        id: "c",
        lineId: "l3",
        priority: "A",
        plannedAt: new Date("2026-09-01T08:00:00Z"),
      }),
    ]);
    expect(groups.map((g) => g.lineId)).toEqual(["l3", "l1", "l2"]);
  });

  it("sorts a line with no priority last rather than first", () => {
    // An empty cell must not jump the queue.
    const groups = groupByLine([
      piece({ id: "a", lineId: "l1", priority: null }),
      piece({ id: "b", lineId: "l2", priority: "C" }),
    ]);
    expect(groups.map((g) => g.lineId)).toEqual(["l2", "l1"]);
  });
});
