/** The security rules, exercised as an attacker would.
 *
 *  The application is static files talking to Firestore from the browser, so
 *  these rules are the entire boundary. There is no server left to catch
 *  anything they let through, which makes this the most security-critical file
 *  in the repository and worth testing from the outside rather than reading.
 *
 *  Every case is written as "can this account do this thing", against the real
 *  rules on the emulator.
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

const ACCOUNTS = {
  admin: { uid: "u-admin", role: "ADMIN", active: true },
  manager: { uid: "u-manager", role: "QUALITY_MANAGER", active: true },
  supervisor: { uid: "u-supervisor", role: "SUPERVISOR", active: true },
  inspector: { uid: "u-inspector", role: "INSPECTOR", active: true },
  viewer: { uid: "u-viewer", role: "VIEWER", active: true },
  /** Deactivated: the account somebody who left still technically holds. */
  retired: { uid: "u-retired", role: "INSPECTOR", active: false },
  /** Authenticated with Firebase but never provisioned here. */
  stranger: { uid: "u-stranger", role: null, active: null },
  /** An inspector who is also the only one keeping the drawings up to date. */
  keeper: { uid: "u-keeper", role: "INSPECTOR", active: true, granted: ["config.manage"] },
  /** A supervisor who must not grant concessions. */
  restricted: { uid: "u-restricted", role: "SUPERVISOR", active: true, denied: ["verdict.bypass"] },
} as const;

type AccountName = keyof typeof ACCOUNTS;

const as = (who: AccountName) => env.authenticatedContext(ACCOUNTS[who].uid).firestore();
const anonymous = () => env.unauthenticatedContext().firestore();

const RECORDERS = ["inspector", "supervisor", "manager", "admin"] as const;

function sheet(overrides: Record<string, unknown> = {}) {
  return {
    pieceId: "p1",
    lineId: "l1",
    project: "MM260001",
    itemCode: "Core",
    itemName: "Core insert",
    serial: "MM260001-Core-001",
    stage: "ROUGHING",
    round: 1,
    readings: [
      { key: "od", name: "OD", unit: "mm", nominal: 50, tolMinus: 0.02, tolPlus: 0.02, actual: 50, result: "PASS", adHoc: false },
    ],
    defects: [],
    suggested: "ACCEPTED",
    verdict: "ACCEPTED",
    holdDepartment: null,
    bypassReason: null,
    inspectorUid: ACCOUNTS.inspector.uid,
    inspector: "Hala Fouad",
    inspectedAt: new Date(),
    photoCount: 0,
    hasFailedReading: false,
    ...overrides,
  };
}

function piece(overrides: Record<string, unknown> = {}) {
  return {
    lineId: "l1",
    project: "MM260001",
    itemCode: "Core",
    itemName: "Core insert",
    measuringType: "CMM",
    priority: "A",
    plannedAt: new Date(),
    pieceNo: 1,
    serial: "MM260001-Core-001",
    stage: "ROUGHING",
    state: "WAITING_QC",
    holdDepartment: null,
    round: 0,
    measuredTimes: 0,
    lastVerdict: null,
    lastInspectedAt: null,
    qcSince: new Date(),
    qcSettledMs: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function line(overrides: Record<string, unknown> = {}) {
  return {
    project: "MM260001",
    mplpr: "MP",
    itemCode: "Core",
    itemName: "Core insert",
    qty: 5,
    measuringType: "CMM",
    priority: "A",
    plannedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    createdByUid: ACCOUNTS.supervisor.uid,
    createdByName: "Tarek Selim",
    counts: { total: 5, withQc: 5, inRework: 0, closed: 0, measurements: 0 },
    ...overrides,
  };
}

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "eurotools-qc-test",
    firestore: {
      rules: readFileSync("firestore.rules", "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => env?.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  // The accounts themselves are written with the rules off: provisioning is
  // what the rules read, not what they guard.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const account of Object.values(ACCOUNTS)) {
      if (account.role == null) continue;
      await db.doc(`users/${account.uid}`).set({
        email: `${account.uid}@example.invalid`,
        displayName: account.uid,
        role: account.role,
        active: account.active,
        signedInspections: 0,
        granted: "granted" in account ? account.granted : [],
        denied: "denied" in account ? account.denied : [],
      });
    }
    await db.doc("planningLines/l1").set(line());
    await db.doc("pieces/p1").set(piece());
    await db.doc("pieces/measured").set(piece({ measuredTimes: 2, round: 2 }));
    await db.doc("config/departments").set({ list: ["Machining", "Grinding"] });
  });
});

describe("who is let in at all", () => {
  it("refuses somebody who is not signed in", async () => {
    await assertFails(anonymous().doc("pieces/p1").get());
    await assertFails(anonymous().doc("planningLines/l1").get());
  });

  it("refuses a Firebase account nobody provisioned here", async () => {
    // Anyone can obtain a Firebase identity. Having one is not having access.
    await assertFails(as("stranger").doc("pieces/p1").get());
  });

  it("refuses an account that was deactivated", async () => {
    // On the next request, not when a token expires — the role is re-read
    // every single time, which is the point of checking it here.
    await assertFails(as("retired").doc("pieces/p1").get());
    await assertFails(as("retired").collection("inspections").add(sheet()));
  });

  it("lets every active account read", async () => {
    for (const who of ["viewer", ...RECORDERS] as const)
      await assertSucceeds(as(who).doc("pieces/p1").get());
  });
});

describe("recording a sheet", () => {
  it("lets an inspector sign one in their own name", async () => {
    await assertSucceeds(as("inspector").collection("inspections").add(sheet()));
  });

  it("refuses a sheet signed in somebody else's name", async () => {
    // The guarantee that mattered most on a server, and the one that survives
    // intact without one.
    await assertFails(
      as("inspector").collection("inspections").add(sheet({ inspectorUid: ACCOUNTS.supervisor.uid }))
    );
  });

  it("refuses a viewer entirely", async () => {
    await assertFails(as("viewer").collection("inspections").add(sheet({ inspectorUid: ACCOUNTS.viewer.uid })));
  });

  it("never lets a signed sheet be changed or removed", async () => {
    await env.withSecurityRulesDisabled(async (ctx) =>
      ctx.firestore().doc("inspections/i1").set(sheet())
    );
    // Not by the inspector who signed it, not by an administrator. A trail
    // that can be rewritten afterwards is not a trail.
    for (const who of RECORDERS) {
      await assertFails(as(who).doc("inspections/i1").update({ verdict: "ACCEPTED" }));
      await assertFails(as(who).doc("inspections/i1").delete());
    }
  });
});

describe("letting a piece through that the measurements hold", () => {
  const concession = (over: Record<string, unknown> = {}) =>
    sheet({
      suggested: "HOLD",
      verdict: "ACCEPTED_BYPASS",
      bypassReason: "Customer accepts on deviation, ref DR-114",
      ...over,
    });

  it("is refused to an inspector", async () => {
    await assertFails(as("inspector").collection("inspections").add(concession()));
  });

  it("is allowed to a supervisor and above", async () => {
    for (const who of ["supervisor", "manager", "admin"] as const)
      await assertSucceeds(
        as(who)
          .collection("inspections")
          .add(concession({ inspectorUid: ACCOUNTS[who].uid }))
      );
  });

  it("is refused without a reason written on it", async () => {
    for (const nothing of [null, ""])
      await assertFails(
        as("supervisor")
          .collection("inspections")
          .add(concession({ inspectorUid: ACCOUNTS.supervisor.uid, bypassReason: nothing }))
      );
  });

  it("is refused even when it is dressed as a plain acceptance", async () => {
    // The verdict says ACCEPTED and the evidence says HOLD. Calling it
    // something else does not make it something else.
    await assertFails(
      as("inspector").collection("inspections").add(sheet({ suggested: "HOLD", verdict: "ACCEPTED" }))
    );
  });

  it("never applies to holding a piece", async () => {
    // Stopping product needs no authority. An inspector who saw something the
    // sheet has no line for must be able to act on it.
    await assertSucceeds(
      as("inspector")
        .collection("inspections")
        .add(sheet({ suggested: "ACCEPTED", verdict: "HOLD", holdDepartment: "Machining" }))
    );
  });
});

describe("moving a piece", () => {
  it("lets an inspector change where it is", async () => {
    await assertSucceeds(
      as("inspector").doc("pieces/p1").update({
        stage: "FINISH",
        state: "WAITING_QC",
        holdDepartment: null,
        round: 0,
        measuredTimes: 1,
        lastVerdict: "ACCEPTED",
        lastInspectedAt: new Date(),
        qcSince: new Date(),
        qcSettledMs: 5000,
        updatedAt: new Date(),
      })
    );
  });

  it("refuses to let them change what it is", async () => {
    // The fields that say where a piece is may move. The ones that say which
    // piece it is may not: a serial or a project rewritten mid-route would
    // detach every sheet already signed against it.
    for (const forbidden of [
      { serial: "somebody-elses" },
      { project: "MM260099" },
      { itemCode: "Cavity" },
      { lineId: "l2" },
      { pieceNo: 9 },
    ])
      await assertFails(as("inspector").doc("pieces/p1").update(forbidden));
  });

  it("refuses a viewer", async () => {
    await assertFails(as("viewer").doc("pieces/p1").update({ state: "CLOSED" }));
  });
});

describe("cancelling a planning line", () => {
  it("lets a supervisor remove a piece nobody has measured", async () => {
    await assertSucceeds(as("supervisor").doc("pieces/p1").delete());
  });

  it("refuses to remove one that has been measured", async () => {
    // The same rule the application checks, enforced where it cannot be edited
    // out of the bundle: deleting it would leave signed sheets describing a
    // piece that no longer exists.
    await assertFails(as("supervisor").doc("pieces/measured").delete());
    await assertFails(as("admin").doc("pieces/measured").delete());
  });

  it("refuses an inspector either way", async () => {
    await assertFails(as("inspector").doc("pieces/p1").delete());
  });
});

describe("planning lines", () => {
  it("lets an inspector move the counters and nothing else", async () => {
    // A piece changing hands changes the counts on its line. Nothing about
    // what planning asked for changes with it.
    await assertSucceeds(
      as("inspector").doc("planningLines/l1").update({ "counts.withQc": 4, "counts.closed": 1 })
    );
    await assertFails(as("inspector").doc("planningLines/l1").update({ qty: 50 }));
    await assertFails(as("inspector").doc("planningLines/l1").update({ project: "MM260099" }));
  });

  it("keeps creating one to a supervisor and above", async () => {
    await assertSucceeds(as("supervisor").collection("planningLines").add(line()));
    await assertFails(as("inspector").collection("planningLines").add(line()));
    await assertFails(as("viewer").collection("planningLines").add(line()));
  });
});

describe("what a piece has to be", () => {
  const item = {
    itemCode: "Core",
    itemName: "Core insert",
    dimensions: { ROUGHING: [], FINISH: [] },
    defects: [],
    updatedAt: new Date(),
    updatedByUid: ACCOUNTS.manager.uid,
    updatedByName: "Mona Rashad",
  };

  it("is a quality manager's to change, and nobody below", async () => {
    // An inspector who can widen a tolerance can pass anything.
    await assertSucceeds(as("manager").doc("itemConfigs/i_core").set(item));
    await assertFails(as("supervisor").doc("itemConfigs/i_core").set(item));
    await assertFails(as("inspector").doc("itemConfigs/i_core").set(item));
  });

  it("is readable by everybody, because the sheet is drawn from it", async () => {
    for (const who of ["viewer", ...RECORDERS] as const)
      await assertSucceeds(as(who).doc("config/departments").get());
  });

  it("keeps the department list to a quality manager", async () => {
    // Free-text departments would turn one place into three columns on the
    // dashboard within a month.
    await assertFails(as("supervisor").doc("config/departments").set({ list: ["Anything"] }));
    await assertSucceeds(as("manager").doc("config/departments").set({ list: ["Machining"] }));
  });
});

describe("closing out a rework", () => {
  beforeEach(async () => {
    await env.withSecurityRulesDisabled(async (ctx) =>
      ctx.firestore().doc("reworks/r1").set({
        pieceId: "p1",
        lineId: "l1",
        project: "MM260001",
        itemCode: "Core",
        serial: "MM260001-Core-001",
        stage: "ROUGHING",
        round: 1,
        inspectionId: "i1",
        department: "Machining",
        heldAt: new Date(),
        heldByUid: ACCOUNTS.inspector.uid,
        heldByName: "Hala Fouad",
        completedAt: null,
        recordedByUid: null,
        recordedByName: null,
        note: null,
      })
    );
  });

  it("records who reported it, and refuses somebody else's name", async () => {
    // Quality enters this on the department's behalf, so whose word it is has
    // to be on the record.
    await assertSucceeds(
      as("inspector").doc("reworks/r1").update({
        completedAt: new Date(),
        recordedByUid: ACCOUNTS.inspector.uid,
        recordedByName: "Hala Fouad",
        note: "re-ground",
      })
    );
    await assertFails(
      as("inspector").doc("reworks/r1").update({
        completedAt: new Date(),
        recordedByUid: ACCOUNTS.manager.uid,
        recordedByName: "Mona Rashad",
        note: null,
      })
    );
  });

  it("refuses to let the hold itself be rewritten", async () => {
    await assertFails(as("manager").doc("reworks/r1").update({ department: "Somebody else" }));
    await assertFails(as("admin").doc("reworks/r1").delete());
  });
});

describe("account administration", () => {
  const account = { email: "new@example.invalid", displayName: "New", role: "INSPECTOR", active: true, signedInspections: 0 };

  it("is the administrator's alone", async () => {
    await assertSucceeds(as("admin").doc("users/u-new").set(account));
    for (const who of ["manager", "supervisor", "inspector", "viewer"] as const)
      await assertFails(as(who).doc("users/u-new2").set(account));
  });

  it("stops an administrator editing their own account", async () => {
    // The likeliest way to strand a plant outside its own quality system.
    await assertFails(as("admin").doc(`users/${ACCOUNTS.admin.uid}`).update({ role: "VIEWER" }));
  });

  it("never deletes an account", async () => {
    // Deleting one would orphan every sheet it signed.
    await assertFails(as("admin").doc(`users/${ACCOUNTS.inspector.uid}`).delete());
  });

  it("lets an inspector's own signature count go up, and nothing else", async () => {
    const mine = as("inspector").doc(`users/${ACCOUNTS.inspector.uid}`);
    await assertSucceeds(mine.update({ signedInspections: 1 }));
    await assertFails(mine.update({ role: "ADMIN" }));
    await assertFails(mine.update({ active: true, role: "ADMIN" }));
    await assertFails(
      as("inspector").doc(`users/${ACCOUNTS.viewer.uid}`).update({ signedInspections: 99 })
    );
  });
});

describe("a permission given to one person rather than a role", () => {
  const item = {
    itemCode: "Core",
    itemName: "Core insert",
    dimensions: { ROUGHING: [], FINISH: [] },
    defects: [],
    updatedAt: new Date(),
    updatedByUid: ACCOUNTS.keeper.uid,
    updatedByName: "keeper",
  };

  it("lets an inspector who was granted it change the drawings", async () => {
    // Forcing this person into a role that is wrong for them is how a
    // permission system ends up with five people sharing one login.
    await assertSucceeds(as("keeper").doc("itemConfigs/i_core").set(item));
    await assertFails(as("inspector").doc("itemConfigs/i_core").set(item));
  });

  it("gives them nothing else along with it", async () => {
    await assertFails(as("keeper").collection("planningLines").add(line()));
    await assertFails(
      as("keeper").doc("users/u-new").set({ email: "x@y.z", displayName: "X", role: "VIEWER", active: true })
    );
  });

  it("takes away what somebody was denied, whatever their role says", async () => {
    // The supervisor who may do everything a supervisor does except let
    // product through on a concession.
    await assertFails(
      as("restricted").collection("inspections").add(
        sheet({
          inspectorUid: ACCOUNTS.restricted.uid,
          suggested: "HOLD",
          verdict: "ACCEPTED_BYPASS",
          bypassReason: "signed off verbally",
        })
      )
    );
    // Everything else about the role still works.
    await assertSucceeds(as("restricted").collection("planningLines").add(line()));
    await assertSucceeds(
      as("restricted").collection("inspections").add(sheet({ inspectorUid: ACCOUNTS.restricted.uid }))
    );
  });

  it("is not something an account can give itself", async () => {
    // Nobody edits their own account, which is what stops a granted
    // permission from being a way to grant more.
    await assertFails(
      as("admin").doc(`users/${ACCOUNTS.admin.uid}`).update({ granted: ["user.manage"] })
    );
    await assertFails(
      as("keeper").doc(`users/${ACCOUNTS.keeper.uid}`).update({ granted: ["user.manage"] })
    );
  });
});

describe("a viewer reads and nothing else", () => {
  it("is refused every write there is", async () => {
    await assertFails(as("viewer").collection("planningLines").add(line()));
    await assertFails(as("viewer").doc("pieces/p1").update({ state: "CLOSED" }));
    await assertFails(as("viewer").collection("reworks").add({ pieceId: "p1" }));
    await assertFails(as("viewer").doc("config/departments").set({ list: [] }));
    await assertFails(as("viewer").doc("stats/verdicts").set({ counts: {} }));
  });
});

describe("what the rules cannot check", () => {
  it("accepts a verdict that disagrees with its own measurements", async () => {
    // Pinned deliberately. Rules cannot recompute a tolerance, so a doctored
    // bundle could store a sheet whose ACCEPTED does not follow from its own
    // readings — as long as it also claims the evidence agreed.
    //
    // What catches it is that the readings are stored beside the verdict: the
    // same pure function that suggested it runs over the record afterwards,
    // and a sheet where the two disagree was not written by this application.
    // This test exists so that gap is a known one rather than a surprise.
    await assertSucceeds(
      as("inspector").collection("inspections").add(
        sheet({
          readings: [
            { key: "od", name: "OD", unit: "mm", nominal: 50, tolMinus: 0.01, tolPlus: 0.01, actual: 61, result: "PASS", adHoc: false },
          ],
          suggested: "ACCEPTED",
          verdict: "ACCEPTED",
        })
      )
    );
  });

  it("denies everything it was not asked about", async () => {
    const rules = readFileSync("firestore.rules", "utf8");
    expect(rules).toMatch(/match \/\{document=\*\*\} \{\s*allow read, write: if false;/);
    expect(rules).not.toMatch(/if true/);
  });
});
