# What's new in EGX Intelligence
The app's release notes, newest first: what changed in each version, for whom, and where to find it. The app shows the same list to its users after an update.

## 0.5.1 · 2026-11-16 · Plain words when a service refuses, and far fewer database reads
For: everyone
عربي: كلام واضح لما خدمة ترفض، وقراءات أقل بكتير من قاعدة البيانات

- When the database has used up its allowance for the day, every screen now says so in plain words, with when it comes back (about 10:00 Cairo time), instead of "Request failed (500)". Your data is safe while it lasts.
  عربي: لما قاعدة البيانات تخلّص حصتها اليومية، كل شاشة بقت تقول ده بكلام واضح ومعاه ميعاد رجوعها (حوالي 10:00 بتوقيت القاهرة)، بدل «Request failed (500)». وبياناتك في أمان طول الفترة دي.
- The app asks the database far less, so the allowance lasts: parts of a page that show the same thing share one request, and while prices are streaming the figures the server works out (portfolio value, breadth, movers) are re-read once a minute instead of every 15 seconds. The prices themselves still move with every trade.
  عربي: التطبيق بقى يسأل قاعدة البيانات أقل بكتير علشان الحصة تكفّي: أجزاء الصفحة اللي بتعرض نفس الحاجة بتشترك في طلب واحد، ووقت البث الحي الأرقام اللي السيرفر بيحسبها (قيمة المحفظة، اتساع السوق، الأكثر حركة) بتتقري مرة كل دقيقة بدل كل 15 ثانية. الأسعار نفسها لسه بتتحرك مع كل صفقة.
- A stock the data feed cannot give no longer stops the market-data update. The others are updated, a note says how many were set aside and why, and the feed is asked for them again in half an hour (Settings, Connections shows the same).
  عربي: السهم اللي مصدر البيانات مش بيرجّعه ما بقاش يوقّف تحديث بيانات السوق. باقي الأسهم بتتحدّث، وبتظهر ملاحظة بعدد الأسهم اللي اتأجلت والسبب، والمصدر بيتسأل عنها تاني بعد نص ساعة (ونفس الكلام ظاهر في Settings ثم Connections).
- When the data feed refuses the sign-in for being asked too often, the app waits as long as the feed asks instead of trying again with every request, so live prices come back sooner.
  عربي: لما مصدر البيانات يرفض تسجيل الدخول علشان الطلبات كتير، التطبيق بيستنى المدة اللي المصدر طالبها بدل ما يحاول مع كل طلب، فالأسعار الحية بترجع أسرع.

## 0.5.0 · 2026-11-16 · The app watches, and wakes the assistant only when needed
For: everyone
Open: /alerts
عربي: التطبيق هو اللي يراقب، ويصحّي المساعد وقت اللزوم بس

- An alert can now wake the assistant: tick "Also wake the assistant" on the Alerts page, or let the assistant set its own watches. The app does the watching itself, in code and at no cost; when one fires, the assistant makes a short review of that event alone.
  عربي: التنبيه بقى يقدر يصحّي المساعد: علّم على «Also wake the assistant» في صفحة Alerts، أو سيب المساعد يحط مراقباته بنفسه. التطبيق هو اللي بيراقب بالكود ومن غير أي تكلفة، ولما التنبيه يشتغل المساعد بيعمل مراجعة قصيرة للحدث ده بس.
- A new autopilot schedule, "When a watch fires": the review after each close, plus a short one whenever something it watches for happens. It costs far less than a review every so many minutes (Settings, Assistant).
  عربي: جدول جديد للطيار الآلي «When a watch fires»: مراجعة بعد كل إغلاق، ومراجعة قصيرة كل ما حاجة بيراقبها تحصل. أرخص بكتير من مراجعة كل كام دقيقة (Settings ثم Assistant).
- A new kind of alert: a time of day, Cairo time. Use it to be told, or to have the assistant look again, at a set time.
  عربي: نوع تنبيه جديد: ميعاد في اليوم بتوقيت القاهرة، علشان يفكّرك أو يخلّي المساعد يبص تاني في وقت محدد.
- The assistant now hands mechanical work to the app (stop-losses, automatic paper runs, alerts, watches) instead of looking again and again.
  عربي: المساعد بقى يسيب الشغل الآلي للتطبيق (وقف الخسارة، التشغيل الآلي الورقي، التنبيهات، المراقبة) بدل ما يراجع كل شوية.

## 0.5.0 · 2026-11-16 · Alerts reach your phone, also with the app closed
For: owner
Open: /alerts
عربي: التنبيهات بتوصل موبايلك، حتى والتطبيق مقفول

- With "Running without the app open" switched on, the server checks your alerts every minute during the session, and the devices you turned notifications on for are told when one fires.
  عربي: لو «Running without the app open» شغّال، السيرفر بيفحص تنبيهاتك كل دقيقة وقت الجلسة، والأجهزة اللي مفعّل عليها الإشعارات بيوصلها إشعار لما تنبيه يشتغل.
- When automatic orders sell a position at its stop-loss or take-profit, the assistant is woken to look at what is left, in the schedules that wake it.
  عربي: لما الأوامر الآلية تبيع مركز عند وقف الخسارة أو جني الربح، المساعد بيتصحّى يراجع الباقي، في الجداول اللي بتصحّيه.

## 0.4.0 · 2026-11-16 · More control over the assistant
For: everyone
Open: /settings?tab=assistant
عربي: تحكّم أكتر في المساعد

- What it costs: next to the daily ceiling (USD 5) there is now a monthly one (USD 60 unless you change it), and Settings, Assistant shows what was spent today (conversations and its own reviews apart), this month and over the last seven days.
  عربي: التكلفة: جنب السقف اليومي (5 دولار) بقى فيه سقف شهري (60 دولار لحد ما تغيّره)، وصفحة Settings ثم Assistant بتعرض المصروف النهارده (المحادثات والمراجعات الآلية كل واحدة لوحدها)، والشهر ده، وآخر 7 أيام.
- How it answers: choose the language it always answers in, and write standing instructions it follows in every conversation and review.
  عربي: طريقة الرد: اختار اللغة اللي يرد بيها دايمًا، واكتب تعليمات ثابتة يمشي عليها في كل محادثة ومراجعة.
- Autopilot: set the most reviews in one day, and choose whether your devices are told when a review changed something. If a ceiling holds a review back, you are told once.
  عربي: الطيار الآلي: حدد أقصى عدد مراجعات في اليوم، واختار يوصلك إشعار لما مراجعة تغيّر حاجة ولا لأ. ولو سقف منع مراجعة، بيوصلك تنبيه مرة واحدة.
- What a day of the autopilot can cost is shown on the same page: how many reviews your schedule asks for, and what a review has cost you on average. The ceilings now hold in the middle of a piece of work too.
  عربي: نفس الصفحة بتعرض الطيار الآلي ممكن يكلّف كام في اليوم: عدد المراجعات اللي جدولك بيطلبها، ومتوسط تكلفة المراجعة عندك. والسقف بقى بيتطبق كمان في نص الشغل، مش في أوله بس.

## 0.4.0 · 2026-11-16 · Daily money limits for the assistant on the real account
For: owner
Open: /settings?tab=real
عربي: حدود يومية بالفلوس للمساعد على الحساب الحقيقي

- Automatic orders have a new limit: the most it may buy in one day, in EGP (Settings, Real trading, Automatic orders).
  عربي: الأوامر الآلية بقى ليها حد جديد: أقصى مبلغ يشتري بيه في اليوم بالجنيه (Settings ثم Real trading ثم Automatic orders).
- You choose how many real-order proposals the assistant may write in one day, down to none at all (Settings, Assistant, Real money).
  عربي: إنت اللي بتحدد عدد اقتراحات الأوامر الحقيقية اللي المساعد يكتبها في اليوم، ولحد صفر (Settings ثم Assistant ثم Real money).

## 0.3.0 · 2026-11-16 · What's new: every update is shown here
For: everyone
عربي: «الجديد»: كل تحديث بيظهر هنا

- After an update, the app shows what changed the first time you open it. The whole list stays under "What's new" in the menu.
  عربي: بعد أي تحديث، التطبيق بيعرض اللي اتغيّر أول ما تفتحه. والقايمة كلها موجودة تحت «What's new» في القايمة الجانبية.
- The assistant reads the same list: ask it "what is new?", in Arabic or English.
  عربي: المساعد بيقرا نفس القايمة: اسأله «إيه الجديد؟» بالعربي أو بالإنجليزي.

## 0.3.0 · 2026-11-16 · Automatic real orders, inside a box you set
For: owner
Open: /settings?tab=real
عربي: أوامر حقيقية آلية، جوه صندوق إنت اللي بتحدده

- You can approve in advance: a real order the assistant proposes is sent without asking you, if it fits your box (the stocks you name, the most per order, buys per day, a budget, and a stop-loss on every buy). Everything else still waits for your approval.
  عربي: تقدر تدّي موافقة مسبقة: الأمر الحقيقي اللي يقترحه المساعد بيتبعت من غير ما يسألك لو كان جوه صندوقك (الأسهم اللي تسميها، أقصى قيمة للأمر، عدد أوامر الشراء في اليوم، ميزانية، ووقف خسارة مع كل شراء). أي حاجة تانية بتفضل مستنية موافقتك.
- The switch is locked until three real orders you approved yourself were accepted by the broker and at least one of them filled.
  عربي: زرار التشغيل مقفول لحد ما 3 أوامر حقيقية وافقت عليها بنفسك يتقبلوا عند السمسار وواحد منهم على الأقل يتنفذ.
- The budget is the most it can lose: what it has lost so far comes off it.
  عربي: الميزانية هي أقصى خسارة ممكنة: أي خسارة بتتخصم منها.
- The app watches what it bought and sells it at its stop-loss or take-profit. The stop is the app's, not the broker's, and shares that have not settled (usually two sessions) cannot be sold yet.
  عربي: التطبيق بيتابع اللي اشتراه ويبيعه عند وقف الخسارة أو جني الربح. وقف الخسارة عند التطبيق مش عند السمسار، والأسهم اللي لسه ما اتسوّتش (غالبًا جلستين) ما تتباعش.
- Whether a proposal goes out by itself is decided once, when it is written, and shown on it. "Stop automatic orders" on the Real account page stops everything at once.
  عربي: الاقتراح بيتحدد وقت كتابته: يا يتبعت لوحده يا يستناك، ومكتوب عليه. وزرار «Stop automatic orders» في صفحة الحساب الحقيقي بيوقف كل حاجة فورًا.

## 0.3.0 · 2026-11-16 · Running with the app closed, and notifications
For: owner
Open: /settings?tab=real
عربي: التشغيل والتطبيق مقفول، والإشعارات

- Automatic orders can keep running with the app closed: the server looks once a minute during the session. Set it up in Settings, Real trading, "Running without the app open": create a background key, add it to the server's settings, then switch it on.
  عربي: الأوامر الآلية تقدر تكمّل والتطبيق مقفول: السيرفر بيتابع مرة كل دقيقة وقت الجلسة. الإعداد من Settings ثم Real trading ثم «Running without the app open»: اعمل مفتاح الخلفية، ضيفه في إعدادات السيرفر، وبعدها شغّله.
- Turn on notifications on a phone or a computer, and it is told when an automatic order is sent, when a stop-loss sells, or when you are needed. On an iPhone, install the app to the Home Screen first.
  عربي: فعّل الإشعارات على الموبايل أو الكمبيوتر، وهيوصلك إشعار لما أمر آلي يتبعت، أو وقف خسارة يبيع، أو لما يحتاجك. على آيفون سطّب التطبيق على الشاشة الرئيسية الأول.
- If the server stops looking during the session, the app says so on the Real account page.
  عربي: لو السيرفر وقف عن المتابعة وقت الجلسة، التطبيق بيقولك في صفحة الحساب الحقيقي.

## 0.2.0 · 2026-11-15 · Real orders, sent only when you approve each one
For: owner
Open: /account
عربي: أوامر حقيقية، بتتبعت بس لما توافق على كل أمر

- Prepare a real order on the Real account page, or let the assistant propose one. Nothing reaches the broker until you read the last look and press Send.
  عربي: جهّز أمر حقيقي من صفحة الحساب الحقيقي، أو خلّي المساعد يقترحه. مفيش حاجة بتوصل للسمسار غير لما تقرا المراجعة الأخيرة وتضغط Send.
- Real orders are off until you switch them on in Settings, Real trading, after writing your limits. Limit orders for the day only.
  عربي: الأوامر الحقيقية مقفولة لحد ما تشغّلها من Settings ثم Real trading بعد ما تكتب حدودك. أوامر بسعر محدد ولليوم بس.

## 0.2.0 · 2026-11-15 · Your real brokerage account, on its own page
For: owner
Open: /account
عربي: حسابك الحقيقي عند السمسار، في صفحة لوحده

- The Real account page shows cash, holdings, the shares free to sell and the broker's prices next to the app's, with checks on the reading. It is separate from the paper portfolio.
  عربي: صفحة Real account بتعرض الكاش، المراكز، الأسهم المتاحة للبيع، وأسعار السمسار جنب أسعار التطبيق، مع فحوصات على القراءة. وهي منفصلة عن المحفظة الورقية.

## 0.2.0 · 2026-11-15 · Install the app on your phone
For: everyone
عربي: سطّب التطبيق على موبايلك

- "Install app" in the menu puts EGX Intelligence on your Home Screen, where it opens like any other app.
  عربي: «Install app» في القايمة بيحط EGX Intelligence على الشاشة الرئيسية ويفتح زي أي تطبيق.
