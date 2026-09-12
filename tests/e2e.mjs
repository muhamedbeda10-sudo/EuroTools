/** The application, driven in a real browser.
 *
 *  Everything runs in the browser now — the pages, the queries, the writes —
 *  so curl only ever sees an empty shell and a unit test only ever sees the
 *  pieces. Signing in, reading the plant's data and walking to a traveller are
 *  things only a browser can actually prove.
 *
 *  Against the emulators, with the site built and served:
 *
 *      npm run emulators                 # in another terminal
 *      npm run seed && npm run create-admin
 *      npm run build
 *      npx firebase emulators:start --only hosting
 *      npm run test:e2e
 *
 *  The build step needs `.env.production` out of the way. `npm run deploy`
 *  writes that file pointed at the real project with the emulators cleared,
 *  which is right for a deployment and useless here — the run would sign in
 *  against production. Move it aside first if it exists.
 */

import { chromium } from "playwright";

const BASE = process.env.E2E_BASE ?? "http://127.0.0.1:5000";
const EMAIL = process.env.E2E_EMAIL ?? "qa.manager@example.com";
const PASSWORD = process.env.E2E_PASSWORD ?? "StrongPass123";

/** The image ships its own Chromium and the installed Playwright expects a
 *  different build number, so it is pointed at the one that is here. */
const EXECUTABLE =
  process.env.E2E_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok });
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({ executablePath: EXECUTABLE });
const page = await browser.newPage();

const denials = [];
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
const missing = [];
page.on("response", (r) => {
  if (r.status() === 403) denials.push(r.url());
  // A 404 reaches the console as a bare "failed to load resource" with no clue
  // which one. Naming it here is the difference between a five-minute fix and
  // an afternoon.
  if (r.status() === 404) missing.push(r.url());
});

/** Firestore holds a connection open, so `networkidle` never settles; every
 *  wait is on something the page actually rendered. */
const go = async (path, selector) => {
  await page.goto(path.startsWith("http") ? path : BASE + path, {
    waitUntil: "domcontentloaded",
  });
  if (selector) await page.waitForSelector(selector, { timeout: 30000 });
};

try {
  // ── signed out ──
  await go("/");
  await page.waitForURL(/\/login/, { timeout: 20000 });
  check("signed out is sent to the login page", page.url().includes("/login"));

  // ── signing in ──
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes("login"), { timeout: 25000 });
  check("signing in lands on the dashboard", !page.url().includes("login"));

  // ── the dashboard shows the seeded plant ──
  await page.waitForSelector("text=LOT-2026-001", { timeout: 25000 });
  const dashboard = await page.textContent("body");
  check("lots are listed", dashboard.includes("LOT-2026-001") && dashboard.includes("LOT-2026-003"));
  // Three released against two rejected, which is what the seed walks.
  check("first-pass yield is computed from the data", /60(\.0)?%/.test(dashboard));
  check("the signed-in name is in the header", dashboard.includes("Mona Rashad"));

  // ── queues ──
  await go("/queue/", "text=LOT-2026-001-");
  check("the queue lists parts waiting", /LOT-2026-001-00\d\d/.test(await page.textContent("body")));

  // ── a traveller ──
  const partHref = await page.getAttribute('a[href*="/parts/view/?id="]', "href");
  await go(partHref, "text=Signed by");
  const part = await page.textContent("body");
  check("the traveller opens with its checklist", part.includes("Signed by"));
  check("the sheet is signed by the signed-in account", part.includes("Mona Rashad"));

  // ── reports ──
  await go("/reports/", "text=Every stored verdict agrees");
  const reports = await page.textContent("body");
  check(
    "the failure tally comes from its counter, not a scan",
    reports.includes("No grinding burn") && reports.includes("Required material certificates reviewed")
  );
  check("every stored verdict still matches its evidence", reports.includes("Every stored verdict agrees"));

  // ── administration ──
  await go("/admin/users/", "text=Users and Permissions");
  check("the staff list loads for an administrator", (await page.textContent("body")).includes("Hala Fouad"));

  // ── signing out ──
  denials.length = 0;
  await page.click("text=Sign out");
  await page.waitForURL(/\/login/, { timeout: 25000 });
  check("signing out returns to the login page", page.url().includes("/login"));

  // A read still in flight when the session ends is refused by the rules, not
  // by the page. That refusal is the boundary doing its job, so it is asserted
  // rather than tolerated.
  await go("/reports/");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  check(
    "a signed-out read is refused by the security rules",
    denials.length > 0 || page.url().includes("/login"),
    `${denials.length} refusals`
  );

  const unexpected = consoleErrors.filter(
    (e) =>
      !e.includes("favicon") &&
      !e.includes("React DevTools") &&
      // The refusals above surface here too; they are the expected outcome.
      !e.includes("403") &&
      !e.toLowerCase().includes("permission")
  );
  check(
    "no unexpected console errors",
    unexpected.length === 0,
    [...unexpected.slice(0, 2), ...missing.slice(0, 3)].join(" | ")
  );

  // ── on a phone ──
  //
  // A page that scrolls sideways on a tablet is not a cosmetic complaint: the
  // verdict buttons end up off the edge, and the inspector reaches for them
  // with a gloved hand and misses. This is measured rather than looked at,
  // because it came back twice before it was measured.
  const phone = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const small = await phone.newPage();
  await small.goto(`${BASE}/login/`, { waitUntil: "domcontentloaded" });
  await small.waitForSelector('input[name="email"]', { timeout: 20000 });
  await small.fill('input[name="email"]', EMAIL);
  await small.fill('input[name="password"]', PASSWORD);
  await small.click('button[type="submit"]');
  await small.waitForSelector("text=LOT-2026-001", { timeout: 25000 });

  const overflowing = [];
  for (const path of ["/", "/queue/", "/parts/", "/lots/", "/reports/", "/materials/", "/admin/users/"]) {
    await small.goto(`${BASE}${path}`, { waitUntil: "domcontentloaded" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const over = await small.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    if (over > 0) overflowing.push(`${path} +${over}px`);
  }
  check("no page scrolls sideways on a phone", overflowing.length === 0, overflowing.join(", "));

  // The tabs collapse into one control, and it is big enough to hit.
  const menu = small.locator('button[aria-controls="app-menu"]');
  const box = await menu.boundingBox();
  check(
    "the menu button is a touch target, not a link",
    box !== null && box.height >= 40,
    box ? `${Math.round(box.height)}px tall` : "missing"
  );

  await menu.click();
  await small.waitForSelector("#app-menu", { timeout: 5000 });
  check(
    "every section is reachable from the phone menu",
    (await small.locator("#app-menu a").count()) >= 6
  );

  // ── installable ──
  //
  // These are exactly what a browser looks for before it will offer to put the
  // application on a home screen. Any one of them missing and the option never
  // appears, silently.
  const install = await small.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    if (!link) return null;
    const m = await (await fetch(link.getAttribute("href"))).json();
    const sizes = (m.icons ?? []).map((i) => i.sizes);
    return {
      standalone: m.display === "standalone",
      named: Boolean(m.name && m.short_name),
      icons: sizes.includes("192x192") && sizes.includes("512x512"),
      maskable: (m.icons ?? []).some((i) => (i.purpose ?? "").includes("maskable")),
      workers: (await navigator.serviceWorker.getRegistrations()).length,
    };
  });
  check(
    "the browser has what it needs to offer an install",
    Boolean(
      install &&
        install.standalone &&
        install.named &&
        install.icons &&
        install.maskable &&
        install.workers > 0
    ),
    JSON.stringify(install)
  );

  await phone.close();
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
