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
/** The signed-in account's own name. Read rather than assumed: the suite
 *  checks that creating somebody else did not sign the administrator out, and
 *  that check is worthless if it is looking for a name nobody set. */
const NAME = process.env.E2E_NAME ?? "Mona Rashad";
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
const CAVITY = "Cavity";
const CAVITY_1 = `${PROJECT}-${CAVITY}-001`;
const CAVITY_2 = `${PROJECT}-${CAVITY}-002`;
/** The same item on a second project. Carrying forward is scoped to a planning
 *  line, so this line must not inherit the first line's sheet — a repeat order
 *  can be to a revised drawing, and pre-filled limits are the ones nobody
 *  re-checks. */
const OTHER = `${PROJECT}B`;
const OTHER_CAVITY = `${OTHER}-${CAVITY}-001`;
const SHEET = join(tmpdir(), `qc-planning-${Date.now()}.csv`);
writeFileSync(
  SHEET,
  [
    "Project,MPLPR,Item,Name,Qty,Measuring type,Date,Priority,Duration,Description,Complete",
    `${PROJECT},MP,Core,Core insert,2,CMM,12/09/2026,A,,,`,
    `${PROJECT},MP,${CAVITY},Cavity block,2,Traditional,12/09/2026,B,,,`,
    `${PROJECT},MP,Guide,Guide bar,1,Traditional,12/09/2026,C,,,`,
    `${OTHER},MP,${CAVITY},Cavity block,1,Traditional,12/09/2026,D,,,`,
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
const openLine = async (itemCode, card = "Waiting on quality", project = PROJECT) => {
  await page.click(
    `section.card:has(h2:text-is("${card}")) button:has-text("${project}"):has-text("${itemCode}")`
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
  check("and the administrator is still signed in as themselves", people.includes(NAME));

  // ── settings: the departments a hold may name ──
  await go("/settings/", 'textarea[name="departments"]');
  await page.fill('textarea[name="departments"]', "Machining\nGrinding\nHeat treatment");
  await save("Save departments");
  await go("/settings/", "text=Machining");
  check("departments are saved and read back", (await page.textContent("body")).includes("Grinding"));

  // ── settings: the defects an inspector can record ──
  // One shared list. The grid has one column — no item, no department.
  await go("/settings/", 'textarea[name="departments"]');
  const defectCard = 'section.card:has(h2:has-text("Visual defects"))';
  check(
    "a defect is a name and nothing else",
    (await page.locator(`${defectCard} table th`).count()) === 3
  );

  await page.fill(`${defectCard} [data-cell="0:0"]`, "Scratch");
  await page.click(`${defectCard} button:has-text("Add a row")`);
  await page.waitForTimeout(400);
  await page.fill(`${defectCard} [data-cell="1:0"]`, "Grinding burn");
  await page.click(`${defectCard} button:has-text("Save")`);
  await page.waitForTimeout(2800);
  await go("/settings/", "text=Scratch");
  check(
    "the defect list is saved and read back",
    (await page.textContent("body")).includes("Grinding burn")
  );

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
  check("the sheet is read before anything is written", preview.includes("4 row(s) ready"));

  await page.click('button:has-text("Bring in")');
  await page.waitForSelector("text=brought in", { timeout: 25000 });
  await go("/planning/", `text=${PROJECT}`);
  const planning = await page.textContent("body");
  check(
    "all four lines are in",
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

  await go("/queue/", 'h2:text-is("Waiting on quality")');
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
  await go("/queue/", 'h2:text-is("Waiting on quality")');
  await page.waitForTimeout(2500);
  const queue = await page.textContent("body");
  check(
    "both lines are waiting, under their own headings",
    queue.includes(PROJECT) && queue.includes("Core insert") && queue.includes("Cavity block")
  );
  check("a closed line says how many pieces are under it", /2\s*pieces/.test(queue));
  check(
    "and keeps the serials out of the way until it is opened",
    !(await page.locator(`a:has-text("${CORE}")`).first().isVisible())
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
  await go("/queue/", 'h2:text-is("In rework")');
  await page.waitForTimeout(2500);
  await openLine("Core", "In rework");
  page.once("dialog", (d) => d.accept());
  // Scoped to this run's piece. Every group's rows are in the page now, open
  // or not, so an unscoped match can land on a button inside a closed group
  // left behind by an earlier run.
  await page.click(`tr:has-text("${CORE}") button:has-text("Rework done")`);
  await page.waitForTimeout(2500);
  await go("/queue/", 'h2:text-is("Waiting on quality")');
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
  await go("/queue/", 'h2:text-is("Waiting on quality")');
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

  await go("/queue/", 'h2:text-is("Waiting on quality")');
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

  // ── and it stops at the line it came from ──
  // Same item code, different planning line. Carrying forward is scoped to the
  // line, so this sheet must open empty rather than holding the other batch's
  // drawing.
  await go("/queue/", 'h2:text-is("Waiting on quality")');
  await page.waitForTimeout(2500);
  await openLine(CAVITY, "Waiting on quality", OTHER);
  await page.click(`a:has-text("${OTHER_CAVITY}")`);
  await page.waitForSelector("text=not set up yet", { timeout: 25000 });
  await page.waitForTimeout(900);
  const otherLine = await page.locator('input[name="readingKey"]').count();
  check(
    "another line of the same item does not inherit this one's drawing",
    otherLine === 0,
    otherLine === 0 ? "" : `${otherLine} dimension(s) carried across`
  );

  // Back to the piece the defect checks run against.
  await go("/queue/", 'h2:text-is("Waiting on quality")');
  await page.waitForTimeout(2500);
  await openLine(CAVITY);
  await page.click(`a:has-text("${CAVITY_2}")`);
  await page.waitForSelector("text=Bore depth", { timeout: 25000 });
  await page.waitForTimeout(700);

  // ── recording a defect ──
  // Picked from a list, added to the sheet, no department beside it.
  check(
    "nothing is recorded against a defect until one is chosen",
    (await page.textContent("body")).includes("None recorded.")
  );

  await page.selectOption('select[aria-label="Add a defect"]', { label: "Grinding burn" });
  await page.waitForTimeout(500);
  const withDefect = await page.textContent("body");
  check(
    "a defect picked from the list goes onto the sheet",
    withDefect.includes("Grinding burn") && !withDefect.includes("None recorded.")
  );
  check(
    "and the hold it requires says which defect it is for",
    withDefect.includes("Visual defect: Grinding burn")
  );

  await page.selectOption('select[aria-label="Add a defect"]', { label: "Scratch" });
  await page.waitForTimeout(500);
  check(
    "a second defect is added rather than replacing the first",
    (await page.textContent("body")).includes("Scratch") &&
      (await page.textContent("body")).includes("Grinding burn")
  );
  check(
    "a defect already on the sheet is not offered again",
    (await page.locator('select[aria-label="Add a defect"] option').allTextContents()).filter(
      (t) => t === "Scratch" || t === "Grinding burn"
    ).length === 0
  );

  await page.click('button[aria-label="Remove Scratch"]');
  await page.waitForTimeout(500);
  const afterRemove = await page.textContent("body");
  check(
    "and one added by mistake comes off again",
    !afterRemove.includes("Visual defect: Scratch") && afterRemove.includes("Grinding burn")
  );

  // The department is asked for once, on the hold — not beside every defect.
  check(
    "the department is chosen on the hold, not against each defect",
    (await page.locator('select[name="defectDepartment"]').count()) === 0 &&
      (await page.locator('select[name="holdDepartment"]').count()) === 1
  );

  // ── two inspectors, one piece ──
  // Both open the same piece while it is with quality and both sign. Firestore
  // reads the piece inside the transaction that moves it, so the second signer
  // re-reads a piece that has already left quality and the state machine
  // refuses it. Exactly one verdict lands; the loser is told why rather than
  // silently overwriting the first.
  await go("/queue/", 'h2:text-is("Waiting on quality")');
  await page.waitForTimeout(2500);
  await openLine("Core");
  const contested = await page.locator('a[href^="/piece/"]').first().getAttribute("href");

  const second = await browser.newPage();
  await second.goto(`${BASE}/login/`, { waitUntil: "domcontentloaded" });
  await second.fill('input[name="email"]', EMAIL);
  await second.fill('input[name="password"]', PASSWORD);
  await second.click('button[type="submit"]');
  await second.waitForURL((url) => !url.pathname.includes("login"), { timeout: 25000 });

  for (const p of [page, second]) {
    await p.goto(`${BASE}${contested}`, { waitUntil: "domcontentloaded" });
    await p.waitForSelector('input[name="readingActual"]', { timeout: 25000 });
    await p.fill('input[name="readingActual"]', "50.6");
  }

  await Promise.all([
    page.click('button:has-text("Sign the")'),
    second.click('button:has-text("Sign the")'),
  ]);
  await page.waitForTimeout(3500);
  await second.waitForTimeout(3500);

  const bodies = [await page.textContent("body"), await second.textContent("body")];
  const refused = bodies.filter((b) => /no longer|not with quality|already/i.test(b)).length;
  check(
    "when two inspectors sign the same piece at once, only one verdict lands",
    refused === 1,
    `${refused} of 2 were refused`
  );

  await second.goto(`${BASE}${contested}`, { waitUntil: "domcontentloaded" });
  await second.waitForTimeout(2500);
  const counted = await second.textContent("body");
  check(
    "and the piece was measured once, not twice",
    /Times measured[\s\S]{0,80}\b1\b/.test(counted),
    (counted.match(/Times measured[\s\S]{0,40}/) ?? [""])[0].replace(/\s+/g, " ")
  );
  await second.close();

  // ── the dashboard reads the tallies ──
  await go("/", "text=Waiting on quality");
  await page.waitForTimeout(3000);
  const dash = await page.textContent("body");
  check("the dashboard counts the hold against its department", dash.includes("Machining"));
  check("the dashboard shows what is still waiting", /Waiting on quality/.test(dash));

  // ── what the printer gets ──
  // At the paper's own width, not the browser's. Checking this at a desktop
  // width is how a report that overflowed A4 and lost its right-hand column
  // looked correct in every screenshot taken of it.
  //
  // What this cannot check is that the browser actually turns the paper for
  // the two wide reports: the orientation comes from `@page`, which only real
  // printing exercises, and the viewport is set here rather than derived. So
  // this proves each report fits the sheet it is designed for, not which sheet
  // the printer reaches for.
  const A4 = (mm) => Math.round(mm * (96 / 25.4));
  const PORTRAIT = A4(210) - 2 * A4(12);
  const LANDSCAPE = A4(297) - 2 * A4(10);

  for (const [label, path, sel, width] of [
    ["the piece sheet", `/piece/?id=${contested.split("id=")[1]}`, "text=Serial", PORTRAIT],
    ["the dashboard", "/", "text=First-pass rate", PORTRAIT],
    ["the planning report", "/planning/", 'h2:text-is("Lines")', LANDSCAPE],
    ["the queue report", "/queue/", 'h2:text-is("Waiting on quality")', LANDSCAPE],
  ]) {
    await page.emulateMedia({ media: "screen" });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(sel, { timeout: 25000 }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.emulateMedia({ media: "print" });
    await page.waitForTimeout(400);

    const over = await page.evaluate((w) => document.documentElement.scrollWidth - w, width);
    check(`${label} fits the paper it prints on`, over <= 0, `${over}px past the edge`);

    const printed = await page.evaluate(() => {
      const head = document.querySelector(".print-head");
      return {
        mark: !!head?.querySelector("svg"),
        dark: getComputedStyle(document.querySelector("section.card") ?? document.body)
          .backgroundColor,
      };
    });
    check(`${label} carries the mark and prints on white`, printed.mark && printed.dark === "rgb(255, 255, 255)",
      `${printed.mark ? "" : "no mark; "}${printed.dark}`);
  }
  await page.emulateMedia({ media: "screen" });
  await page.setViewportSize({ width: 1280, height: 1000 });

  // ── the rules are still the boundary ──
  // Sign out lives under the account menu now, not on the bar.
  await page.click(`button:has-text("${NAME}")`);
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
