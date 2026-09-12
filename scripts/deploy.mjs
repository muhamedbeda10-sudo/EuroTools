/** Deploy the site and its security rules, in one command.
 *
 *      npm run deploy
 *
 *  Everything here is automatic except signing in to Google, which is a
 *  personal authorisation nobody can do on your behalf. If you are not signed
 *  in, this stops and says so rather than half-deploying.
 *
 *  What it does:
 *    1. confirms the Firebase CLI is signed in and which project is selected
 *    2. reads the web app's configuration out of the project and writes
 *       `.env.production` — no copying values out of the console by hand, and
 *       no chance of a typo in the project id silently building an app that
 *       talks to nothing
 *    3. builds the static site
 *    4. deploys Hosting and the Firestore rules together
 *
 *  Rules and site go up in the same command on purpose. Deploying the site
 *  against stale rules is the one ordering that can leave data exposed.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

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
  console.log(`\n[${n}/4] ${message}`);
}

// ── 1 · who are we, and which project ────────────────────────────────────────
step(1, "التحقق من تسجيل الدخول والمشروع…");

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
    "ثم أعد تشغيل: npm run deploy"
  );
}
console.log("      " + accounts.trim().split("\n").filter(Boolean).slice(-1)[0]);

const projectArg = process.argv.find((a) => a.startsWith("--project="));
const project = projectArg?.split("=")[1];

let projectId = project;
if (!projectId) {
  try {
    const active = JSON.parse(run("npx firebase projects:list --json 2>/dev/null"));
    const ids = (active.result ?? []).map((p) => p.projectId);
    if (existsSync(".firebaserc")) {
      const rc = JSON.parse(run("cat .firebaserc"));
      projectId = rc.projects?.default;
    }
    if (!projectId)
      stop(
        "لم يُحدَّد مشروع.",
        "اختر مشروعك مرة واحدة:",
        "",
        `    npx firebase use <project-id>`,
        "",
        "المشاريع المتاحة على حسابك:",
        ...ids.map((id) => `      ${id}`)
      );
  } catch {
    stop("تعذّر قراءة قائمة المشاريع.", "تأكد من تسجيل الدخول: npx firebase login");
  }
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
    "لا يوجد تطبيق ويب في هذا المشروع بعد.",
    "من Firebase Console → Project Overview → Add app → اختر الويب (</>)،",
    "سمّه أي اسم، وتخطَّ خطوة Hosting (سننشرها من هنا).",
    "",
    "ثم أعد تشغيل: npm run deploy"
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
    "# The emulator hosts are deliberately absent — a deployed build carrying",
    "# them would talk to a database that does not exist.",
    `NEXT_PUBLIC_FIREBASE_API_KEY="${config.apiKey}"`,
    `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN="${config.authDomain}"`,
    `NEXT_PUBLIC_FIREBASE_PROJECT_ID="${config.projectId}"`,
    `NEXT_PUBLIC_QC_TIME_ZONE="${TIMEZONE}"`,
    "",
  ].join("\n"),
  "utf8"
);
console.log(`      ✓ .env.production (${config.projectId})`);

// ── 3 · build ────────────────────────────────────────────────────────────────
step(3, "بناء الموقع الثابت…");
try {
  // The production env file is what a Next.js production build reads, so the
  // emulator settings in `.env` cannot leak into a deployed bundle.
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
} catch {
  stop("فشل البناء — راجع الرسائل أعلاه.");
}

// ── 4 · deploy ───────────────────────────────────────────────────────────────
step(4, "نشر الموقع وقواعد الأمان معًا…");
try {
  execFileSync(
    "npx",
    ["firebase", "deploy", "--only", "hosting,firestore:rules", "--project", projectId],
    { stdio: "inherit" }
  );
} catch {
  stop(
    "فشل النشر.",
    "أشهر سببين:",
    "  • قاعدة Firestore غير منشأة — من Console → Firestore Database → Create database",
    "  • الحساب لا يملك صلاحية النشر على هذا المشروع"
  );
}

console.log(`
  ✓ تم النشر.

    الموقع:  https://${projectId}.web.app

    إن كانت هذه أول مرة، تبقّى شيئان في Console لا يمكن أتمتتهما:

      1. Authentication → Sign-in method → فعّل Email/Password
         (لا تفعّل التسجيل الذاتي — الحسابات يُنشئها مدير النظام)

      2. أنشئ أول حساب مدير — الخطوات بالحقول في README تحت
         «أول حساب»، أو بأمر واحد إن نزّلت مفتاح خدمة:

           npm run create-admin
`);
