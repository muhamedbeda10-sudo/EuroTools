# Eurotools — فحص الجودة / Quality Inspection

تطبيق تتبّع الجودة من **استلام الخامة حتى الإفراج النهائي**، بواجهة عربية (RTL)
وبيانات إنجليزية.

A quality-inspection app covering the full route from raw-material receiving
to final quality release. Arabic RTL UI, English data values.

## المسار (Process flow)

```
استلام الخامات (1)
        ↓
تحليل الخامة (2)  ──── عينات عشوائية تُقارن بالمواصفة
        ↓
      Roughing
        ↓
الفحص بعد الـ Roughing (3)        → Accepted / Rework / Rejected
        ↓
   Heat Treatment
        ↓
الفحص البصري + الصلادة (4)         → Accepted / Rejected / Further Investigation
        ↓
      Grinding
        ↓
الفحص بعد الـ Grinding (5)         → Accepted / Rework / Rejected
        ↓
      Finishing
        ↓
الفحص النهائي + CMM (6)            → Released / Rework / Rejected
        ↓
   الإفراج النهائي عن الجودة
```

## التشغيل محليًا

التطبيق يحتاج **PostgreSQL** (النسخة 14 فما فوق). التطبيق يعمل على المنفذ
**3001**، فيمكن تشغيله جنبًا إلى جنب مع تطبيق آخر على 3000.

```bash
cp .env.example .env        # ملف الإعدادات — غير موجود في git
npm install
createdb eurotools_dev      # أو أي قاعدة PostgreSQL فارغة
npx prisma migrate deploy
npm run seed                # بيانات تجريبية تغطي كل المراحل (اختياري)
npm run dev                 # http://localhost:3001
```

بيانات الـ seed تاريخية: الحسابات فيها موقوفة وبمعرّفات Firebase صناعية، فلا
يستطيع أحد الدخول بها. لإنشاء أول حساب حقيقي راجع قسم النشر.

أوامر أخرى:

```bash
npm run test:run     # 105 اختبار وحدة للمنطق النقي
npm run typecheck
npm run lint
npm run build && npm start
npm run db:reset     # مسح القاعدة وإعادة تطبيق الـ migrations
npm run create-admin # إنشاء أول مدير نظام
```

المتغيّرات كلها موصوفة في `.env.example`. أهمها `DATABASE_URL`، وإعدادات
Firebase، و`NEXT_PUBLIC_QC_TIME_ZONE` (الافتراضي `Africa/Cairo`).

## الصفحات

| الصفحة | الوظيفة |
| --- | --- |
| `/` | لوحة المتابعة: طوابير كل مرحلة، خامات تحتاج متابعة، نسبة القبول، آخر الفحوص |
| `/lots` · `/lots/new` · `/lots/[id]` | استلام الخامات، الشهادات، كشف الاستلام، التحاليل، وإصدار الأجزاء |
| `/queue` | الأجزاء الواقفة عند كل مرحلة فحص |
| `/parts` · `/parts/[id]` | سجل تتبّع كل جزء: المسار، كشف المرحلة الحالية، تاريخ الفحوص، سجل الحركة |
| `/materials` · `/materials/[id]` | المواصفات: مدى الصلادة، Ra، الشهادات المطلوبة، والخواص المقاسة لكل مرحلة |
| `/reports` · `/reports/export` | أداء كل مرحلة، أكثر بنود عدم المطابقة، قياسات خارج السماحية، الإفراج النهائي، وتصدير CSV |
| `/login` | تسجيل الدخول. لا يوجد تسجيل ذاتي |
| `/admin/users` | الحسابات والصلاحيات وسجل تغييرها — لمدير النظام فقط |

## قواعد العمل (business rules)

كل القرارات تُتخذ في `lib/domain/` — دوال نقية بلا I/O، ومغطاة بالاختبارات:

- **الأبعاد**: تُقبل داخل `nominal − tolMinus … nominal + tolPlus` (الحدود نفسها مقبولة).
- **GD&T**: تُقبل داخل `0 … gdtLimit`؛ لا تُقرأ لها سماحية أبعاد إطلاقًا.
- **خاصية حرجة (Critical)** خارج السماحية → **رفض مباشر**، لا إعادة تشغيل.
- **الصلادة** أقل من المدى → رفض؛ أعلى من المدى → **فحص إضافي** (لا رفض).
- **كشف غير مكتمل** → الحالة تبقى `PENDING` ولا يتحرك الجزء — لكن أي عدم مطابقة
  مُسجَّلة تُحسم فورًا دون انتظار باقي البنود.
- **الاقتراح لا يُلزم الفاحص**: الواجهة تعرض النتيجة المقترحة وأسبابها، وللفاحص أن
  يختار حالة أخرى من الحالات المسموحة لتلك المرحلة فقط.
- **بوابات المسار**: الجزء لا يُفحص إلا في مرحلته الحالية؛ ولا تُصدر أجزاء من تشغيلة
  قبل قبول الاستلام واعتماد التحليل.
- كل إجابة بند وكل قياس يُحفظ منفصلًا (لا الحالة النهائية فقط)، ولذلك يستطيع تقرير
  «أكثر البنود تكرارًا في عدم المطابقة» أن يعمل أصلًا.

## الدخول والصلاحيات

الهوية من **Firebase Authentication**، والصلاحية من جدول `User` في قاعدة
البيانات. يعني إيقاف حساب يمنعه من الدخول في الطلب التالي مباشرة، دون انتظار
انتهاء صلاحية أي رمز.

اسم الفاحص **لا يُكتب في النموذج** — يأتي من الجلسة على الخادم. توقيع يستطيع
المتصفّح أن يكتبه ليس توقيعًا.

| العملية | مُطّلِع | فاحص | مشرف | مدير جودة | أدمن |
| --- | :-: | :-: | :-: | :-: | :-: |
| قراءة كل الصفحات والتقارير | ✓ | ✓ | ✓ | ✓ | ✓ |
| استلام تشغيلة وتسجيل الشهادات | ✗ | ✓ | ✓ | ✓ | ✓ |
| فتح تحليل وإدخال نتائجه | ✗ | ✓ | ✓ | ✓ | ✓ |
| تسجيل كشف مرحلة بالنتيجة المحسوبة | ✗ | ✓ | ✓ | ✓ | ✓ |
| **تجاوز** النتيجة المحسوبة | ✗ | ✗ | ✓ | ✓ | ✓ |
| إصدار أجزاء وإرجاع جزء للطابور | ✗ | ✗ | ✓ | ✓ | ✓ |
| **الإفراج النهائي** (`RELEASED`) | ✗ | ✗ | ✗ | ✓ | ✓ |
| تعديل المواصفات والسماحيات | ✗ | ✗ | ✗ | ✓ | ✓ |
| إدارة المستخدمين | ✗ | ✗ | ✗ | ✗ | ✓ |

خط الصلاحية مرسوم عند **التجاوز** لا عند التسجيل، لأن نتيجة الكشف مُشتقّة من
البنود والقياسات وليست مكتوبة: تسجيلها إثبات واقعة يقوم به أي فاحص، أما مخالفتها
فقرار يحتاج مشرفًا، والإفراج عن المنتج يحتاج مدير جودة.

المصفوفة كلها في `lib/domain/roles.ts` كدوال نقية، ومثبَّتة بالكامل في
`roles.test.ts` حتى لا تتوسّع صلاحية دون أن تظهر في الـ diff. نفس الدوال تعمل في
المتصفح لإخفاء ما لا يستطيع الحساب فعله، وعلى الخادم لاتخاذ القرار.

الحماية الفعلية في `requirePermission` داخل `lib/server/auth.ts`، بجوار البيانات.
`proxy.ts` فحص تفاؤلي فقط — ينظر هل توجد كوكي جلسة، لا هل هي صحيحة — وكوكي مزوّر
يعبره ويُرفض عند طبقة البيانات.

الحسابات **لا تُحذف أبدًا**، تُوقَف فقط: كل فحص موقَّع يجب أن يظل مشيرًا إلى صاحبه،
والمخطط يفرض ذلك بـ `ON DELETE RESTRICT`. وتغييرات الصلاحيات تُسجَّل في
`UserAuditEvent`.

## النشر على Firebase App Hosting

كل صفحات التطبيق تُبنى عند الطلب على الخادم والكتابة عبر Server Actions، فلا
يمكن تصديره كموقع ثابت، و**Firebase Hosting العادي لا يكفي**. المنتج الصحيح هو
**App Hosting** الذي يشغّله فوق Cloud Run.

الإعداد كله في `apphosting.yaml`، وليس فيه أي سر: الأسرار في Cloud Secret
Manager. المنطقة المقترحة `europe-west1`، ويجب أن تكون قاعدة البيانات في نفس
المنطقة.

### 1 · قاعدة البيانات

```bash
gcloud sql instances create eurotools-qc \
  --database-version=POSTGRES_16 \
  --region=europe-west1 \
  --tier=db-custom-1-3840 \
  --storage-auto-increase \
  --backup-start-time=01:00 \
  --enable-point-in-time-recovery \
  --retained-backups-count=30

gcloud sql databases create eurotools --instance=eurotools-qc
gcloud sql users create qc_app --instance=eurotools-qc --password='...'
```

النسخ الاحتياطي والاسترجاع الزمني (PITR) ليسا اختياريين هنا: سجل الفحص مستند
جودة يُطلب إثباته، وفقدانه ليس عطلًا بل عدم مطابقة.

**انتبه لعدد الاتصالات.** كل نسخة من التطبيق تفتح حتى `connection_limit`
اتصالًا (٥ في `.env.example`)، و`maxInstances` في `apphosting.yaml` عشرة، أي ٥٠
اتصالًا في الذروة. تأكّد أن `max_connections` في الفئة التي اخترتها أكبر من ذلك
بهامش — الفئات المشتركة الصغيرة تسمح بعدد أقل بكثير مما تتوقّع. إذا رفعت
`maxInstances` فارفع الفئة معها.

### 2 · المصادقة

من Firebase Console فعّل **Authentication → Sign-in method → Email/Password**.
لا تفعّل التسجيل الذاتي؛ الحسابات يُنشئها مدير النظام من داخل التطبيق.

ثم امنح حساب خدمة App Hosting صلاحية توقيع كوكي الجلسة. بدون هذه الخطوة يفشل
تسجيل الدخول في خطوته الأخيرة برسالة صلاحيات:

```bash
# تأكّد من اسم حساب الخدمة من Console أولًا
SA=firebase-app-hosting-compute@PROJECT_ID.iam.gserviceaccount.com
gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --member="serviceAccount:$SA" \
  --role="roles/iam.serviceAccountTokenCreator"
```

### 3 · السر والإعداد

```bash
firebase apphosting:secrets:set qc-database-url
# القيمة:
# postgresql://qc_app:PASSWORD@PRIVATE_IP:5432/eurotools?schema=public&connection_limit=5&sslmode=require

firebase apphosting:secrets:grantaccess qc-database-url --backend BACKEND_ID
```

ثم املأ `REPLACE_WITH_...` في `apphosting.yaml`، وأزِل التعليق عن `vpcAccess`
بعد تجهيز الشبكة.

### 4 · الـ migrations

**لا تُشغَّل أثناء البناء.** الوصول إلى VPC متاح في الـ runtime فقط، فخطوة البناء
لا تصل أصلًا إلى قاعدة بيانات على IP خاص. وهذا هو السلوك المطلوب على أي حال:
تعديل مخطط قاعدة بيانات مصنع يجب أن يكون خطوة مقصودة ومراجَعة، لا شيئًا يحدث
لأن الـ autoscaling أضاف نسخة.

شغّلها بنفسك قبل نشر أي إصدار يحتاجها:

```bash
cloud-sql-proxy PROJECT_ID:europe-west1:eurotools-qc --port 5432 &
DATABASE_URL="postgresql://qc_app:PASSWORD@127.0.0.1:5432/eurotools?schema=public" \
  npm run migrate:deploy
```

### 5 · أول حساب

بنفس الاتصال، وبنفس بيانات اعتماد Google المحلية:

```bash
ADMIN_EMAIL=qa.manager@example.com \
ADMIN_PASSWORD='...' \
ADMIN_NAME='م. منى رشاد' \
FIREBASE_PROJECT_ID=PROJECT_ID \
DATABASE_URL="postgresql://qc_app:PASSWORD@127.0.0.1:5432/eurotools?schema=public" \
  npm run create-admin
```

كل حساب بعده يُنشأ من `/admin/users` داخل التطبيق. لا تمرّر كلمة المرور كوسيط
في سطر الأوامر؛ تظهر في تاريخ الطرفية وقائمة العمليات.

### 6 · إنشاء الـ backend والنشر

App Hosting ينشر أساسًا من GitHub: تربط المستودع وفرعًا واحدًا، فيبني وينشر عند
كل دفعة على ذلك الفرع.

```bash
firebase init apphosting   # يربط المستودع والفرع وينشئ firebase.json
```

ثم اختر المنطقة `europe-west1` نفسها التي أنشأت فيها قاعدة البيانات. بعد ذلك كل
`git push` على الفرع المربوط ينشر نسخة جديدة. للنشر يدويًا دون دفعة:

```bash
firebase deploy --only apphosting
```

**رتّب الخطوات هكذا عند كل إصدار يغيّر المخطط:** طبّق الـ migrations أولًا
(الخطوة ٤)، ثم انشر. النسخة الجديدة تبدأ فورًا بعد البناء، فلو نشرت أولًا ستعمل
مؤقتًا على مخطط أقدم مما تتوقّعه.

## البنية

```
app/                صفحات RTL (App Router) + تسجيل الدخول + الإدارة + التصدير
components/         ChecklistForm (قلب التطبيق) + عناصر واجهة مشتركة
lib/domain/         منطق نقي + اختباراته
                    stages.ts = مصدر الكشوف الوحيد
                    roles.ts  = مصدر الصلاحيات الوحيد
lib/server/         الاستعلامات وServer Actions والجلسة فوق Prisma
proxy.ts            فحص تفاؤلي يمنع غير المسجَّلين من الصفحات
prisma/             schema + migrations
scripts/seed.ts     بيانات تجريبية
scripts/create-admin.ts  أول حساب
apphosting.yaml     إعداد النشر
```

إضافة أو تعديل بند في أي كشف يتم من `lib/domain/stages.ts` وحده؛ الواجهة والتصدير
والتقارير تلتقط التغيير تلقائيًا. `key` هو ما يُخزَّن، فتغيير نص البند لا يُبطل السجلات
القديمة.

## التقنيات

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind v4 ·
Prisma + PostgreSQL · Firebase Authentication · Vitest ·
Firebase App Hosting (Cloud Run) + Cloud SQL.
