# EGX Intelligence

Personal Egyptian Exchange (EGX) analysis and **paper-trading** workspace.

> Trading here is on paper. One thing is real and fenced off: the owner of the brokerage account can
> look at it, and can send a **real order they approved themselves**, one at a time. It is off unless
> switched on twice (server and owner). The owner may go one step further and approve in advance
> what fits a box they set (**automatic orders**, locked until hand-approved orders have worked),
> and may let the server keep taking those looks with the app closed (**background running**).
> Nothing else in this codebase reaches a broker.
> The app ships with **synthetic sample prices** (clearly labelled in the UI) until real
> history is imported by CSV or a data feed is connected.

## What is in this release

| Screen | Contents |
| --- | --- |
| Dashboard | Indices, breadth, movers (re-ranked live), paper portfolio (gross vs net), watchlist, signals, latest research, data status |
| Market & Categories | Sector performance, all stocks, search/filters, custom categories |
| Stock analysis | Candles (D/W/M), SMA 20/50/200, RSI, MACD, support/resistance, candle patterns (marked on the chart and listed with status and level), live price and price depth (best bid and ask, spread, buyers against sellers), related research, simulated order ticket |
| Watchlist | Tracked stocks |
| Portfolio | Cash, holdings, stock/sector allocation, concentration warnings, value vs benchmark |
| Real account | The owner's brokerage account: cash, holdings, shares free to sell, broker price next to the app's price, checks on the reading; real orders, each sent on the owner's approval; and automatic orders (what fits the owner's box, with stop-losses watched by the app, and a one-tap stop). Owner only |
| Trades & Transactions | Append-only ledger, per-trade fee breakdown, gross vs net profit, the price now beside each trade's price with the move since, CSV export |
| Strategy Management | Strategy library (MA crossover, RSI reversion, MACD, breakout, candlestick reversal), risk limits |
| Strategy Simulator | Historical backtest, side-by-side comparison of strategies, automatic paper trading |
| Research & News | Your own library of links and notes, tied to stocks, sectors and strategies, with impact, reliability and a verified flag |
| Journal | Why each decision was made, what was expected, what happened, what was learned |
| Alerts | Price, day change, volume, RSI, strategy-signal and time-of-day alerts, shown in the app and as notifications; an alert can wake the assistant |
| Guide | Indicators, candle patterns, price depth, financial statements and ratios, disclosures, risk, fees, sectors, testing a strategy |
| Settings | Fee schedule, starting capital, CSV data import, accounts (administrators), connections, audit trail |

Not built yet: fundamentals (no verified source), corporate actions.

## How it is hosted

One Vercel project serves everything from this repository:

- the web app (Next.js static export, repository root),
- the API (`backend/`, FastAPI) as a Python function behind `/api/*`.

The data is in a Postgres database (Supabase), named to the server by `DATABASE_URL` (a connection
string, Sensitive, in the server's environment only): each account's documents, the market prices
all accounts share, and the record of who may use the app and who administers it (`egx.accounts`).
Sign-in uses Firebase Authentication of the existing project (`eurotools-a1ea6`): email and
password, accounts created by an administrator from Settings.

Until 16 November 2026 the data was in Firestore too, one private tree per account under
`egx/{uid}/`, read and written with the caller's own token so that `firestore.rules` decided
everything and the server held no credentials. Firestore's daily allowance, shared with the
quality system, stopped the app that morning, and the owner had the data moved. That tree is
still there, closed to writing by the rules, as the copy each account is brought over from. Deployed,
the server asks Firestore nothing (`MIGRATE_FROM_FIRESTORE=false` in `api/index.py`, set the same
day once the owner's data and the market prices had come over): an account the database has no row
for is not let in, and one whose data was left in Firestore is refused with a plain message rather
than given an empty account. Setting it to `true` brings such an account over on its next visit.
Pushing a change to `firestore.rules` publishes the rules through `.github/workflows/rules.yml`;
that workflow never touches Firebase Hosting. `STORE_BACKEND=firestore` runs the API on Firestore
as before (`backend/app/store/firestore_store.py`).

### The Postgres backend

`backend/app/store/postgres_store.py`. With a database the server opens itself, the server decides
what Firestore's rules used to decide:

- **The server verifies each sign-in itself** (`backend/app/identity.py`): the token's signature
  against Google's published keys, that it is for this project, and that it has not expired. Then
  the account's row in `egx.accounts` says whether it may use the app (read at most once a minute,
  so closing an account takes effect within a minute). An account with no row yet is looked up
  once in the records Firestore held (`egxAccounts`, or `users` of the quality system), with the
  caller's own token, and what is found becomes its row; an administrator's first visit brings the
  whole list. Opening and closing accounts (`backend/app/accounts.py`, `PgAccounts`) is then a
  matter of that table, and only a row marked `admin` may do it.
- **The server holds the database's password.** Every statement is tied to the verified account;
  there is none that reads another account's rows. The ledger and the audit trail are append-only
  in the table itself: a trigger refuses any change or removal, whoever asks.
- **Tables** live in the schema `egx` (not exposed by Supabase's Data API), are created by the
  server the first time it connects, and have row level security on with no policy.
- **Data comes over by itself** (`backend/app/store/migrate.py`): the first time a person uses the
  app, their Firestore data is read with their own sign-in, written in one transaction, read back
  and compared; only an identical copy is kept. Firestore is only read.
- `GET /health?probe=true` says whether a database named in `DATABASE_URL` can be reached, before
  it is switched to.

Tests: `TEST_DATABASE_URL=postgresql://... pytest tests/test_postgres.py tests/test_identity.py
tests/test_migrate.py` (skipped without a database).

## Market data (Younit)

When `YOUNIT_TRADING_ID` and `YOUNIT_API_KEY` are set on the server, prices come from the
Younit (EFG Hermes) API instead of the synthetic sample: the EGX stock list and daily
history, **read-only**. The same connection reads the owner's account and carries their real
orders (the two sections below). The credentials stay on the server; they are never sent to the
browser, logged or committed.

Prices are the same for every account, so they are stored once (the table `egx.market`,
compressed). The first page load of the day pulls the update in short batches, and
Settings → Connections has a manual update button. The feed provides no sector and no index
series: known symbols keep the seed list's sector, others show as "Unclassified", and index
figures are simply not shown.

A stock whose history the feed does not give (an empty or unreadable answer) is noted in the index
(`tried`) and asked for again after 30 minutes. It is counted as `failed`, not as `remaining`, so it
neither stops the update for the stocks after it nor is requested again on every page load. A sign-in
the feed refuses (429) is not repeated until the pause it asked for is over.

### Database reads

Firestore counts every document read, and each request's security-rule lookups, against the
project's daily allowance (50,000 reads on the free plan, shared with everything else in the
project). When it is used up Firestore answers 429 and the API answers **503** with a sentence that
says so (`store/errors.py`), not a 500. What keeps the count down:

- the shared `egxMarket/meta` document is read at most once every few seconds per server instance;
- an account's own imports (`instruments`, `bars`) are read once per import (`data_version`), not per request;
- a batch that changed no bars does not move the shared version, so no instance reloads the price tables;
- the browser shares requests for the same path made at the same moment, and while prices stream it
  re-reads the server's figures once a minute instead of every 15 seconds.

## Install on a phone

The site is an installable web app: it opens from the home screen in its own window, with no store
involved and always the deployed version.

- **Android (Chrome):** the browser offers "Install app" by itself, or use the browser menu.
- **iPhone / iPad (Safari):** Share → "Add to Home Screen".
- The menu has an **Install app** entry that opens the browser's offer where there is one and shows
  these steps where there is not. It is hidden inside the installed app.

What makes it installable: `public/manifest.webmanifest`, the icons in `public/icons/` and the tags in
`app/layout.tsx`. `public/sw.js` does one thing: when a page cannot be loaded because the phone is
offline, it shows a "No connection" page, which is written inside the worker itself. It keeps
**nothing on the device**, so a price or a balance is never shown from a saved copy. The installed
app has its own sign-in (once).

## Real account (read-only)

The same credentials open the owner's brokerage account. The **Real account** page reads it and
nothing more (`backend/app/broker.py`; the three GET calls are in `backend/app/data/younit.py`):
account summary, holdings, and the holder's name with a masked account number.

- **Who sees it.** Only the sign-ins named in `BROKER_ACCOUNT_UIDS` on the server (Firebase user
  IDs, comma-separated). Empty means nobody: being an administrator is not enough. Everyone else
  gets no menu entry and a 403 from `GET /api/v1/real-account`. Settings → Market data →
  Connections shows whether the current sign-in may look, and its user ID to copy into the
  variable. A local run without sign-in may look only when the variable contains the word `local`.
- **Nothing is stored.** A reading lives in the server's memory for 20 seconds (a refresh reuses one
  younger than 5), so several looks cost one call to the broker. Nothing is written to Firestore,
  and nothing enters the paper portfolio.
- **Checks on every reading.** The holdings add up to the broker's own total; the total equals cash
  plus stocks; the broker's price for each holding is within 1% of the app's. A failed check is
  shown with what differs.
- **The assistant** can read it for the owner (`real_account`, a read tool). It is told to keep real
  and paper figures apart and that it cannot trade the account. What it reads becomes part of that
  conversation, which is stored in the owner's own data.
- Not read yet: funds as a separate list.

## Real orders (sent only on the owner's approval)

`backend/app/real_orders.py`. An order starts as a **proposal**, written by the owner on the Real
account page or by the assistant. A proposal moves nothing. It reaches the broker in one way only:
the owner opens it, reads the last look, and approves it (`POST /api/v1/real-orders/{id}/approve`).

What stands between a proposal and the exchange, every time:

1. **The owner's sign-in** (`BROKER_ACCOUNT_UIDS`), as for the Real account page.
2. **Two switches.** `LIVE_TRADING_ENABLED` on the server (off unless set), and the owner's own
   switch in Settings → Real trading, which cannot be turned on before the limits are written.
   Either one stops everything at once.
3. **The order's shape.** A listed stock, whole shares, a limit price, for the day. There is no
   market order, no hidden order, no order that outlives the session, and no changing an order
   (cancel it and prepare another).
4. **The owner's limits.** Most for one order, most orders and most value in a day, the stocks
   allowed (optional), and how far the price may sit on the costly side of the market (a buy above
   it, a sell below it).
5. **The broker's own figures, read at that moment.** What can be spent, for a buy; the shares
   free to sell, for a sale; the price range the exchange accepts today.
6. **The session is running.** A proposal written after the close is for the next session, and is
   judged again with that day's figures when it is approved.

**Sent once.** The approval is written first, with the day's lock, so two approvals at the same
moment cannot both go out (the database refuses the stale one). Then one request goes to the
broker. Refused: `rejected`, with the broker's reason. Never left: `failed`. Left and no clear
answer: `unknown`, which is never sent again; the broker's own list is read to find it, and until it
is settled no further order for that stock and side can be approved.

**The assistant** can read real orders and write a proposal with its reasoning (`propose_real_order`),
and take its own proposal back. It has no tool that approves, sends, cancels or changes the limits,
and tests keep it so (`test_the_assistant_can_propose_and_nothing_more`,
`test_orders_reach_the_broker_from_one_place_only`). Its proposals are bound by the same limits and
by a number per day the owner sets in Settings → Assistant (20 by default, 0 for none).

Proposals, orders and what became of them are kept in the owner's own data (`real_orders_YYYYMM`)
and every step is in the activity log. The paper ledger is never written by any of this.

The request sent to the broker is the one the broker's own SDK sends for a day limit order; a test
pins it field by field. **It has not been exercised against the real broker from here** (there is no
test environment): make the first real order a single cheap share and compare it with the EFG
Hermes ONE app.

## Automatic real orders (the owner's standing approval, inside a box)

`backend/app/real_auto.py`. The owner may approve in advance: a proposal **the assistant** writes is
then sent without waiting for them, provided it fits a box they drew in Settings → Real trading →
Automatic orders. It goes out through the same path as a hand-approved order
(`real_orders.send_waiting` → the same checks, day lock and single request), with the box asked
once more at the last moment in the owner's place. Whatever does not fit simply waits for the owner.

- **The box.** Named stocks (required, at most 20); the most for one automatic order; the most
  automatic buys in a day and, optionally, the most it may buy in one day in EGP; a budget; a stop-loss on every buy, no further under its price than the
  owner allows; and a loss for the day at which it stops buying. The owner's own limits for real
  orders apply on top of it.
- **The budget is real.** It is the most the automation may have in the market at once, at cost,
  counting its open buy orders. What it has lost so far comes off it, so it is also the most it can
  lose; a profit does not widen it.
- **Locked until earned.** The switch cannot be turned on before three orders the owner approved
  themselves were accepted by the broker and at least one of them filled. Orders the automation
  sent do not count.
- **Only while the app is open.** Nothing runs on the server by itself. The owner's open app asks
  for a look (`POST /api/v1/real-orders/auto/tick`) twice a minute during the session. Close the
  app, lock the phone or lose the connection, and nothing is sent and **no stop-loss is watched**.
- **Its own book.** What the automation holds is kept apart (`settings/real_auto_book`), built from
  the fills of the orders it sent. It sells only those shares; where the broker shows fewer than the
  book, the book gives way. An order the owner approved by hand never enters it.
- **Two prices must agree.** The app's market data is shared by every account of the app and can
  be written by any of them. So a stop is judged by two readings: the shared feed, and the broker's
  own price for that stock, which the server asks for itself. When they differ by more than 1.5%
  nothing is sold and the owner is told: a wrong figure in the feed can neither sell a position nor
  hide that its stop was reached. A reading stamped in the future is not a reading.
- **Stop-loss and take-profit** are watched by the app, not left at the broker (the API takes day
  limit orders only). When a fresh live price reaches the level, a sale is sent at the best bid,
  inside the owner's price band (the feed sends no bid levels behind the best one; if it ever does,
  the sale goes a few levels into them); one that does not fill is cancelled and priced again; a
  sale in doubt is never followed by another; other orders of the automation's in that stock are
  taken back first (a sale resting above the market, a buy still open); a stop-loss and a
  take-profit keep separate counts, only a sale that reached the broker counts, and after six in a
  day the app stops and says so. Ways out do not use up the owner's daily limits.
  The owner can move a position's levels. A later buy can raise a position's stop, never lower it.
  A stock sold that way is not bought again by the automation the same day. **Shares that have not
  settled cannot be sold** (on EGX usually T+2), so the stop on a fresh purchase may have to wait.
- **Decided once, when it is written.** `real_auto.admit` judges a proposal at the moment the
  assistant writes it and writes the answer on it. Only one that was inside the box then is ever
  sent by itself; one that was told "this waits for the owner" keeps waiting, whatever changes
  later (a new day, a freed budget, a wider box). What was written before the switch was turned
  waits too, and the assistant can mark a proposal to wait (`hold_for_owner`).
- **A stop pressed mid-look wins.** Before each order the look reads the switches afresh, and the
  order is tied to them: they are written back unchanged with the approval, so the database refuses
  the order if one of them changed while it was being checked.
- **Whose shares a sale is.** A sale the assistant writes that the automation's own shares could
  cover is theirs (`of_book`) and comes off the book whoever approves it; a larger one is about the
  owner's own shares and leaves the book alone. An order the owner prepares never touches it.
- **The broker's holdings are believed slowly.** The book gives way only when the account shows
  fewer shares at several looks in a row, with no order of the automation's in that stock still in
  flight and the order list readable: one odd answer, or a sale that filled a moment ago, must not
  make the app forget shares it is watching.
- **One-tap stop** on the Real account page: no further automatic order, the automation's open buys
  are cancelled, and nothing is watched any more. Its shares stay in the account.
- **Two windows at once** (a phone and a computer) cannot send the same order twice: the day lock
  refuses the second approval, and the book carries a revision that refuses a stale write.

The assistant still has no tool that sends, approves or cancels, or that touches the box; it reads
the box (`real_orders`) and is told for each proposal whether it will go out by itself. Tests:
`backend/tests/test_real_auto.py`, and with the Firestore emulator
`test_automatic_orders_are_the_owners_and_two_looks_at_once_send_one_order`.

Like order sending itself, **none of this has been exercised against the real broker from here.**
In particular the broker's words for order states, and how soon bought shares show as free to
sell, are only known from its SDK.

## Running without the app open, and notifications

`backend/app/background.py`, `backend/app/push.py`. Automatic orders run from the owner's open app.
With background running switched on, the server takes the same looks itself, once a minute during
the session, so stop-losses and the box keep working with the app closed and the phone locked.

- **The timer.** `vercel.json` → `crons`: `GET /api/v1/background/look` every minute, Sunday to
  Thursday, over the hours the session can fall in (needs a plan that allows per-minute cron). The
  call is answered only with the platform's secret (`CRON_SECRET`), and does nothing outside the
  session.
- **Whose hands.** The API reads nobody's data without a verified sign-in, and a timer has none. The owner
  lends theirs: Settings → Real trading → *Running without the app open* → *Create a background key*
  seals their sign-in's renewal token with a key only this server can derive, and shows it once.
  The owner adds it to the server's environment as `BACKGROUND_KEY` (Sensitive) and redeploys.
  With it the server signs in as the owner and nobody else, and verifies that sign-in like any other
  before it reads anything, as when the app is open. The key is never accepted from a request, only read from the
  environment; it cannot be opened anywhere else; a new key, or a changed password, retires it.
- **The owner's switch** is in their own data. Off, a look ends before it does anything.
- **A look**: read live prices (or the session's final bars after the close), `real_auto.tick`,
  then the assistant's review when one is due (its own switch and schedule in Settings →
  Assistant), and what the review proposed is judged in the same look.
- **It decides nothing.** What may be sent is still the owner's box and limits, checked at every look.
  After the assistant's review, which can take minutes, everything is read again (the switches
  included) and the prices are read anew before anything more is sent. A review is begun only with
  time for it, and only for someone who may use the assistant.
- **A look is never starved.** Whatever goes wrong reading prices, the automation's look still
  happens and word of the look is left.
- **When it stops, it cannot say so.** The app shows when the last background look was, and warns
  when there has been none for a few minutes during the session.
- **Notifications (Web Push).** Devices the owner switches on are told when the automation sends
  an order, sells at a stop, or needs them. Messages are encrypted for the device (RFC 8291) and
  signed as this application (VAPID, RFC 8292) with a key derived from a secret the server already
  holds, so there is no key to store and no outside account. A notice names the order and its
  outcome, never a balance. Subscriptions live in the owner's data, and the server posts only to
  the browsers' own push services.

Environment: `CRON_SECRET` (the platform's timer secret), `BACKGROUND_KEY` (created in the app),
optional `BACKGROUND_SECRET` (what keys are derived from, at least 16 characters; the broker
credentials are used without it). Changing either the broker credentials or `BACKGROUND_SECRET`
makes the background key unreadable and every notification subscription stale: create a new key
and switch notifications on again. A new key retires the old one on this server only; to end a
key everywhere, change the password.
Tests: `backend/tests/test_background.py` (the encryption is checked against the standard's own
worked example).

## Run locally

Without sign-in, on SQLite:

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/uvicorn app.main:app --port 8000
```

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open http://localhost:3000.

## Tests

```bash
cd backend && .venv/bin/python -m pytest -q && .venv/bin/ruff check app tests
```

```bash
npm run typecheck && npm run build
```

`backend/tests/test_firestore.py` runs the API against the Firestore emulator with the real
security rules. Start it first with `npm run emulators`; without it those tests are skipped.

## Accounting rules

- Average cost excludes fees; fees are tracked separately.
- Gross profit = (sell price − average cost) × quantity.
- Net realized = gross − buy fees for the shares sold − sell fees.
- Unrealized net is an estimate: it also subtracts the fees to sell at the last price.
- Fees are stored on each trade when it is recorded; changing the schedule never rewrites history.
- The default fee schedule is a **placeholder**. Verify it against the broker tariff in Settings.

## Backtest execution model

Signals are read at the close and filled at the next session's open, with slippage and the
fee schedule applied. Stops and targets are checked against the day's low/high; if both are
hit in one bar the stop is assumed first. Long-only, whole shares, daily bars.

## Assistant (Claude)

An assistant built into every screen (the **Assistant** button in the top bar). It answers questions about the
market and the account's own data and operates the app through tools: it can read everything the screens show
and do everything they do (paper trades, strategies, backtests, automatic runs, alerts, research, journal,
settings). It has no tool for sign-in accounts or passwords. For the brokerage account's owner it can
also read the real account and propose a real order; it cannot approve, send or cancel one. With
automatic orders switched on by the owner, a proposal of its that fits their box is sent by the
owner's open app; the assistant is told which of the two happened to each proposal.

### What the assistant knows about trading

Besides the live data it reads through its tools, the assistant has a reference library in
`backend/app/knowledge/` (one Markdown file per subject, read on demand through its `knowledge` tool):

| File | Subject |
|---|---|
| `app-guide.md` | How the app works, screen by screen, and the rules behind its numbers |
| `candlesticks.md` | Japanese candlestick patterns and how the app's detector reads them |
| `chart-patterns.md` | Reversal and continuation formations, breakouts, targets and stops |
| `trend-and-stages.md` | Trend, support and resistance, moving averages, volume, the four-stage model |
| `momentum-indicators.md` | RSI, MACD and how to read any oscillator |
| `growth-stock-method.md` | Bases, breakouts and sell rules of the leading-stock approach |
| `trend-following.md` | Systematic trend following |
| `price-action.md` | Reading trends, channels and trading ranges bar by bar |
| `risk-and-position-sizing.md` | Risk of ruin, expectancy, position sizing, discipline |

The trading references are written for this app, in its own words, from the methods of well-known books (each
file names its sources). They hold no text from those books. To add a subject, add a Markdown file: the first line
is its title and the second a one-sentence summary the assistant chooses by.

Candle patterns are not left to the model's eye: `backend/app/domain/candles.py` detects them from the prices, and
the assistant gets the result (`stock_report`, `candle_scan`).

| Setting (server environment) | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API key. **Secret.** Without it the assistant is off and nothing is charged. |
| `ASSISTANT_MODEL` | `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-haiku-5-5` or `claude-fable-5-2`. |
| `ASSISTANT_EFFORT` | `low`, `medium` (default), `high`, `xhigh`, `max`: how much the model thinks, and costs. |
| `ASSISTANT_USERS` | `admins` (default) or `all`: who may spend from the key when several people have accounts. |
| `ASSISTANT_DAILY_USD` | Rough daily ceiling per account, default `5`. `0` removes it. |
| `ASSISTANT_MONTHLY_USD` | Rough monthly ceiling per account, default `60`. `0` removes it. |

- The Claude API is billed per use by Anthropic and is separate from a Claude subscription. The panel shows an
  estimate of what a conversation and the day have cost.
- **Access** is chosen in the panel and stored per account: *Full access* (default: acts straight away),
  *Ask me first* (trades, run changes, deletions and settings changes wait for approval), *Look only*.
- Code: `backend/app/llm.py` is the only file that calls the Anthropic SDK (streaming, adaptive thinking,
  prompt caching, server-side refusal fallback). `backend/app/assistant.py` is the agent loop and the stored
  conversations; `backend/app/assistant_tools.py` defines the tools, each a bounded wrapper over the same
  service methods the screens use, with its input validated before it runs.
- A conversation is one document in the user's own data and only ever grows: the instructions and tool list
  are fixed and anything that varies (time, current page) is written into the user's message when it is sent.
- **Settings → Assistant** (stored per account, `backend/app/assistant_prefs.py`): model, thinking effort, access,
  the daily and monthly ceilings, the language it answers in, standing instructions, the limits on the
  assistant's own trades, the autopilot and, for the brokerage account's owner, how many real-order proposals
  it may write in a day and which account the autopilot works on. The environment values above are only the
  defaults.
- **Spending** is recorded per day and per month in the account's own data (`assistant_usage`), split into
  conversations and autopilot reviews; the page shows today, the month and the last seven days. Both ceilings
  are checked before every model call, so a turn stops in the middle when one is reached. The autopilot card
  shows what a day can cost: the reviews the schedule asks for (`reviews_a_day`) times the measured average.
- **What the person chose** (language, standing instructions) is appended at the very end of the system prompt,
  after the text everyone shares, so the shared part stays cacheable. Instructions are the person's own words:
  they are kept out of the activity log, and the prompt says they do not widen any tool or limit.
- **Limits on its trades** are enforced in code on every trade the assistant places (`check_trade`): largest
  single trade and largest holding as a share of the portfolio, cash always kept, trades per day. Its trades are
  marked `origin: assistant` in the ledger.
- **Autopilot** (off by default): after each completed session, and optionally every N minutes while the market
  is open, the page asks the server to run a review. The server decides whether one is due, claims it (so two
  tabs cannot both run it), builds a briefing from the portfolio and the user's written mandate, and lets the
  assistant act inside the limits. Each review is a stored conversation. A day has a largest number of reviews
  (12 by default), which holds back the ones during the session and always leaves a place for the one after
  the close. A review that changed something is pushed to the owner's devices unless they switched that off
  (`push.review`): the count only, never the model's words. One held back by a ceiling is told once (once in
  the month for the monthly ceiling). It runs only while the app is open in
  a browser; with anything less than full access it looks and reports only.
- **The account the autopilot works on** (`autopilot.account`, the owner's choice; `assistant_prefs.autopilot_account`):
  `paper`, `real` or `both`. `both` is the default and is how it worked before the choice existed: the briefing
  is the paper portfolio, with a paragraph about real orders, to be used only when the mandate asks. With `real`
  the briefing is built from the broker's own figures, the owner's limits and the automatic box instead
  (`_real_side`); with `paper` real orders are left out of it. The choice is kept in code, not by the briefing:
  each tool that moves money names its account (`Tool.account`), and a review made for one account is refused
  the other account's tools in the loop (`_converse`), whatever the mandate says. That applies to the review
  alone; a conversation is not affected. Only the brokerage account's owner can choose `real`; for anyone else
  `both` is the paper portfolio. Set to `real` without a reachable account, no review runs
  (`autopilot_blocked`) rather than turning it loose on the paper portfolio. Nothing here is a new way to the
  broker: a review still only writes proposals, which go out through `real_orders._approve` as before.
- **Watches** (`backend/app/wakes.py`): the app watches, the assistant is woken. An alert marked `wake` (by the
  person on the Alerts page, or by the assistant with `save_alert(wake_me=…)`) is checked in code like any
  alert; when it fires it is switched off and what happened is queued (`settings/assistant_wakes`, in the same
  transaction as the alert). In the `events` and `intraday` autopilot modes a queued event makes a review due
  (`autopilot_state` → `event`): a short one, briefed with what happened and the note written for that moment.
  The claim takes the queue, so an event is told to one review only. At least five minutes pass after any
  review, so a burst is one review; event reviews count in the day's limit; outside the session, or in
  `after_close` mode, they wait for the next review. The automation's own exits from a real position are
  queued the same way (`wakes.note_exits`). Nothing in `wakes.py` calls the model or sends an order.
  Guards: nothing is queued with the autopilot off; a queued event older than 20 hours is dropped; a review
  that fails before changing anything gives its events back; a time seen more than 30 minutes late is marked
  missed and wakes nobody; in `intraday` mode the timed review comes before an event review and takes the
  events with it; the assistant cannot set a watch on a condition that already holds (it would wake itself).
- **Alerts in the background**: the server's own look (`background.look`) checks the owner's alerts after the
  automation's look and before the review, so what fires can wake the review in that same look; fired alerts
  are pushed to the owner's devices from both the open app's check and the server's. With no device subscribed
  the server checks only the alerts that wake the assistant (`check_alerts(only_wake=True)`), because an alert
  is used up when it fires.
- **Reference library**: Markdown files in `backend/app/knowledge/` (title on the first line, a one-line
  description on the second, then the text under `## ` headings). `app-guide` describes the app; any other
  file is one of the owner's trading references. The assistant's instructions list every reference, and its `knowledge` tool reads them: the outline of a
  reference, chosen sections by number, or a search for words in Arabic or English (spelling variants and
  vowel marks are ignored). It is told to answer questions of method from these references, in their terms,
  and to apply them to what the app has: daily candles, long-only paper trades, alerts instead of pending
  orders. Add a file to teach it something; no code change is needed. A section longer than one answer holds
  (24,000 characters) is cut at blank lines, so keep one topic per `## ` heading.
- Try it locally without a key or any cost: `uvicorn e2e_assistant:app` runs the real API with a stand-in model.

## Protective orders

A stop-loss or take-profit on a holding (`backend/app/orders.py`), placed from the Portfolio page or by the
assistant. The background job carries them out: on a completed session the day's whole range counts (a stop
fills at the stop, or at the open if the stock gapped through it, as in the backtester); during a running
session and on the day the order was placed only the latest price counts. A fill is an ordinary SELL in the
ledger (`origin: order:<id>`) with the usual fees. One stop and one target per stock.

## Automatic paper trading

- A run uses completed sessions only, with the same step-by-step logic and decimal arithmetic as the
  backtester (`backend/app/paper.py` mirrors `backend/app/domain/backtest.py`; a test compares their fills).
- A session's bars are final once history has been read after the close (15:00 Cairo). `MarketData.bars(settled=True)`
  never returns a bar that is still forming; live snapshots are for display and manual paper trades only.
- All active runs move through the sessions together, in date order, and only when the session is complete for
  every stock they follow. A stock more than five sessions behind is set aside with a note.
- The ledger is authoritative for holdings: run positions are reconciled against it on every pass. A run does not
  buy a stock held outside it, and its capital is reserved when it starts.
- Before a manual trade is recorded, pending sessions of the runs are processed, so their fills come first.

## Concurrency

- A document read in a request is written back only if it is still the version that was read (`version` in
  Postgres, `updateTime` in Firestore); a stale write is refused (409) instead of silently overwriting. User
  actions retry once. All the writes of one transaction are committed together or not at all.
- Shared market documents (`egxMarket/index`, `chunk_NN`) are version-checked and re-merged on conflict.
- The data feed is asked once per session close, at a steady pace; a rate-limit answer pauses the update and
  resumes it, keeping what was already saved. A stock that failed is retried after 30 minutes.

## Known limits

- The assistant gives analysis for a practice portfolio, not personal investment advice, and it can be wrong:
  every action it takes is in the ledger and the activity log.

- No corporate actions (splits, bonus shares, dividends); the close is the last trade, not the official VWAP close.
- Fills are unlimited at the open / stop price: no partial fills, price limits or halts; flat slippage.
- A stop or target may sell on the purchase day (EGX allows that only for approved stocks).
- Backtests use today's listing (survivorship bias); no EGX index history, so no index benchmark with Younit.
- When signals exceed free positions, stocks are taken alphabetically.

- Accounts of the quality system and accounts created in Settings → Accounts can sign in; each one gets its own separate paper portfolio. Only an administrator sees the Accounts card.
- The instrument list is a seed of 53 stocks; sector names should be checked against EGX.
- Trading calendar is Sunday–Thursday without public holidays.
- Imported prices are used as given (no adjustment for splits, bonus shares or dividends).
