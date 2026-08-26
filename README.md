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

على ويندوز: شغّل **`setup.bat`** مرة واحدة، ثم **`run.bat`** في كل مرة
(و`stop.bat` لإيقاف الخادم). التطبيق يعمل على المنفذ **3001**، فيمكن تشغيله جنبًا
إلى جنب مع تطبيق آخر على 3000 على نفس الجهاز.

أو يدويًا:

```bash
cp .env.example .env        # ملف الاعدادات — غير موجود في git
npm install
npx prisma migrate deploy   # ينشئ prisma/dev.db
npm run seed                # بيانات تجريبية تغطي كل المراحل (اختياري)
npm run dev                 # http://localhost:3001
```

أوامر أخرى:

```bash
npm run test:run   # 81 اختبار وحدة للمنطق النقي
npm run typecheck
npm run lint
npm run build && npm start
npm run db:reset   # مسح القاعدة وإعادة تطبيق الـ migrations
```

`DATABASE_URL` في `.env` (النسخة الافتراضية `file:./dev.db`).
لضبط المنطقة الزمنية للعرض: `NEXT_PUBLIC_QC_TIME_ZONE` (الافتراضي `Africa/Cairo`).

## الصفحات

| الصفحة | الوظيفة |
| --- | --- |
| `/` | لوحة المتابعة: طوابير كل مرحلة، خامات تحتاج متابعة، نسبة القبول، آخر الفحوص |
| `/lots` · `/lots/new` · `/lots/[id]` | استلام الخامات، الشهادات، كشف الاستلام، التحاليل، وإصدار الأجزاء |
| `/queue` | الأجزاء الواقفة عند كل مرحلة فحص |
| `/parts` · `/parts/[id]` | سجل تتبّع كل جزء: المسار، كشف المرحلة الحالية، تاريخ الفحوص، سجل الحركة |
| `/materials` · `/materials/[id]` | المواصفات: مدى الصلادة، Ra، الشهادات المطلوبة، والخواص المقاسة لكل مرحلة |
| `/reports` · `/reports/export` | أداء كل مرحلة، أكثر بنود عدم المطابقة، قياسات خارج السماحية، الإفراج النهائي، وتصدير CSV |

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

## البنية

```
app/            صفحات RTL (App Router) + route للتصدير
components/     ChecklistForm (قلب التطبيق) + عناصر واجهة مشتركة
lib/domain/     منطق نقي + اختباراته (stages.ts = مصدر الكشوف الوحيد)
lib/server/     الاستعلامات وServer Actions فوق Prisma
prisma/         schema + migrations
scripts/seed.ts بيانات تجريبية
```

إضافة أو تعديل بند في أي كشف يتم من `lib/domain/stages.ts` وحده؛ الواجهة والتصدير
والتقارير تلتقط التغيير تلقائيًا. `key` هو ما يُخزَّن، فتغيير نص البند لا يُبطل السجلات
القديمة.

## التقنيات

Next.js 16 (App Router, Turbopack) · React 19 · TypeScript · Tailwind v4 ·
Prisma + SQLite · Vitest.
