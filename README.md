# EGX Intelligence

Personal Egyptian Exchange (EGX) analysis and **paper-trading** workspace.

> Paper trading only. Nothing in this codebase can send an order to a broker.
> The app ships with **synthetic sample prices** (clearly labelled in the UI) until real
> history is imported by CSV or a data feed is connected.

## What is in this release

| Screen | Contents |
| --- | --- |
| Dashboard | Indices, breadth, movers (re-ranked live), paper portfolio (gross vs net), watchlist, signals, latest research, data status |
| Market & Categories | Sector performance, all stocks, search/filters, custom categories |
| Stock analysis | Candles (D/W/M), SMA 20/50/200, RSI, MACD, support/resistance, live price and order book (price depth), related research, simulated order ticket |
| Watchlist | Tracked stocks |
| Portfolio | Cash, holdings, stock/sector allocation, concentration warnings, value vs benchmark |
| Trades & Transactions | Append-only ledger, per-trade fee breakdown, gross vs net profit, CSV export |
| Strategy Management | Strategy library (MA crossover, RSI reversion, MACD, breakout), risk limits |
| Strategy Simulator | Historical backtest, side-by-side comparison of strategies, automatic paper trading |
| Research & News | Your own library of links and notes, tied to stocks, sectors and strategies, with impact, reliability and a verified flag |
| Journal | Why each decision was made, what was expected, what happened, what was learned |
| Alerts | Price, day change, volume, RSI and strategy-signal alerts, shown in the app and as desktop notifications |
| Guide | Indicators, price depth, financial statements and ratios, disclosures, risk, fees, sectors, testing a strategy |
| Settings | Fee schedule, starting capital, CSV data import, accounts (administrators), connections, audit trail |

Not built yet: order execution, fundamentals (no verified source), corporate actions, AI analysis
(needs a paid model key).

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
history, **read-only**. The code contains no call for orders, funds or the brokerage
portfolio. The credentials stay on the server; they are never sent to the browser, logged
or committed.

Prices are the same for every account, so they are cached once in Firestore
(`egxMarket/`). The first page load of the day pulls the update in short batches, and
Settings → Connections has a manual update button. The feed provides no sector and no index
series: known symbols keep the seed list's sector, others show as "Unclassified", and index
figures are simply not shown.

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
settings). It has no tool for sign-in accounts or passwords, and none for real orders: no such code exists.

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
