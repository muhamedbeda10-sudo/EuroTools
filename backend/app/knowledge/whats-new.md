# What's new in EGX Intelligence
The app's release notes, newest first: what changed in each version, for whom, and where to find it. The app shows the same list to its users after an update.

## 0.8.0 · 2026-11-18 · A radar: the app watches the live prices for the assistant and wakes it for what matters
For: everyone
Open: /settings?tab=assistant
عربي: رادار: التطبيق بيراقب الأسعار الحية للمساعد ويصحّيه للمهم بس

- Settings → Assistant has a new card, "Radar". During the session the app now goes over the live prices for the assistant by itself, once a minute, in code and at no cost. Until now the assistant heard only of the watches it or you had set.
  عربي: في Settings → Assistant فيه كارت جديد «Radar». وقت الجلسة التطبيق بقى يمرّ على الأسعار الحية للمساعد لوحده، مرة كل دقيقة، بالكود ومن غير تكلفة. قبل كده المساعد كان بيعرف بس بالمراقبات اللي هو أو انت حطيتوها.
- Your own stocks are watched closely: what the paper portfolio holds, the watchlist and, for the brokerage account's owner, the real holdings and the automatic box. With "My stocks and the whole market" every other listed stock is watched loosely, for what is large enough to be an opportunity or a sign that the market itself is moving.
  عربي: أسهمك بتتراقب عن قرب: اللي في المحفظة الورقية، وقائمة المتابعة، ولصاحب حساب الوساطة الأسهم الحقيقية وأسهم الصندوق التلقائي. ومع «My stocks and the whole market» باقي الأسهم المدرجة بتتراقب بحدود أوسع، للحركة الكبيرة اللي تبقى فرصة أو علامة إن السوق كله بيتحرك.
- What it looks for: a sharp move on the day (3% for your stocks and again at each further 3%, 7% for the rest), volume far above the 20-session average, a break of the recent high or low, and a holding within 1.5% of its stop-loss or take-profit. You can change these figures on the card. Each is said once in a session.
  عربي: بيدوّر على: حركة حادة في اليوم (٣٪ لأسهمك وتاني عند كل ٣٪ زيادة، و٧٪ لباقي السوق)، وحجم تداول أعلى بكتير من متوسط ٢٠ جلسة، وكسر القمة أو القاع الأخير، وسهم عندك قرّب ١٫٥٪ من وقف الخسارة أو جني الربح. تقدر تغيّر الأرقام دي من الكارت. وكل حاجة بتتقال مرة واحدة في الجلسة.
- A small model (Claude Haiku) sorts what the radar found first, with your brief and your holdings in front of it, and the model that trades is woken only for what is worth it. A sort costs a fraction of a cent. What it sets aside is not lost: the next full review is told of it. You can switch the sort off; then every find wakes the model that trades.
  عربي: موديل صغير (Claude Haiku) بيفرز اللي الرادار لقاه الأول، وقدامه تعليماتك وأسهمك، والموديل اللي بيتداول بيصحى بس للّي يستاهل. الفرزة بتكلّف جزء من السنت. واللي بيتركن مابيضيعش: المراجعة الكاملة الجاية بتتبلّغ بيه. وتقدر تقفل الفرز؛ ساعتها كل حاجة الرادار يلاقيها بتصحّي موديل التداول.
- The radar is on by default and wakes the assistant with the schedules "When something happens" (the new name of "When a watch fires") and "During the session too". So with one of those schedules it may now be woken more often than before, always inside the most reviews in one day and the spending ceilings you set. With "After each close" its finds are told to that review; to stop it, switch it off on the card.
  عربي: الرادار شغال افتراضيًا وبيصحّي المساعد مع جدول «When something happens» (الاسم الجديد لـ «When a watch fires») وجدول «During the session too». يعني مع أي جدول منهم ممكن يصحى أكتر من الأول، ودايمًا جوه أقصى عدد مراجعات في اليوم وسقف الصرف اللي انت حاططهم. ومع «After each close» اللي بيلاقيه بيتقال للمراجعة دي؛ ولو عايز توقفه اقفله من الكارت.
- "What it found lately", on the same card, lists each thing the radar saw and what became of it: whether the assistant was woken, and why. "What it was used for" has a fourth line, "Sorting what the radar found", and the checklist "What is in place" has a line for the radar.
  عربي: «What it found lately» في نفس الكارت بيعرض كل حاجة الرادار شافها وإيه اللي حصل فيها: المساعد اتصحّى ولا لأ، وليه. و«What it was used for» بقى فيها سطر رابع «Sorting what the radar found»، وقائمة «What is in place» بقى فيها سطر للرادار.
- When the app carries out a stop-loss or take-profit on the paper portfolio, the assistant is now told at once, in the schedules that wake it, as it already was for the automation's sales on the real account.
  عربي: لما التطبيق ينفّذ وقف خسارة أو جني ربح على المحفظة الورقية، المساعد بقى يتبلّغ فورًا في الجداول اللي بتصحّيه، زي ما كان بيحصل مع بيع الأوامر التلقائية على الحساب الحقيقي.
- What it cannot do: it sees the market once a minute, not every trade, and only with the live feed. With the app closed it runs only for the brokerage account's owner who switched on "Running without the app open". It decides nothing itself: what the assistant may do when woken is still bounded by your limits.
  عربي: اللي مايقدرش عليه: بيشوف السوق مرة كل دقيقة مش كل صفقة، وبس مع الأسعار الحية. والتطبيق مقفول بيشتغل بس لصاحب حساب الوساطة اللي مشغّل «Running without the app open». وهو مابياخدش أي قرار: اللي المساعد يقدر يعمله لما يصحى لسه محكوم بحدودك.
- You can ask the assistant "what did the radar see today?" or "why did you not wake up for this move?": it reads the same list.
  عربي: وتقدر تسأل المساعد «الرادار شاف إيه النهارده؟» أو «ليه ماصحيتش للحركة دي؟»: هو بيقرا نفس القائمة.

## 0.7.2 · 2026-11-17 · Choose the model that trades by itself apart from the one you talk to
For: everyone
Open: /settings?tab=assistant
عربي: اختار الموديل اللي بيتداول لوحده لوحده، والموديل اللي بتكلمه في الشات لوحده

- Settings → Assistant → Model and cost now has two choices instead of one: "Model you talk to", which answers in your conversations, and "Model that trades by itself", which runs the reviews the assistant makes by itself and decides the trades in them.
  عربي: في Settings → Assistant → Model and cost بقى فيه اختيارين بدل واحد: «Model you talk to» وده اللي بيرد عليك في المحادثات، و«Model that trades by itself» وده اللي بيعمل المراجعات اللي المساعد بيعملها لوحده وبياخد قرارات التداول فيها.
- Nothing changes until you choose: the model that trades starts as "Same as the model you talk to". Pick a stronger one for trading and a cheaper one for everyday questions, or the other way round; each use is costed at its own model's price.
  عربي: مفيش حاجة بتتغير غير لما تختار: موديل التداول بيبدأ على «Same as the model you talk to». تقدر تختار موديل أقوى للتداول وموديل أرخص للأسئلة اليومية، أو العكس؛ وكل استخدام بيتحسب بسعر الموديل بتاعه.
- You can also change the model you talk to from the assistant's panel itself: the list at the bottom, beside what it may do. It applies from your next message.
  عربي: وتقدر كمان تغيّر الموديل اللي بتكلمه من لوحة المساعد نفسها: القائمة اللي تحت، جنب صلاحياته. بيتطبق من رسالتك الجاية.
- A review the assistant made by itself stays on the trading model, also when you open it and reply in it; the top of the panel says which model the open conversation runs on.
  عربي: المراجعة اللي المساعد عملها لوحده بتفضل على موديل التداول، حتى لو فتحتها ورديت جواها؛ وأعلى اللوحة بيقولك المحادثة المفتوحة شغالة على أنهي موديل.
- "How much it thinks" is one setting for both models. If the key cannot use the model chosen for trading, the page says so before a review fails.
  عربي: «How much it thinks» إعداد واحد للموديلين. ولو المفتاح مايقدرش يستخدم الموديل المختار للتداول، الصفحة بتقولك قبل ما مراجعة تفشل.

## 0.7.1 · 2026-11-16 · What the assistant was used for: your questions, its own trading, its monitoring
For: everyone
Open: /settings?tab=assistant
عربي: المساعد اتستخدم في إيه: أسئلتك، وتداوله لوحده، ومراقبته

- Settings → Assistant → Model and cost has a new part, "What it was used for". It shows three things apart: the questions you asked it, the reviews it made by itself (Trading by itself), and the short reviews it was woken for when something it watches happened (Monitoring). For each: how many, what they cost, and its share of the cost.
  عربي: في Settings → Assistant → Model and cost فيه جزء جديد «What it was used for». بيعرض تلات حاجات كل واحدة لوحدها: الأسئلة اللي سألتها له، والمراجعات اللي عملها لوحده (Trading by itself)، والمراجعات القصيرة اللي صحي لها لما حاجة بيراقبها حصلت (Monitoring). ولكل واحدة: العدد، والتكلفة، ونسبتها من إجمالي التكلفة.
- Choose the period at its top: today, the last 7 days, or this month. For today it also says how many reviews it made by itself out of the most you allow in one day.
  عربي: اختار المدة من فوق: النهارده، آخر ٧ أيام، أو الشهر ده. وفي النهارده بيقولك كمان عمل كام مراجعة لوحده من أقصى عدد انت سامح بيه في اليوم.
- A question is counted once, however many steps its answer took. The watching itself is done by the app and costs nothing; only the review that follows a watch costs.
  عربي: السؤال بيتحسب مرة واحدة مهما كانت خطوات إجابته. والمراقبة نفسها التطبيق هو اللي بيعملها ومابتكلفش حاجة؛ اللي بيكلف هو المراجعة اللي بتيجي بعد ما المراقبة تشتغل.
- The counting starts with this version. For the days before it the cost is complete, but the questions were not counted and the wake-ups are counted with the reviews; the page says so where it applies.
  عربي: العدّ بيبدأ من الإصدار ده. الأيام اللي قبله تكلفتها كاملة، بس أسئلتها ماكانتش بتتعد والصحيان بعد المراقبة محسوب مع المراجعات؛ والصفحة بتقول كده في المكان اللي ينطبق عليه.
- You can also ask the assistant "how much were you used this month?": it reads the same figures.
  عربي: وتقدر كمان تسأل المساعد «اتستخدمت قد إيه الشهر ده؟»: هو بيقرا نفس الأرقام.

## 0.7.0 · 2026-11-16 · A shorter menu, the assistant trading by itself in one place, and a moving price tape
For: everyone
Open: /settings?tab=assistant
عربي: قائمة أقصر، وتداول المساعد لوحده في مكان واحد، وشريط أسعار متحرك

- The menu is shorter: Dashboard, Market, Portfolio, Real account (its owner only), Strategies, Guide and Settings. The other screens did not go anywhere: they are tabs across the top of the page. Market has Watchlist, Alerts and Research & News; Portfolio has Trades and Journal; Strategies has the Simulator.
  عربي: القائمة بقت أقصر: Dashboard و Market و Portfolio و Real account (لصاحب الحساب بس) و Strategies و Guide و Settings. باقي الشاشات ماراحتش في حتة: بقت تبويبات فوق في الصفحة. Market جواها Watchlist و Alerts و Research & News، و Portfolio جواها Trades و Journal، و Strategies جواها Simulator.
- On a phone there is a bar at the bottom: Home, Market, Portfolio, the assistant, and Menu for everything else.
  عربي: على الموبايل فيه شريط تحت: Home و Market و Portfolio والمساعد، و Menu لباقي الشاشات.
- The strip of figures under the search box now moves like a tape: the indices, breadth, your paper portfolio, then the day's most active stocks, gainers and losers. Tap a stock to open it. It stops while the pointer is on it, and the small button at its start stops it for good.
  عربي: شريط الأرقام اللي تحت البحث بقى بيتحرك زي شريط الأسعار: المؤشرات، واتساع السوق، ومحفظتك الورقية، وبعدها أنشط الأسهم وأكتر الرابحين والخاسرين في اليوم. دوس على أي سهم يفتحه. بيقف طول ما الماوس عليه، والزرار الصغير في أوله بيوقفه خالص.
- Settings opens on the assistant, and has five tabs instead of seven: Assistant, Real trading, Paper & fees, Market data, and Accounts & log.
  عربي: صفحة Settings بتفتح على المساعد، وبقت خمس تبويبات بدل سبعة: Assistant و Real trading و Paper & fees و Market data و Accounts & log.
- "Trading by itself" is now one card at the top of Settings → Assistant. Choose what the assistant works on by itself (nothing, the paper portfolio, and for the brokerage account's owner the real account or both) and when it reviews. Under it, "What is in place" lists every step with a mark: what is ready, what is still missing, and a button that takes you to where it is set.
  عربي: «Trading by itself» بقت كارت واحد في أول Settings → Assistant. اختار المساعد يشتغل لوحده على إيه (ولا حاجة، المحفظة الورقية، ولصاحب حساب الوساطة الحساب الحقيقي أو الاتنين) وبيراجع إمتى. وتحتها «What is in place» قائمة بكل خطوة وعلامتها: إيه اللي جاهز، وإيه اللي لسه ناقص، وزرار يوديك للمكان اللي بتتظبط منه.
- Nothing about what the assistant may do has changed. It still trades by itself only with Full access, inside your limits and your spending ceilings, and a real order still goes out only on your approval or inside the automatic box you set. The assistant cannot take any of these steps for you; ask it "why are you not trading by yourself?" and it tells you which one is missing.
  عربي: مفيش حاجة اتغيرت في اللي المساعد مسموح له بيه. لسه بيتداول لوحده بس مع Full access وجوه حدودك وسقف المصاريف، والأمر الحقيقي لسه مابيطلعش غير بموافقتك أو جوه الصندوق الآلي اللي انت محدده. والمساعد مايقدرش ياخد أي خطوة من دول بدالك؛ اسأله «ليه مش بتتداول لوحدك؟» وهو يقولك إيه الناقص.
- For the brokerage account's owner with "Running without the app open" switched on: the server now also carries out the stop-loss and take-profit orders of the paper portfolio and brings the automatic paper runs up to date, every minute during the session, with the app closed. Your devices are told when one is filled. Until now these waited for the app to be opened.
  عربي: لصاحب حساب الوساطة اللي مشغّل «Running without the app open»: السيرفر بقى كمان ينفّذ أوامر وقف الخسارة وجني الأرباح بتاعة المحفظة الورقية ويحدّث التشغيل الآلي الورقي، كل دقيقة وقت الجلسة والتطبيق مقفول. وأجهزتك بيوصلها إشعار لما أمر يتنفذ. قبل كده الحاجات دي كانت بتستنى لما التطبيق يتفتح.

## 0.6.2 · 2026-11-16 · The price now, beside the price of each trade
For: everyone
Open: /trades
عربي: السعر الحالي جنب سعر كل صفقة

- The ledger in Trades has a new column, "Now": the stock's latest price beside the price you bought or sold at, and under it how far it has moved since that trade, in per cent. While the market is open it follows the live price.
  عربي: دفتر الصفقات في Trades بقى فيه عمود جديد «Now»: آخر سعر للسهم جنب السعر اللي اشتريت أو بعت بيه، وتحته نسبة تحرّكه من وقت الصفقة. وطول ما السوق مفتوح بيمشي مع السعر الحي.
- The move is of the price alone, before fees. On a buy, green means the shares are worth more than you paid; on a sell, green means the stock went up after you sold.
  عربي: النسبة دي للسعر بس، قبل المصاريف. في الشراء الأخضر معناه إن الأسهم بقت أغلى من اللي دفعته؛ وفي البيع الأخضر معناه إن السهم طلع بعد ما بعت.
- On a narrower window the "Value" column steps aside to make room for it. The value is still in each entry's details (the arrow at the end of the row).
  عربي: على الشاشة الأضيق عمود «Value» بيتشال علشان يفسح مكان. القيمة لسه موجودة في تفاصيل كل قيد (السهم اللي في آخر الصف).
- The CSV export has the same figures as they were when the file was made, and the assistant sees them when it reads your trades. Nothing in the ledger itself changed.
  عربي: ملف الـ CSV فيه نفس الأرقام زي ما كانت وقت عمل الملف، والمساعد بيشوفها لما يقرا صفقاتك. والدفتر نفسه ماتغيّرش فيه حاجة.

## 0.6.1 · 2026-11-16 · Your data moved to a new database
For: everyone
عربي: بياناتك اتنقلت لقاعدة بيانات جديدة

- This morning the old database (Firebase) ran out of its daily allowance and the app stopped for a few minutes. Your data now lives in a database of the app's own (Postgres), which has no daily allowance.
  عربي: النهارده الصبح قاعدة البيانات القديمة (Firebase) خلّصت حصتها اليومية والتطبيق وقف كام دقيقة. بياناتك بقت في قاعدة بيانات خاصة بالتطبيق (Postgres) ومالهاش حصة يومية.
- There is nothing for you to do. The first time you open the app after this update it brings your data over by itself, checks that every record arrived exactly as it was, and carries on. That first screen can take a few seconds longer.
  عربي: مش مطلوب منك أي حاجة. أول مرة تفتح التطبيق بعد التحديث بينقل بياناتك لوحده، ويتأكد إن كل سجل وصل زي ما هو بالظبط، ويكمّل. أول شاشة ممكن تاخد كام ثانية زيادة.
- Signing in is the same, with the same email and password. The old copy of your data is kept, closed to changes.
  عربي: تسجيل الدخول زي ما هو بنفس الإيميل وكلمة السر. والنسخة القديمة من بياناتك محفوظة ومقفولة للتعديل.
- If the app shows old figures or cannot save, it was opened from an old address. Open it from euro-tools-delta.vercel.app, and install it again from there if you had it on your phone.
  عربي: لو التطبيق عارض أرقام قديمة أو مش بيحفظ، يبقى مفتوح من عنوان قديم. افتحه من euro-tools-delta.vercel.app، ولو منزّله على الموبايل نزّله تاني من هناك.

## 0.6.0 · 2026-11-16 · You choose which account the autopilot works on
For: owner
Open: /settings?tab=assistant
عربي: إنت اللي بتختار الطيار الآلي يشتغل على أنهي حساب

- The autopilot has a new choice, "Which account it works on" (Settings, Assistant, Autopilot): the paper portfolio only, the real account only, or both.
  عربي: الطيار الآلي بقى فيه اختيار جديد «Which account it works on» (Settings ثم Assistant ثم Autopilot): المحفظة التجريبية (الورقية) بس، أو الحساب الحقيقي بس، أو الاتنين.
- Paper portfolio only: it manages the paper portfolio, and in its own reviews it writes no proposal for a real order, whatever your instructions say. The app itself refuses it.
  عربي: المحفظة التجريبية بس: بيدير المحفظة الورقية، وفي مراجعاته مابيكتبش أي اقتراح لأمر حقيقي مهما كانت تعليماتك. التطبيق نفسه هو اللي بيرفض.
- Real account only: its reviews are about your real account. It reads the cash and the holdings from the broker and writes proposals for real orders inside your limits, and it leaves the paper portfolio as it is.
  عربي: الحساب الحقيقي بس: مراجعاته بتبقى عن حسابك الحقيقي. بيقرا الكاش والأسهم من الوسيط وبيكتب اقتراحات أوامر حقيقية جوه حدودك، وبيسيب المحفظة التجريبية زي ما هي.
- How a real order goes out has not changed: a proposal waits for your approval, and is sent by itself only when automatic orders are on and it fits the box you set.
  عربي: طريقة خروج الأمر الحقيقي ماتغيّرتش: الاقتراح بيستنى موافقتك، ومابيتبعتش لوحده إلا لو الأوامر الآلية شغّالة وهو جوه الصندوق اللي إنت محدده.
- Until you choose, it stays on "Both", which is how it worked before: the paper portfolio, plus proposals for real orders only when your instructions ask for them.
  عربي: لحد ما تختار، بيفضل على «Both» زي ما كان شغّال قبل كده: المحفظة التجريبية، ومعاها اقتراحات أوامر حقيقية بس لما تعليماتك تطلب كده.
## 0.5.2 · 2026-11-16 · Plain words when a service refuses, and far fewer database reads
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
## 0.5.1 · 2026-11-16 · Price depth shows what the feed really sends
For: everyone
عربي: «Price depth» بيعرض اللي التغذية بتبعته فعلًا

- The market-data feed sends the best bid and the best ask with their sizes, and the shares waiting on each side in total. It sends no price levels behind them. The panel on the stock page used to draw an empty chart and a one-row table as if the rest were missing by mistake; it now shows the best prices, the spread and buyers against sellers, and says that the other levels do not reach the app.
  عربي: تغذية البيانات بتبعت أفضل طلب وأفضل عرض بكمياتهم، وإجمالي الأسهم المنتظرة في كل ناحية، ومش بتبعت مستويات الأسعار اللي وراهم. اللوحة في صفحة السهم كانت بترسم شارت فاضي وجدول بسطر واحد كأن الباقي ناقص بالغلط؛ دلوقتي بتعرض أفضل الأسعار والفرق بينهم ونسبة المشترين للبائعين، وبتقول إن باقي المستويات مش بتوصل للتطبيق.
- The assistant is told the same, so it does not speak of sizes at prices it cannot see.
  عربي: المساعد اتبلّغ بنفس الكلام، فمش هيتكلم عن كميات عند أسعار مش شايفها.

## 0.5.1 · 2026-11-16 · Automatic exits: what the app said about their price is corrected
For: owner
Open: /settings?tab=real
عربي: الخروج الآلي: تصحيح الكلام المكتوب عن سعر البيع

- Nothing changes in what the app does; what it said was wrong. A stop-loss or take-profit sale was described as priced "a few levels into the bids". The feed sends the best bid alone, so the sale is priced at the best bid, inside your price band. One that does not fill is still cancelled and priced again, up to six times a day.
  عربي: مفيش تغيير في اللي التطبيق بيعمله؛ الكلام المكتوب هو اللي كان غلط. بيع وقف الخسارة أو جني الربح كان مكتوب إنه بيتسعّر «كام مستوى جوه الطلبات». التغذية بتبعت أفضل طلب بس، فالبيع بيتسعّر على أفضل طلب، جوه نطاق السعر بتاعك. واللي ما يتنفذش لسه بيتلغي ويتسعّر تاني، لحد 6 مرات في اليوم.

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
