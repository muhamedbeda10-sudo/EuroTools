/** Deploy the site and its security rules, in one command.
 *
 *      npm run deploy
 *
 *  Everything here is automatic except proving who you are to Google. Two
 *  ways to do that:
 *
 *    • at a keyboard — `npx firebase login`, once, in a browser
 *    • unattended — a service account key in GOOGLE_APPLICATION_CREDENTIALS,
 *      or a CI token in FIREBASE_TOKEN, which is how the GitHub workflow in
 *      `.github/workflows/deploy.yml` runs this without anybody present
 *
 *  With neither, this stops and says so rather than half-deploying.
 *
 *  What it does:
 *    1. confirms the Firebase CLI is signed in and which project is selected
 *    2. reads the web app's configuration out of the project and writes
 *       `.env.production` — no copying values out of the console by hand, and
 *       no chance of a typo in the project id silently building an app that
 *       talks to nothing
 *    3. builds the static site
 *    4. checks the built files for a local address before anything is uploaded
 *    5. deploys the Firestore rules and indexes, then the site
 *
 *  That order is deliberate. Deploying the site first would put a new page in
 *  front of old rules, which is the one ordering that can leave data exposed,
 *  and in front of missing indexes, which is the one that makes the reports
 *  fail on opening. If the second half fails, what is live is the old site
 *  under the new rules — narrower than it was, never wider.
 *
 *  Step 4 exists because this has already gone wrong once. Next.js merges
 *  `.env` into every build, so a `.env.production` that merely omits the
 *  emulator hosts inherits them and bakes 127.0.0.1 into the bundle. That
 *  deploys without complaint and then fails every read on the shop floor.
 *  Cheaper to find here than there.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const TIMEZONE = process.env.QC_TIME_ZONE ?? "Africa/Cairo";

function run(command, options = {}) {
  return execSync(command, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"], ...options });
}

function stop(message, ...detail) {
  console.error(`\n  ✗ ${message}\n`);
  for (const line of detail) console.error(`    ${line}`);
  console.error("");
  process.exit(1);
}

function step(n, message) {
  console.log(`\n[${n}/5] ${message}`);
}

// ── 1 · who are we, and which project ────────────────────────────────────────
step(1, "التحقق من تسجيل الدخول والمشروع…");

/** A key or a token identifies us without a browser, which is what lets this
 *  run in CI. The CLI reads both from the environment on its own; all this
 *  does is skip a check that would fail for the wrong reason. */
const machineCredential = process.env.GOOGLE_APPLICATION_CREDENTIALS
  ? "مفتاح خدمة (GOOGLE_APPLICATION_CREDENTIALS)"
  : process.env.FIREBASE_TOKEN
    ? "رمز CI (FIREBASE_TOKEN)"
    : null;

if (machineCredential) {
  console.log(`      ${machineCredential}`);
} else {
  let accounts = "";
  try {
    accounts = run("npx firebase login:list 2>&1");
  } catch {
    stop("تعذّر تشغيل Firebase CLI.", "جرّب: npm install");
  }

  if (accounts.includes("No authorized accounts")) {
    stop(
      "لم تسجّل الدخول إلى Firebase.",
      "شغّل هذا الأمر مرة واحدة، وسيفتح المتصفّح لتسجّل دخولك بحساب Google:",
      "",
      "    npx firebase login",
      "",
      "ثم أعد تشغيل: npm run deploy",
      "",
      "أو انشر من GitHub بدل جهازك — الخطوات في README تحت «النشر من GitHub»."
    );
  }
  console.log("      " + accounts.trim().split("\n").filter(Boolean).slice(-1)[0]);
}

const projectArg = process.argv.find((a) => a.startsWith("--project="));
const project = projectArg?.split("=")[1];

let projectId = project;
if (!projectId && existsSync(".firebaserc")) {
  projectId = JSON.parse(readFileSync(".firebaserc", "utf8")).projects?.default;
}
if (!projectId) {
  // Only worth asking for the list when there is a person to read it.
  let ids = [];
  try {
    ids = (JSON.parse(run("npx firebase projects:list --json 2>/dev/null")).result ?? []).map(
      (p) => p.projectId
    );
  } catch {
    /* not signed in, or no permission to list — the message below still helps */
  }
  stop(
    "لم يُحدَّد مشروع.",
    "اختر مشروعك مرة واحدة:",
    "",
    "    npx firebase use <project-id>",
    ...(ids.length > 0 ? ["", "المشاريع المتاحة على حسابك:", ...ids.map((id) => `      ${id}`)] : [])
  );
}
console.log(`      المشروع: ${projectId}`);

// ── 2 · the web app's own configuration ──────────────────────────────────────
step(2, "قراءة إعدادات تطبيق الويب من المشروع…");

let config;
try {
  const raw = run(`npx firebase apps:sdkconfig WEB --project ${projectId} --json 2>/dev/null`);
  config = JSON.parse(raw).result?.sdkConfig;
} catch {
  config = null;
}

if (!config?.apiKey)
  stop(
    "تعذّرت قراءة إعدادات تطبيق الويب. سببان لا ثالث لهما عمليًا:",
    "",
    "  • لا يوجد تطبيق ويب في المشروع بعد. من Firebase Console →",
    "    Project Overview → Add app → اختر الويب (</>)، سمّه أي اسم،",
    "    وتخطَّ خطوة Hosting (سننشرها من هنا).",
    "",
    "  • الاعتماد المستخدم لا يملك قراءة إعدادات المشروع. إن كان مفتاح",
    "    خدمة، امنحه دور Firebase Admin — الخطوات في README تحت",
    "    «النشر من GitHub».",
    "",
    "ثم أعد المحاولة."
  );

// These values reach the browser by design: they name the project, they grant
// nothing. Every authorisation decision is made by firestore.rules.
writeFileSync(
  ".env.production",
  [
    "# Written by `npm run deploy` from the project's own web app configuration.",
    "# These values reach the browser by design: they identify the project and",
    "# grant nothing. Access is decided by firestore.rules, server-side.",
    "#",
    "# The emulator hosts below are cleared on purpose, and emptying them is",
    "# not the same as leaving them out: Next.js loads `.env` for every build",
    "# and this file only overrides the keys it names. Omit them and the local",
    "# development values are inlined into the deployed bundle, which then",
    "# asks each tablet for data from its own loopback address.",
    `NEXT_PUBLIC_FIREBASE_API_KEY="${config.apiKey}"`,
    `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="${config.authDomain}"`,
    `NEXT_PUBLIC_FIREBASE_PROJECT_ID="${config.projectId}"`,
    'NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST=""',
    'NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=""',
    `NEXT_PUBLIC_QC_TIME_ZONE="${TIMEZONE}"`,
    "",
  ].join("\n"),
  "utf8"
);
console.log(`      ✓ .env.production (${config.projectId})`);

// ── 3 · build ────────────────────────────────────────────────────────────────
step(3, "بناء الموقع الثابت…");
try {
  // `.env.production` wins over `.env` key by key, and the block above names
  // every key that must not survive the merge. Step 4 checks that it worked.
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
} catch {
  stop("فشل البناء — راجع الرسائل أعلاه.");
}

// ── 4 · look at what was actually built ──────────────────────────────────────
step(4, "فحص الملفات المبنية قبل الرفع…");

/** Any loopback address with a port on it. In a file about to be served to a
 *  tablet in a factory, there is no reading of this that is correct. */
const LOCAL_ADDRESS = /(?:127\.\d{1,3}\.\d{1,3}\.\d{1,3}|localhost|0\.0\.0\.0|\[::1\]):\d{2,5}/;
const SCANNED = new Set([".js", ".mjs", ".html", ".json", ".txt", ".css", ".map"]);

function scan(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...scan(full));
      continue;
    }
    if (!SCANNED.has(extname(entry.name))) continue;

    const hit = LOCAL_ADDRESS.exec(readFileSync(full, "utf8"));
    if (hit) found.push(`${full} → ${hit[0]}`);
  }
  return found;
}

const leaked = existsSync("out") ? scan("out") : [];
if (leaked.length > 0)
  stop(
    "الملفات المبنية تحتوي على عنوان محلي — لن تُرفع.",
    "المتصفّح على جهاز في المصنع سيطلب البيانات من نفسه، فلا يجد شيئًا.",
    "",
    ...leaked.slice(0, 5).map((line) => `  ${line}`),
    ...(leaked.length > 5 ? [`  … و${leaked.length - 5} غيرها`] : []),
    "",
    "السبب المعتاد: متغيّرات المحاكي في ‎.env‎ تسرّبت إلى البناء.",
    "احذف ‎out/‎ وأعد تشغيل: npm run deploy"
  );
console.log(`      ✓ لا عناوين محلية في الملفات المبنية`);

// ── 5 · deploy ───────────────────────────────────────────────────────────────
step(5, "نشر قواعد الأمان والفهارس، ثم الموقع…");

/** The rules and the indexes first. Both are things the site depends on, and
 *  neither is safe to be behind the page that uses it. */
try {
  execFileSync(
    "npx",
    ["firebase", "deploy", "--only", "firestore:rules,firestore:indexes", "--project", projectId],
    { stdio: "inherit" }
  );
} catch {
  stop(
    "فشل نشر القواعد أو الفهارس — لم يُرفع الموقع.",
    "أشهر سببين:",
    "  • قاعدة Firestore غير منشأة — من Console → Firestore Database → Create database",
    "  • الحساب لا يملك صلاحية النشر على هذا المشروع"
  );
}

try {
  execFileSync("npx", ["firebase", "deploy", "--only", "hosting", "--project", projectId], {
    stdio: "inherit",
  });
} catch {
  stop(
    "القواعد والفهارس رُفعت، لكن الموقع لم يُرفع.",
    "الموقع القديم ما زال يعمل تحت القواعد الجديدة، وهذا وضع آمن.",
    "أعد تشغيل: npm run deploy"
  );
}

console.log(`
  ✓ تم النشر.

    الموقع:  https://${projectId}.web.app

    الفهارس تُبنى في الخلفية. على قاعدة فاضية تجهز في ثوانٍ، ويمكن
    متابعتها من Console → Firestore Database → Indexes.

    إن كانت هذه أول مرة، تبقّى شيئان في Console لا يمكن أتمتتهما:

      1. Authentication → Sign-in method → فعّل Email/Password
         (لا تفعّل التسجيل الذاتي — الحسابات يُنشئها مدير النظام)

      2. أنشئ أول حساب مدير — الخطوات بالحقول في README تحت
         «أول حساب»، أو بأمر واحد إن نزّلت مفتاح خدمة:

           npm run create-admin
`);
