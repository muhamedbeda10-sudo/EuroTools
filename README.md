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

## Known limits

- Accounts of the quality system and accounts created in Settings → Accounts can sign in; each one gets its own separate paper portfolio. Only an administrator sees the Accounts card.
- The instrument list is a seed of 53 stocks; sector names should be checked against EGX.
- Trading calendar is Sunday–Thursday without public holidays.
- Imported prices are used as given (no adjustment for splits, bonus shares or dividends).
