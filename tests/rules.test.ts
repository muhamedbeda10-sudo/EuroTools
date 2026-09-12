/** The security rules, exercised as an attacker would.
 *
 *  The app is static files talking to Firestore from the browser, so these
 *  rules are the entire boundary. There is no server left to catch anything
 *  they let through, which makes them the most security-critical file in the
 *  repository and worth testing from the outside rather than reading.
 *
 *  Every case below is written as "can this account do this thing", using the
 *  real rules against the emulator.
 *
 *      npm run emulators          # in another terminal
 *      npm run test:rules
 */

import { readFileSync } from "node:fs";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

let env: RulesTestEnvironment;

/** The accounts under test, one per role plus the awkward cases. */
const ACCOUNTS = {
  admin: { uid: "u-admin", role: "ADMIN", active: true },
  manager: { uid: "u-manager", role: "QUALITY_MANAGER", active: true },
  supervisor: { uid: "u-supervisor", role: "SUPERVISOR", active: true },
  inspector: { uid: "u-inspector", role: "INSPECTOR", active: true },
  viewer: { uid: "u-viewer", role: "VIEWER", active: true },
  /** Deactivated: the account an employee who left still technically holds. */
  retired: { uid: "u-retired", role: "INSPECTOR", active: false },
  /** Authenticated with Firebase but never provisioned here. */
  stranger: { uid: "u-stranger", role: null, active: null },
} as const;

type AccountName = keyof typeof ACCOUNTS;

const as = (who: AccountName) => env.authenticatedContext(ACCOUNTS[who].uid).firestore();
const anonymous = () => env.unauthenticatedContext().firestore();

/** A complete inspection, so a refusal is never just a missing field. */
function inspection(overrides: Record<string, unknown> = {}) {
  return {
    stage: "POST_ROUGHING",
    partId: "p1",
    lotId: null,
    inspectorUid: ACCOUNTS.inspector.uid,
    inspector: "م. هالة فؤاد",
    inspectedAt: new Date(),
    status: "ACCEPTED",
    notes: null,
    hardnessValue: null,
    hardnessUnit: null,
    hardnessMin: null,
    hardnessMax: null,
    surfaceFinishRa: null,
    cmmRequired: false,
    cmmReportRef: null,
    cmmReviewed: false,
    checks: [{ key: "dimensions_within_tolerance", ok: true, note: null }],
    measurements: [],
    subject: "LOT-2026-001-0001",
    partNumber: "PN-1042-A",
    hasFailedMeasurement: false,
    ...overrides,
  };
}

beforeAll(async () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host)
    throw new Error(
      "FIRESTORE_EMULATOR_HOST is not set. Start the emulator with `npm run emulators` and run this with `npm run test:rules`."
    );
  const [hostname, port] = host.split(":");

  env = await initializeTestEnvironment({
    projectId: "eurotools-rules-test",
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: hostname,
      port: Number(port),
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();

  // The accounts themselves are seeded with the rules switched off; in the
  // running system an administrator creates them, which is tested separately.
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    for (const account of Object.values(ACCOUNTS)) {
      if (account.role == null) continue; // the stranger has no document
      await db.doc(`users/${account.uid}`).set({
        email: `${account.uid}@example.invalid`,
        displayName: account.uid,
        role: account.role,
        employeeNo: null,
        active: account.active,
        signedInspections: 0,
      });
    }
    await db.doc("parts/p1").set({
      serialNumber: "LOT-2026-001-0001",
      materialId: "m1",
      lotId: "l1",
      currentStage: "POST_ROUGHING",
      status: "IN_PROCESS",
    });
    await db.doc("materials/m1").set({ partNumber: "PN-1042-A", features: [] });
    await db.doc("lots/l1").set({ lotNumber: "LOT-2026-001", materialId: "m1" });
  });
});

// ───────────────────────── getting in at all ─────────────────────────

describe("who gets through the door", () => {
  it("lets any active account read the quality data", async () => {
    for (const who of ["admin", "manager", "supervisor", "inspector", "viewer"] as const)
      await assertSucceeds(as(who).doc("parts/p1").get());
  });

  it("shuts out a caller who is not signed in", async () => {
    await assertFails(anonymous().doc("parts/p1").get());
    await assertFails(anonymous().collection("inspections").add(inspection()));
  });

  it("shuts out a Firebase account this plant never provisioned", async () => {
    // Anyone can obtain a Firebase identity. Only a user document makes it an
    // account here.
    await assertFails(as("stranger").doc("parts/p1").get());
    await assertFails(as("stranger").collection("inspections").add(inspection()));
  });

  it("shuts out a deactivated account immediately", async () => {
    // This is how somebody who left the company stops being able to sign.
    await assertFails(as("retired").doc("parts/p1").get());
    await assertFails(
      as("retired")
        .collection("inspections")
        .add(inspection({ inspectorUid: ACCOUNTS.retired.uid }))
    );
  });
});

// ───────────────────────── the signature ─────────────────────────

describe("a signature belongs to the account that made it", () => {
  it("lets an inspector file a sheet under their own uid", async () => {
    await assertSucceeds(as("inspector").collection("inspections").add(inspection()));
  });

  it("refuses a sheet signed as somebody else", async () => {
    // The forgery the server prevented by reading identity from the session.
    await assertFails(
      as("inspector")
        .collection("inspections")
        .add(inspection({ inspectorUid: ACCOUNTS.manager.uid }))
    );
  });

  it("refuses a sheet signed as nobody", async () => {
    await assertFails(
      as("inspector").collection("inspections").add(inspection({ inspectorUid: null }))
    );
  });

  it("holds even for an administrator", async () => {
    await assertFails(
      as("admin")
        .collection("inspections")
        .add(inspection({ inspectorUid: ACCOUNTS.inspector.uid }))
    );
  });

  it("binds a traveller event to its author too", async () => {
    await assertSucceeds(
      as("inspector").collection("parts/p1/events").add({
        at: new Date(),
        kind: "INSPECTION",
        stage: "POST_ROUGHING",
        fromValue: null,
        toValue: "HEAT_TREATMENT/IN_PROCESS",
        note: null,
        actorUid: ACCOUNTS.inspector.uid,
        actor: "م. هالة فؤاد",
      })
    );
    await assertFails(
      as("inspector").collection("parts/p1/events").add({
        at: new Date(),
        kind: "INSPECTION",
        actorUid: ACCOUNTS.manager.uid,
        actor: "م. منى رشاد",
      })
    );
  });
});

// ───────────────────────── releasing product ─────────────────────────

describe("releasing product", () => {
  it("lets a quality manager and an administrator sign a release", async () => {
    for (const who of ["manager", "admin"] as const)
      await assertSucceeds(
        as(who)
          .collection("inspections")
          .add(inspection({ status: "RELEASED", inspectorUid: ACCOUNTS[who].uid }))
      );
  });

  it("refuses a release from an inspector or a supervisor", async () => {
    for (const who of ["inspector", "supervisor"] as const)
      await assertFails(
        as(who)
          .collection("inspections")
          .add(inspection({ status: "RELEASED", inspectorUid: ACCOUNTS[who].uid }))
      );
  });

  it("refuses moving the part itself to RELEASED without the authority", async () => {
    // The other way to release something: skip the inspection and write the
    // part's status directly.
    await assertFails(as("inspector").doc("parts/p1").update({ status: "RELEASED" }));
    await assertFails(as("supervisor").doc("parts/p1").update({ status: "RELEASED" }));
    await assertSucceeds(as("manager").doc("parts/p1").update({ status: "RELEASED" }));
  });

  it("still lets an inspector move a part through the ordinary states", async () => {
    await assertSucceeds(
      as("inspector").doc("parts/p1").update({ currentStage: "HEAT_TREATMENT" })
    );
  });
});

// ───────────────────────── the record is a record ─────────────────────────

describe("signed records cannot be rewritten", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc("inspections/i1").set(inspection());
      await context.firestore().doc("parts/p1/events/e1").set({
        at: new Date(),
        kind: "CREATED",
        actorUid: ACCOUNTS.inspector.uid,
        actor: "م. هالة فؤاد",
      });
    });
  });

  it("refuses to edit an inspection, whoever asks", async () => {
    for (const who of ["inspector", "supervisor", "manager", "admin"] as const)
      await assertFails(as(who).doc("inspections/i1").update({ status: "ACCEPTED" }));
  });

  it("refuses to delete an inspection, whoever asks", async () => {
    for (const who of ["inspector", "supervisor", "manager", "admin"] as const)
      await assertFails(as(who).doc("inspections/i1").delete());
  });

  it("refuses to edit or delete a traveller event", async () => {
    await assertFails(as("admin").doc("parts/p1/events/e1").update({ note: "changed" }));
    await assertFails(as("admin").doc("parts/p1/events/e1").delete());
  });

  it("refuses to delete a part, a lot or a material", async () => {
    await assertFails(as("admin").doc("parts/p1").delete());
    await assertFails(as("admin").doc("lots/l1").delete());
    await assertFails(as("admin").doc("materials/m1").delete());
  });
});

// ───────────────────────── uniqueness ─────────────────────────

describe("uniqueness reservations", () => {
  it("lets a reservation be created once and never overwritten", async () => {
    const key = "u_test_reservation";
    await assertSucceeds(
      as("inspector").doc(`uniques/${key}`).set({
        scope: "lot.lotNumber",
        value: "LOT-2026-099",
        ownerPath: "lots/first",
        at: new Date(),
      })
    );

    // The second writer is refused, which is the entire guarantee.
    await assertFails(
      as("supervisor").doc(`uniques/${key}`).update({ ownerPath: "lots/second" })
    );
  });

  it("lets only a spec owner hand a value back on a rename", async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc("uniques/u_release_me").set({
        scope: "material.partNumber",
        value: "PN-OLD",
        ownerPath: "materials/m1",
        at: new Date(),
      });
    });

    await assertFails(as("inspector").doc("uniques/u_release_me").delete());
    await assertSucceeds(as("manager").doc("uniques/u_release_me").delete());
  });
});

// ───────────────────────── the spec ─────────────────────────

describe("the drawing spec is quality authority", () => {
  it("refuses a tolerance edit from the shop floor", async () => {
    for (const who of ["inspector", "supervisor", "viewer"] as const)
      await assertFails(as(who).doc("materials/m1").update({ hardnessMin: 10 }));
  });

  it("lets a quality manager edit it", async () => {
    await assertSucceeds(as("manager").doc("materials/m1").update({ hardnessMin: 58 }));
  });

  it("lets only a supervisor and above raise parts", async () => {
    const part = {
      serialNumber: "NEW-0001",
      materialId: "m1",
      lotId: "l1",
      batchQty: 1,
      currentStage: "POST_ROUGHING",
      status: "IN_PROCESS",
    };
    await assertFails(as("inspector").collection("parts").add(part));
    await assertSucceeds(as("supervisor").collection("parts").add(part));
  });
});

// ───────────────────────── accounts ─────────────────────────

describe("account administration", () => {
  it("lets nobody but an administrator change a role", async () => {
    for (const who of ["inspector", "supervisor", "manager", "viewer"] as const)
      await assertFails(as(who).doc(`users/${ACCOUNTS.inspector.uid}`).update({ role: "ADMIN" }));

    await assertSucceeds(
      as("admin").doc(`users/${ACCOUNTS.inspector.uid}`).update({ role: "SUPERVISOR" })
    );
  });

  it("refuses an inspector promoting themselves", async () => {
    // The first thing anyone would try with a browser console open.
    await assertFails(
      as("inspector").doc(`users/${ACCOUNTS.inspector.uid}`).update({ role: "ADMIN" })
    );
  });

  it("refuses an administrator editing their own account", async () => {
    await assertFails(as("admin").doc(`users/${ACCOUNTS.admin.uid}`).update({ role: "VIEWER" }));
    await assertFails(as("admin").doc(`users/${ACCOUNTS.admin.uid}`).update({ active: false }));
  });

  it("refuses deleting an account, so signed records keep their author", async () => {
    await assertFails(as("admin").doc(`users/${ACCOUNTS.inspector.uid}`).delete());
  });

  it("keeps the account-change log readable by administrators only, and append-only", async () => {
    const event = {
      at: new Date(),
      kind: "ROLE_CHANGED",
      subjectUid: ACCOUNTS.inspector.uid,
      subjectName: "inspector",
      actorUid: ACCOUNTS.admin.uid,
      actorName: "admin",
      fromValue: "INSPECTOR",
      toValue: "SUPERVISOR",
    };
    await assertFails(as("manager").collection("userAuditEvents").add(event));
    await assertSucceeds(as("admin").collection("userAuditEvents").add(event));

    await env.withSecurityRulesDisabled(async (context) => {
      await context.firestore().doc("userAuditEvents/a1").set(event);
    });
    await assertFails(as("admin").doc("userAuditEvents/a1").update({ toValue: "ADMIN" }));
    await assertFails(as("admin").doc("userAuditEvents/a1").delete());
  });
});

// ───────────────────────── the viewer ─────────────────────────

describe("a viewer reads and nothing else", () => {
  it("reads every collection", async () => {
    await assertSucceeds(as("viewer").doc("parts/p1").get());
    await assertSucceeds(as("viewer").doc("lots/l1").get());
    await assertSucceeds(as("viewer").doc("materials/m1").get());
  });

  it("writes nothing at all", async () => {
    await assertFails(
      as("viewer").collection("inspections").add(inspection({ inspectorUid: ACCOUNTS.viewer.uid }))
    );
    await assertFails(as("viewer").doc("parts/p1").update({ status: "REWORK" }));
    await assertFails(as("viewer").doc("lots/l1").update({ status: "ACCEPTED" }));
    await assertFails(as("viewer").collection("suppliers").add({ name: "x" }));
  });
});

// ─────────────────── the gap, stated as a test ───────────────────

describe("what the rules cannot check", () => {
  /** Rules cannot iterate the measurements array or reproduce the tolerance
   *  arithmetic in `lib/domain/inspection.ts`, so a verdict that contradicts
   *  its own evidence is accepted here. This test exists so the gap is
   *  documented and deliberate rather than discovered: `/reports` re-derives
   *  every verdict and lists the disagreements. If a future rules change ever
   *  does manage to catch this, the test failing is the signal to celebrate
   *  and delete it. */
  it("accepts a verdict that disagrees with its own measurements", async () => {
    const contradiction = inspection({
      status: "ACCEPTED",
      hasFailedMeasurement: true,
      measurements: [
        {
          featureId: "f1",
          name: "القطر الخارجي النهائي",
          kind: "DIMENSION",
          nominal: 50,
          tolMinus: 0.005,
          tolPlus: 0.005,
          gdtLimit: null,
          actual: 51.4,
          unit: "mm",
          critical: true,
          result: "FAIL",
          sortOrder: 0,
        },
      ],
    });

    await assertSucceeds(as("inspector").collection("inspections").add(contradiction));

    // The compensating control is that the evidence is stored alongside the
    // claim, so the contradiction is visible to anyone who looks.
    const stored = await as("inspector").collection("inspections").get();
    const filed = stored.docs.map((d) => d.data()).find((d) => d.status === "ACCEPTED");
    expect(filed?.measurements[0].result).toBe("FAIL");
  });
});
