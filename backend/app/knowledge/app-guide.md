# How EGX Intelligence works
A screen-by-screen description of the app, the rules behind its numbers and the limits of its simulation.

## Purpose
EGX Intelligence is a personal workspace for following the Egyptian Exchange and practising with a paper
portfolio. Nothing in it can send an order to a broker. The market feed (Younit, from EFG Hermes) is
connected for reading prices only.

## Screens
- **Dashboard**: paper portfolio value and net profit, indices, market breadth, top gainers, losers and most
  active stocks, the latest strategy signals and research.
- **Market**: a map of the market (stocks grouped by sector, sized by value traded, coloured by the day's
  move), a sortable table of every stock, and sector performance by day, week and month. A stock that did not
  trade in the latest session shows the date it last traded instead of a day change.
- **Stock page**: price with day range, candlestick chart (daily, weekly, monthly) with 20/50/200-day
  averages, RSI and MACD, a rule-based technical and momentum read, support and resistance (low and high of the
  last 60 sessions), candle patterns (arrows on the chart and a "Candle patterns" card with each pattern's
  direction, status and the level it defends, for the chosen candle period), the live order book ("price depth") when the feed is connected, saved research, and the
  order ticket for a paper trade.
- **Watchlist**: watched stocks and custom lists.
- **Portfolio**: holdings, cost, market value, gross profit, estimated net profit after fees, allocation by
  sector, concentration warnings (one stock above 25%, one sector above 40%) and the value history.
- **Trades**: the ledger. Every paper trade with its price, each fee line, cash movement and realized profit.
  The ledger is append-only: entries are never edited or deleted. It can be exported as CSV.
- **Strategies**: saved rule sets. Types: moving-average crossover, RSI mean reversion, MACD signal
  crossover, volume-confirmed breakout, candlestick reversal (buys a bullish reversal candle pattern after a
  decline, optionally only once the next close confirms it and only above a chosen moving average; sells on a
  bearish reversal pattern or a close under the bought pattern's low). Each has parameters and risk settings (stop-loss, take-profit, largest
  position as a share of equity, most open positions, cash reserve, slippage).
- **Simulator**: backtests of a strategy on history, side-by-side comparison of up to four strategies, and
  automatic paper trading ("runs").
- **Research**: the user's own library of news, disclosures and reports, tagged by stock and sector.
- **Journal**: why a trade was made, what was expected, the exit condition, and afterwards the outcome and
  the lesson.
- **Alerts**: price above or below a level, day change, volume against the average of the 20 sessions before,
  RSI level, or a strategy signal. An alert fires at most once per trading session.
- **Guide**: short explanations of indicators, candle patterns, order-book reading, financial statements and ratios, risk
  management, fees, sectors and honest strategy testing.
- **Settings**: fee schedule, starting capital and portfolio reset, market-data status and CSV import,
  sign-in accounts (administrators only), and the activity log.

## Accounting rules
- Average cost excludes fees; fees are tracked separately.
- Gross profit = (sell price - average cost) x quantity.
- Net realized profit = gross profit - the buy fees of the shares sold - the sell fees.
- Unrealized net profit is an estimate: it also subtracts the fees that selling at the last price would cost.
- Fees are stored on each trade when it is recorded, so changing the schedule later never rewrites history.
- The default fee schedule is a placeholder (brokerage 0.15% with a minimum of EGP 3, exchange, clearing,
  regulator and stamp duty lines). It must be checked against the broker's real tariff and marked verified.
- Share prices keep up to four decimals (cheap stocks are quoted in tenths of a piastre); money amounts are
  rounded to the piastre.

## Prices and time
- Daily history is read from the feed once after each session closes (about 15:00 Cairo time). Until then the
  running session is shown from live prices and is not treated as a completed session.
- Live prices and the order book stream while the market is open, Sunday to Thursday, about 10:00 to 14:30.
- A manual paper trade fills at the stock's latest price and is dated with the market's current session.

## Backtests and automatic runs
- A signal is read at a session's close and filled at the next session's open, with slippage and fees.
- Long only, whole shares, daily bars. Stops and targets are checked against the day's low and high; if both
  are touched in one day the stop is assumed to come first; a gap through the level fills at the open.
- A position's size is the smaller of the allowed share of equity and the cash left after the reserve.
- An automatic run uses the same rules on completed sessions only. It waits until the session's data is
  complete for every stock it follows, keeps its own slice of cash, never buys a stock already held outside
  the run, and gives back at cost any of its shares that were sold by hand. Stopping a run is final.
- Results with fewer than 30 closed trades are too small a sample to judge a strategy.

## Protective orders, limits and the autopilot
- A stop-loss or take-profit order on a holding is carried out by the app itself. On a completed session the
  whole day's range counts (a stop fills at its price, or at the open after a gap below it); during a running
  session and on the placement day only the latest price counts. Orders are checked while the app is open.
- Trades placed by the assistant must stay inside limits the user sets in Settings -> Assistant: largest single
  trade and largest holding as a share of the portfolio, cash always kept, trades per day. Trades the user
  places by hand are not limited.
- Autopilot, when the user switches it on, has the assistant review the portfolio after each completed session
  (optionally also during the session) and act inside those limits following the user's written mandate.

## What the simulation leaves out
Splits, bonus shares and dividends; partial fills, price limits and trading halts; the official closing price
(a volume-weighted average) versus the last trade used here; EGX same-day selling rules; companies delisted in
the past; public holidays; an index benchmark (the feed has no index history); fundamentals of any kind.

## Candle patterns
The app finds Japanese candlestick patterns by fixed rules on daily, weekly or monthly candles: hammer, inverted
hammer, hanging man, shooting star, bullish and bearish engulfing, piercing pattern, dark-cloud cover, harami and
harami cross, morning and evening star (and their doji forms), a doji after a decline or an advance, three white
soldiers, three black crows, and rising and falling windows (gaps). A reversal shape counts only after a real move
in the opposite direction. Each pattern has a level (its own low if it points up, its high if it points down, the
far edge of a gap for a window) and a status: forming (the candle is not complete), awaiting the next session,
confirmed, not confirmed, failed (a close through the level within five sessions) or, for a window, open. The
`candlesticks` reference explains how to read them. A strategy signal alert on a saved candlestick-reversal
strategy is the way to be told when one appears.
