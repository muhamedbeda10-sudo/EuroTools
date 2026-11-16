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
| Stock analysis | Candles (D/W/M), SMA 20/50/200, RSI, MACD, support/resistance, candle patterns (marked on the chart and listed with status and level), live price and order book (price depth), related research, simulated order ticket |
| Watchlist | Tracked stocks |
| Portfolio | Cash, holdings, stock/sector allocation, concentration warnings, value vs benchmark |
| Real account | The owner's brokerage account: cash, holdings, shares free to sell, broker price next to the app's price, checks on the reading; real orders, each sent on the owner's approval; and automatic orders (what fits the owner's box, with stop-losses watched by the app, and a one-tap stop). Owner only |
| Trades & Transactions | Append-only ledger, per-trade fee breakdown, gross vs net profit, CSV export |
| Strategy Management | Strategy library (MA crossover, RSI reversion, MACD, breakout, candlestick reversal), risk limits |
| Strategy Simulator | Historical backtest, side-by-side comparison of strategies, automatic paper trading |
| Research & News | Your own library of links and notes, tied to stocks, sectors and strategies, with impact, reliability and a verified flag |
| Journal | Why each decision was made, what was expected, what happened, what was learned |
| Alerts | Price, day change, volume, RSI and strategy-signal alerts, shown in the app and as desktop notifications |
| Guide | Indicators, candle patterns, price depth, financial statements and ratios, disclosures, risk, fees, sectors, testing a strategy |
| Settings | Fee schedule, starting capital, CSV data import, accounts (administrators), connections, audit trail |

Not built yet: fundamentals (no verified source), corporate actions.

## How it is hosted

One Vercel project serves everything from this repository:

- the web app (Next.js static export, repository root),
- the API (`backend/`, FastAPI) as a Python function behind `/api/*`.

Sign-in and data use the existing Firebase project (`eurotools-a1ea6`), free tier:

- Firebase Authentication (email and password, accounts created by the administrator),
- Firestore, one private tree per account under `egx/{uid}/`.

The API holds **no credentials**. It forwards the caller's sign-in token to Firestore,
so `firestore.rules` authorises every read and write. The ledger and the audit trail are
append-only in the rules themselves. Pushing a change to `firestore.rules` publishes the
rules through `.github/workflows/rules.yml`; that workflow never touches Firebase Hosting.

## Market data (Younit)

When `YOUNIT_TRADING_ID` and `YOUNIT_API_KEY` are set on the server, prices come from the
Younit (EFG Hermes) API instead of the synthetic sample: the EGX stock list and daily
history, **read-only**. The same connection reads the owner's account and carries their real
orders (the two sections below). The credentials stay on the server; they are never sent to the
browser, logged or committed.

Prices are the same for every account, so they are cached once in Firestore
(`egxMarket/`). The first page load of the day pulls the update in short batches, and
Settings → Connections has a manual update button. The feed provides no sector and no index
series: known symbols keep the seed list's sector, others show as "Unclassified", and index
figures are simply not shown.

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
capped at 20 a day.

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
  automatic buys in a day; a budget; a stop-loss on every buy, no further under its price than the
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
- **Stop-loss and take-profit** are watched by the app, not left at the broker (the API takes day
  limit orders only). When a fresh live price reaches the level, a sale is sent a few levels into
  the bids, inside the owner's price band; one that does not fill is cancelled and priced again; a
  sale in doubt is never followed by another; after six attempts in a day the app stops and says so.
  The owner can move a position's levels. A later buy can raise a position's stop, never lower it.
  A stock sold that way is not bought again by the automation the same day. **Shares that have not
  settled cannot be sold** (on EGX usually T+2), so the stop on a fresh purchase may have to wait.
- **What was written before the switch was turned waits for the owner**, as it said it would, and
  the assistant can mark a proposal to wait for the owner (`hold_for_owner`).
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
- **Whose hands.** The API holds no database credentials, and a timer has no sign-in. The owner
  lends theirs: Settings → Real trading → *Running without the app open* → *Create a background key*
  seals their sign-in's renewal token with a key only this server can derive, and shows it once.
  The owner adds it to the server's environment as `BACKGROUND_KEY` (Sensitive) and redeploys.
  With it the server signs in as the owner and nobody else; Firestore applies the owner's own rules,
  as when the app is open. The key is never accepted from a request, only read from the
  environment; it cannot be opened anywhere else; a new key, or a changed password, retires it.
- **The owner's switch** is in their own data. Off, a look ends before it does anything.
- **A look**: read live prices (or the session's final bars after the close), `real_auto.tick`,
  then the assistant's review when one is due (its own switch and schedule in Settings →
  Assistant), and what the review proposed is judged in the same look.
- **It decides nothing.** What may be sent is still the owner's box and limits, checked at every look.
- **When it stops, it cannot say so.** The app shows when the last background look was, and warns
  when there has been none for a few minutes during the session.
- **Notifications (Web Push).** Devices the owner switches on are told when the automation sends
  an order, sells at a stop, or needs them. Messages are encrypted for the device (RFC 8291) and
  signed as this application (VAPID, RFC 8292) with a key derived from a secret the server already
  holds, so there is no key to store and no outside account. A notice names the order and its
  outcome, never a balance. Subscriptions live in the owner's data, and the server posts only to
  the browsers' own push services.

Environment: `CRON_SECRET` (the platform's timer secret), `BACKGROUND_KEY` (created in the app),
optional `BACKGROUND_SECRET` (what keys are derived from; the broker credentials are used without it).
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
  daily ceiling, the limits on the assistant's own trades, and the autopilot. The environment values above are
  only the defaults.
- **Limits on its trades** are enforced in code on every trade the assistant places (`check_trade`): largest
  single trade and largest holding as a share of the portfolio, cash always kept, trades per day. Its trades are
  marked `origin: assistant` in the ledger.
- **Autopilot** (off by default): after each completed session, and optionally every N minutes while the market
  is open, the page asks the server to run a review. The server decides whether one is due, claims it (so two
  tabs cannot both run it), builds a briefing from the portfolio and the user's written mandate, and lets the
  assistant act inside the limits. Each review is a stored conversation. It runs only while the app is open in
  a browser; with anything less than full access it looks and reports only.
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

- Firestore documents read in a request are written back with an `updateTime` precondition; a stale write is
  refused (409) instead of silently overwriting. User actions retry once.
- Shared market documents (`egxMarket/index`, `chunk_NN`) are version-checked and re-merged on conflict.
- The data feed is asked once per session close, at a steady pace; a rate-limit answer pauses the update and
  resumes it, keeping what was already saved.

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
