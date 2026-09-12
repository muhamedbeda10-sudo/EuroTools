/** The guarantees Firestore does not give, tested against the emulator.
 *
 *  PostgreSQL enforced two things for this app that Firestore cannot: a unique
 *  index on the numbers that identify a lot, a part and a spec, and a foreign
 *  key that made it impossible to delete an inspector who had signed anything.
 *  Both of those moved into code, and code that replaces a database constraint
 *  is worth more scrutiny than the constraint ever needed — a unique index does
 *  not have race conditions.
 *
 *  These run against the Firestore emulator rather than a mock, because a mock
 *  of a transaction would be a mock of exactly the behaviour in question.
 *
 *      npm run emulators      # in another terminal
 *      npm run test:integration
 */

import { beforeAll, describe, expect, it } from "vitest";

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

// Imported lazily: the module reaches for the Admin SDK on load, and the check
// below should report a missing emulator rather than a credentials error.
type Model = typeof import("@/lib/server/model");
type Store = typeof import("@/lib/server/firestore");
let model: Model;
let store: Store;

beforeAll(async () => {
  if (!EMULATOR)
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set. Start the emulator with `npm run emulators` and run this with `npm run test:integration`."
    );
  process.env.GCLOUD_PROJECT ??= "eurotools-qc-test";
  process.env.FIREBASE_PROJECT_ID ??= "eurotools-qc-test";
  model = await import("@/lib/server/model");
  store = await import("@/lib/server/firestore");
});

/** A value nobody else in this run will claim. */
const freshValue = (label: string) => `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe("uniqueness, which used to be a unique index", () => {
  it("lets exactly one of two racing writers take a part number", async () => {
    const partNumber = freshValue("PN");
    const first = model.materials().doc();
    const second = model.materials().doc();

    // Fired together on purpose: sequential calls would pass even if the
    // reservation were a plain read-then-write with a gap in the middle.
    const results = await Promise.allSettled([
      store
        .db()
        .runTransaction((tx) => model.reserveUnique(tx, "material.partNumber", partNumber, first.path)),
      store
        .db()
        .runTransaction((tx) => model.reserveUnique(tx, "material.partNumber", partNumber, second.path)),
    ]);

    // A loser either gets `ok: false` or has its transaction aborted by
    // Firestore's contention check. Both are the constraint doing its job; what
    // must never happen is both of them winning.
    const winners = results.filter(
      (r) => r.status === "fulfilled" && r.value.ok === true
    ).length;
    expect(winners).toBe(1);
  });

  it("refuses a duplicate that differs only in case or surrounding space", async () => {
    const serial = freshValue("SN");
    const owner = model.parts().doc();
    const other = model.parts().doc();

    const first = await store
      .db()
      .runTransaction((tx) => model.reserveUnique(tx, "part.serialNumber", serial, owner.path));
    expect(first.ok).toBe(true);

    for (const variant of [serial.toUpperCase(), serial.toLowerCase(), `  ${serial}  `]) {
      const attempt = await store
        .db()
        .runTransaction((tx) => model.reserveUnique(tx, "part.serialNumber", variant, other.path));
      expect(attempt.ok).toBe(false);
    }
  });

  it("lets the same record re-claim its own value, so an edit that keeps the number works", async () => {
    const lotNumber = freshValue("LOT");
    const owner = model.lots().doc();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const claim = await store
        .db()
        .runTransaction((tx) => model.reserveUnique(tx, "lot.lotNumber", lotNumber, owner.path));
      expect(claim.ok).toBe(true);
    }
  });

  it("accepts the slashes and spaces that real part numbers contain", async () => {
    // A document id may not contain a slash, which is why the reservation key
    // is encoded rather than used raw. Shop-floor numbers contain them.
    for (const awkward of ["PN-1042/A", "PN 1042 A", "1.2379/D2", "PN#1042"]) {
      const value = `${awkward}-${Date.now()}`;
      const key = model.uniqueKey("material.partNumber", value);
      expect(key).not.toContain("/");
      expect(key.startsWith("__")).toBe(false);

      const owner = model.materials().doc();
      const claim = await store
        .db()
        .runTransaction((tx) => model.reserveUnique(tx, "material.partNumber", value, owner.path));
      expect(claim.ok).toBe(true);
    }
  });

  it("gives a value back when a record is renamed onto a different one", async () => {
    const original = freshValue("SUP");
    const renamed = freshValue("SUP");
    const owner = model.suppliers().doc();

    await store
      .db()
      .runTransaction((tx) => model.reserveUnique(tx, "supplier.name", original, owner.path));

    await store.db().runTransaction(async (tx) => {
      const claim = await model.reserveUnique(tx, "supplier.name", renamed, owner.path);
      expect(claim.ok).toBe(true);
      model.releaseUnique(tx, "supplier.name", original);
    });

    // The old name is free for somebody else now.
    const someoneElse = model.suppliers().doc();
    const reclaim = await store
      .db()
      .runTransaction((tx) => model.reserveUnique(tx, "supplier.name", original, someoneElse.path));
    expect(reclaim.ok).toBe(true);
  });
});

describe("counters, which the reports read instead of scanning", () => {
  it("commits a counter and the record it counts together, or neither", async () => {
    const { FieldValue } = await import("firebase-admin/firestore");
    const counter = model.stats().doc(freshValue("counter"));
    const record = model.inspections().doc();

    await counter.set({ counts: { total: 0 } });

    // The failure the transaction hits stands in for any mid-write error.
    await expect(
      store.db().runTransaction(async (tx) => {
        await tx.get(counter);
        tx.update(counter, { "counts.total": FieldValue.increment(1) });
        tx.create(record, { stage: "FINAL" });
        throw new Error("something went wrong after both writes were queued");
      })
    ).rejects.toThrow();

    const [counterAfter, recordAfter] = await Promise.all([counter.get(), record.get()]);
    expect(counterAfter.data()?.counts.total).toBe(0);
    expect(recordAfter.exists).toBe(false);
  });

  it("increments one line of the failure tally without disturbing the others", async () => {
    const { FieldValue } = await import("firebase-admin/firestore");
    const tally = model.stats().doc(freshValue("failures"));
    const line = "FINAL::cmm_report_reviewed";
    const other = "FINAL::surface_finish_ok";

    await tally.set({ counts: { [other]: 7 } });
    for (let hit = 0; hit < 3; hit += 1)
      await tally.set({ counts: { [line]: FieldValue.increment(1) } }, { merge: true });

    const counts = (await tally.get()).data()?.counts as Record<string, number>;
    expect(counts[line]).toBe(3);
    expect(counts[other]).toBe(7);
  });
});

describe("the audit trail, which used to be held by a foreign key", () => {
  /** Firestore will happily delete a user out from under the inspections they
   *  signed. Nothing in the application offers to: the admin screen deactivates
   *  rather than deletes, and `firestore.rules` denies every client write. This
   *  pins the first half of that — the actions module exposes no way to remove
   *  an account — so a future "tidy up old users" feature has to break this
   *  test before it can break the trail. */
  it("exposes no action that deletes an account", async () => {
    const actions = await import("@/lib/client/actions");
    const names = Object.keys(actions);

    expect(names).toContain("grantAccess");
    expect(names).toContain("setUserActive");

    // Deleting a *user* is what must not exist. `deleteFeature` removes a
    // measured dimension from a spec, which nothing has signed.
    const accountDeleters = names.filter((n) =>
      /^(delete|remove|purge|destroy)(User|Account|Inspector)/i.test(n)
    );
    expect(accountDeleters).toEqual([]);
  });

  it("denies every client read and write in the security rules", async () => {
    const { readFile } = await import("node:fs/promises");
    const rules = await readFile("firestore.rules", "utf8");

    // All access is server-side through the Admin SDK, which bypasses rules.
    // A rule that ever allowed a client would be a way around the permission
    // checks in `lib/server/`, so the denial is worth pinning.
    expect(rules).toMatch(/allow read,\s*write:\s*if false/);
    expect(rules).not.toMatch(/if true/);
  });
});
