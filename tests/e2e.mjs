/** The whole route, driven in a real browser.
 *
 *  Everything happens in the browser now — the reads, the writes, the rules
 *  refusing them — so curl only ever sees an empty shell and a unit test only
 *  ever sees the pieces. Walking a piece from planning's sheet through a hold,
 *  a rework and an acceptance is the only way to know the parts fit together.
 *
 *      npm run emulators                 # in another terminal
 *      npm run create-admin
 *      npm run build
 *      npx firebase emulators:start --only hosting
 *      npm run test:e2e
 *
 *  The build step needs `.env.production` out of the way: `npm run deploy`
 *  writes that file pointed at the real project, which is right for a
 *  deployment and would have this run signing in against production.
 */

import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:5000";
const EMAIL = process.env.E2E_EMAIL ?? "qa.manager@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "StrongPass123";
const EXECUTABLE =
  process.env.E2E_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

/** A planning sheet, written to disk so the page opens a real file.
 *
 *  The project number is fresh every run. Re-importing a row that is already
 *  there is refused by design — that is what stops a sheet imported twice
 *  creating the pieces twice — so a fixed number would make this pass once and
 *  then quietly test nothing.
 */
const PROJECT = `MM26${String(Date.now()).slice(-6)}`;
const CORE = `${PROJECT}-Core-001`;
/** The carry-forward walk needs an item nobody has measured before, and the
 *  carry-forward is by item and stage across every project — so a fixed code
 *  would inherit the previous run's sheet and the test would stop testing
 *  anything. The item name stays the same; only the code is made unique. */
const CAVITY = `Cavity${PROJECT.slice(-5)}`;
const CAVITY_1 = `${PROJECT}-${CAVITY}-001`;
const CAVITY_2 = `${PROJECT}-${CAVITY}-002`;
const SHEET = join(tmpdir(), `qc-planning-${Date.now()}.csv`);
writeFileSync(
  SHEET,
  [
    "Project,MPLPR,Item,Name,Qty,Measuring type,Date,Priority,Duration,Description,Complete",
    `${PROJECT},MP,Core,Core insert,2,CMM,12/09/2026,A,,,`,
    `${PROJECT},MP,${CAVITY},Cavity block,2,Traditional,12/09/2026,B,,,`,
    `${PROJECT},MP,Guide,Guide bar,1,Traditional,12/09/2026,C,,,`,
  ].join("\n"),
  "utf8"
);

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const page = await browser.newPage();

const consoleErrors = [];
const missing = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("response", (r) => r.status() === 404 && missing.push(r.url()));

/** Firestore holds a connection open, so `networkidle` never settles; every
 *  wait is on something the page actually rendered. */
const go = async (path, selector) => {
  await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
  if (selector) await page.waitForSelector(selector, { timeout: 30000 });
};

const save = async (label) => {
  await page.click(`button:has-text("${label}")`);
  await page.waitForTimeout(1800);
};

/** The queue stands the pieces of a line under a heading that starts closed,
 *  so a serial is two clicks away: open its line, then the piece.
 *
 *  Scoped to one card, because the same line appears under both "Waiting on
 *  quality" and "In rework" and an unscoped click opens whichever comes first
 *  — which is how this silently opened the wrong one. */
const openLine = async (itemCode, card = "Waiting on quality") => {
  await page.click(
    `section.card:has(h2:text-is("${card}")) button:has-text("${PROJECT}"):has-text("${itemCode}")`
  );
  await page.waitForTimeout(600);
};

try {
  // ── signing in ──
  await go("/", null);
  await page.waitForURL(/\/login/, { timeout: 20000 });
  check("signed out is sent to the login page", page.url().includes("/login"));

  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 25000 });
  check("signing in lands on the dashboard", !page.url().includes("login"));

  // ── adding somebody, without leaving the application ──
  await go("/admin/users/", 'input[name="displayName"]');
  await page.fill('input[name="displayName"]', "Hala Fouad");
  await page.fill('input[name="email"]', `hala-${Date.now()}@example.invalid`);
  await page.fill('input[name="password"]', "StrongPass123");
  await save("Create account");
  const people = await page.textContent("body");
  check("an account is created from inside the application", people.includes("Hala Fouad"));
  check("and the administrator is still signed in as themselves", people.includes("Mona Rashad"));

  // ── settings: the departments a hold may name ──
  await go("/settings/", 'textarea[name="departments"]');
  await page.fill('textarea[name="departments"]', "Machining\nGrinding\nHeat treatment");
  await save("Save departments");
  await go("/settings/", "text=Machining");
  check("departments are saved and read back", (await page.textContent("body")).includes("Grinding"));

  // ── settings: what one item has to be ──
  await go("/settings/item/", 'input[name="itemCode"]');
  await page.fill('input[name="itemCode"]', "Core");
  await page.fill('input[name="itemName"]', "Core insert");
  // One dimension at each stage.
  await page.click('button:has-text("+ Add") >> nth=0');
  await page.fill('input[name="roughingName"]', "Outside diameter");
  await page.fill('input[name="roughingNominal"]', "50.6");
  await page.fill('input[name="roughingTolMinus"]', "0.2");
  await page.fill('input[name="roughingTolPlus"]', "0.2");
  await page.click('button:has-text("+ Add") >> nth=1');
  await page.fill('input[name="finishName"]', "Outside diameter");
  await page.fill('input[name="finishNominal"]', "50");
  await page.fill('input[name="finishTolMinus"]', "0.01");
  await page.fill('input[name="finishTolPlus"]', "0.01");
  await save("Save the item");
  await go("/settings/", "text=Core");
  check("an item's dimensions are configured", (await page.textContent("body")).includes("Core insert"));

  // ── planning: bring in the sheet ──
  await go("/planning/", 'input[type="file"]');
  await page.setInputFiles('input[type="file"]', SHEET);
  await page.waitForSelector("text=row(s) ready", { timeout: 15000 });
  const preview = await page.textContent("body");
  check("the sheet is read before anything is written", preview.includes("3 row(s) ready"));

  await page.click('button:has-text("Bring in")');
  await page.waitForSelector("text=brought in", { timeout: 25000 });
  await go("/planning/", `text=${PROJECT}`);
  const planning = await page.textContent("body");
  check(
    "all three lines are in",
    planning.includes(PROJECT) && planning.includes("Cavity") && planning.includes("Guide bar")
  );

  // ── the filter narrows the lines ──
  await page.fill('input[type="search"]', "guide");
  await page.waitForTimeout(600);
  const narrowed = await page.textContent("body");
  check(
    "searching a line leaves only that one",
    narrowed.includes("Guide bar") && !narrowed.includes("Cavity block")
  );
  await page.click('button:has-text("Clear")');
  await page.waitForTimeout(600);

  // ── correcting a line that nobody has measured ──
  await page.click(`button[title="Edit ${PROJECT} Guide"]`);
  await page.waitForSelector('input[name="itemName"]', { timeout: 10000 });
  check(
    "the fields the line is identified by are not offered for editing",
    (await page.locator('input[name="project"]').count()) === 0 &&
      (await page.locator('input[name="itemCode"]').count()) === 0
  );

  await page.fill('input[name="itemName"]', "Guide bar, revised");
  await page.fill('input[name="mplpr"]', "MP9");
  await page.fill('input[name="qty"]', "3");
  // Scoped to the row being edited: the grid above has a "Save line(s)" button
  // of its own, disabled while the grid is empty.
  await page.click('tr:has(input[name="itemName"]) button[type="submit"]');
  await page.waitForTimeout(2800);
  const edited = await page.textContent("body");
  check("a line can be corrected in place", edited.includes("Guide bar, revised") && edited.includes("MP9"));

  await go("/queue/", "text=Waiting on quality");
  await page.waitForTimeout(2500);
  const resized = await page.textContent("body");
  check(
    "raising the quantity puts the extra pieces in the queue",
    /3\s*pieces/.test(resized)
  );

  // ── and deleting one ──
  await go("/planning/", `text=${PROJECT}`);
  page.once("dialog", (d) => d.accept());
  await page.click('tr:has-text("Guide bar, revised") button:has-text("Delete")');
  await page.waitForTimeout(3000);
  // Scoped to this run's project. The emulator keeps what earlier runs left
  // behind, so a search of the whole page for the item name finds their rows
  // and reports a working delete as a failure.
  const leftOver = await page.locator(`tr:has-text("${PROJECT}"):has-text("Guide")`).count();
  check(
    "a line nobody has measured can be deleted",
    leftOver === 0,
    leftOver === 0 ? "" : `${leftOver} row(s) still listed`
  );

  // ── the queue: two lines, standing closed ──
  await go("/queue/", "text=Waiting on quality");
  await page.waitForTimeout(2500);
  const queue = await page.textContent("body");
  check(
    "both lines are waiting, under their own headings",
    queue.includes(PROJECT) && queue.includes("Core insert") && queue.includes("Cavity block")
  );
  check("a closed line says how many pieces are under it", /2\s*pieces/.test(queue));
  check(
    "and keeps the serials out of the way until it is opened",
    !queue.includes(CORE)
  );

  // ── the filter narrows the queue ──
  await page.fill('input[type="search"]', "Cavity");
  await page.waitForTimeout(600);
  const filtered = await page.textContent("body");
  check(
    "searching an item leaves only that line",
    filtered.includes("Cavity block") && !filtered.includes("Core insert")
  );
  await page.click('button:has-text("Clear")');
  await page.waitForTimeout(600);
  check(
    "clearing the filter brings the rest back",
    (await page.textContent("body")).includes("Core insert")
  );

  // ── measure it, and hold it ──
  await openLine("Core");
  await page.click(`a:has-text("${CORE}")`);
  await page.waitForSelector("text=Outside diameter", { timeout: 25000 });
  check("the sheet comes ready with the item's dimensions", true);

  await page.fill('input[name="readingActual"]', "51.4");
  await page.waitForTimeout(400);
  const suggestion = await page.textContent("body");
  check(
    "an out-of-tolerance reading is called out before anything is signed",
    suggestion.includes("outside tolerance")
  );

  await page.selectOption('select[name="holdDepartment"]', "Machining");
  await save("Sign the");
  await page.waitForTimeout(2000);
  const afterHold = await page.textContent("body");
  check("holding it puts it with the department", afterHold.includes("Machining"));

  // ── the department reports back ──
  await go("/queue/", "text=In rework");
  await page.waitForTimeout(2500);
  await openLine("Core", "In rework");
  page.once("dialog", (d) => d.accept());
  await page.click('button:has-text("Rework done")');
  await page.waitForTimeout(2500);
  await go("/queue/", "text=Waiting on quality");
  await page.waitForTimeout(2500);
  await openLine("Core");
  const backWithQc = await page.textContent("body");
  check("closing the rework brings it back to quality", backWithQc.includes(CORE));

  // ── measure it again, and accept it ──
  await page.click(`a:has-text("${CORE}")`);
  await page.waitForSelector("text=Outside diameter", { timeout: 25000 });
  const round = await page.textContent("body");
  check("it comes back as a second round at the same stage", round.includes("round 2") || round.includes("Round 2"));

  await page.fill('input[name="readingActual"]', "50.6");
  await save("Sign the");
  await page.waitForTimeout(2500);
  const moved = await page.textContent("body");
  check("accepting it moves it to finish", moved.includes("Finish"));
  check("its measurement count follows it", /Times measured[\s\S]{0,80}2/.test(moved));

  // ── the drawing carries to the next piece of the same part ──
  // Cavity is deliberately not configured in settings: everything the second
  // piece knows, it can only have learned from the sheet signed for the first.
  await go("/queue/", "text=Waiting on quality");
  await page.waitForTimeout(2500);
  await openLine(CAVITY);
  await page.click(`a:has-text("${CAVITY_1}")`);
  await page.waitForSelector("text=not set up yet", { timeout: 25000 });
  check(
    "an item nobody has measured opens with an empty sheet",
    (await page.locator('input[name="readingKey"]').count()) === 0
  );

  await page.click('button:has-text("Add a dimension")');
  await page.waitForSelector('input[name="readingName"]:not([type="hidden"])', { timeout: 10000 });
  await page.fill('input[name="readingName"]', "Bore depth");
  await page.fill('input[name="readingNominal"]', "18");
  await page.fill('input[name="readingTolMinus"]', "-0.05");
  await page.fill('input[name="readingTolPlus"]', "0.05");
  await page.fill('input[name="readingActual"]', "18.02");
  await save("Sign the");
  await page.waitForTimeout(2500);

  await go("/queue/", "text=Waiting on quality");
  await page.waitForTimeout(2500);
  await openLine(CAVITY);
  await page.click(`a:has-text("${CAVITY_2}")`);
  await page.waitForSelector("text=Bore depth", { timeout: 25000 });

  const carried = {
    nominal: await page.inputValue('input[name="readingNominal"]'),
    tolMinus: await page.inputValue('input[name="readingTolMinus"]'),
    tolPlus: await page.inputValue('input[name="readingTolPlus"]'),
    actual: await page.inputValue('input[name="readingActual"]'),
  };
  check(
    "the next piece opens with the first piece's nominal and tolerance already in",
    carried.nominal === "18" && carried.tolMinus === "-0.05" && carried.tolPlus === "0.05",
    JSON.stringify(carried)
  );
  check(
    "and only the reading is left to type",
    carried.actual === "",
    `actual was ${JSON.stringify(carried.actual)}`
  );

  // Carried forward, not carried over: the verdict is still this piece's own.
  await page.fill('input[name="readingActual"]', "18.4");
  await page.waitForTimeout(400);
  const ownVerdict = await page.textContent("body");
  check(
    "the carried tolerance is applied to the new reading, not the old one",
    ownVerdict.includes("outside tolerance")
  );

  // ── the dashboard reads the tallies ──
  await go("/", "text=Waiting on quality");
  await page.waitForTimeout(3000);
  const dash = await page.textContent("body");
  check("the dashboard counts the hold against its department", dash.includes("Machining"));
  check("the dashboard shows what is still waiting", /Waiting on quality/.test(dash));

  // ── the rules are still the boundary ──
  // Sign out lives under the account menu now, not on the bar.
  await page.click('button:has-text("Mona Rashad")');
  await page.waitForTimeout(300);
  await page.click('button:has-text("Sign out")');
  await page.waitForURL(/\/login/, { timeout: 25000 });
  check("signing out returns to the login page", page.url().includes("/login"));

  const unexpected = consoleErrors.filter(
    (e) =>
      !e.includes("favicon") &&
      !e.includes("React DevTools") &&
      !e.includes("403") &&
      !e.toLowerCase().includes("permission")
  );
  check(
    "no unexpected console errors",
    unexpected.length === 0,
    [...unexpected.slice(0, 2), ...missing.slice(0, 2)].join(" | ")
  );
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
