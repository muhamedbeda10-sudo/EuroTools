# How EGX Intelligence works
A screen-by-screen description of the app, the rules behind its numbers and the limits of its simulation.

## Purpose
EGX Intelligence is a personal workspace for following the Egyptian Exchange and practising with a paper
portfolio. The connection to Younit (EFG Hermes) reads market prices for everyone. For the owner of the
brokerage account it also reads that account, and carries a real order when the owner approved that one
order. Nothing else in the app reaches a broker.

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
- **Real account**: the owner's brokerage account at EFG Hermes, shown only to the sign-in the server names
  as its owner (the page is not in anyone else's menu). Total value, cash, each holding with its quantity,
  the shares free to sell, unsettled shares, average cost, the broker's price next to the app's own price,
  value, weight and unrealized profit, and the checks made on the reading. Also on this page: real orders
  (see "Real orders" below), with the proposals waiting for the owner's approval at the top.
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

## Installing the app on a phone
- The app installs from the browser, not from a store, and then opens from the home screen in its own window.
- Android (Chrome): the browser offers "Install app", or it is in the browser menu. iPhone or iPad (Safari):
  the Share button, then "Add to Home Screen". The app's own menu has an "Install app" entry with these steps.
- The installed app signs in separately, once. It needs a connection: without one it says so, and it never
  shows prices or balances from a saved copy.

## The paper portfolio and the real account
- They are two separate things and their figures are never mixed or added together.
- The paper portfolio is the simulation: every trade, protective order, automatic run, backtest and profit
  figure in the app belongs to it.
- The real account is read from the broker when its page opens or is refreshed. No paper trade, stop-loss or
  automatic run changes the real account; only a real order the owner approved does.
- Figures on the Real account page (cost, price, value, profit) are the broker's, before selling fees. The
  "app price" beside them is the latest price in the app's own market data.
- "Free to sell" is what can be sold now. Shares bought settle two sessions later (T+2) and show as unsettled
  until then.
- Each reading carries three checks: the holdings add up to the broker's own total; the total equals cash
  plus stocks; the broker's price for each holding is within 1% of the app's. After the close a small gap is
  normal, because the broker may use the official closing price and the app shows the last trade.
- Holdings the app does not follow (funds, for example) are listed at the broker's price, without analysis.
- Who may look is set on the server (BROKER_ACCOUNT_UIDS). Settings, Market data, Connections shows whether
  the current sign-in may, and its user ID.

## Real orders
- A real order starts as a proposal: prepared by the owner on the Real account page ("Prepare a real order"),
  or written by the assistant. A proposal moves nothing and can be declined.
- It is sent to the broker only when the owner presses "Review and send" on it, reads the last look and
  presses "Send". Nobody and nothing else can send one: not the assistant, not a strategy, not an automatic
  run, not a stop-loss order (those are all paper).
- Real orders are off until switched on in two places: on the server, and by the owner in Settings, Real
  trading, where the limits must be written first: most for one order, most orders and most value in a day,
  and how far the price may be past the market. Optionally, the only stocks allowed.
- Every order is a limit order for the day. No market orders. It ends unfilled at the close.
- "Past the market": a buy may be priced at most that percentage above the market price, a sell at most that
  far below. A buy priced under the market, or a sell above it, simply waits.
- Before sending, the app asks the broker what can be spent (for a buy), how many shares are free to sell
  (for a sale) and what prices the exchange accepts today. The session must be running. A proposal written
  after the close is for the next session and is judged again then.
- After sending: "Open at the broker", "Partly filled", "Filled", "Cancelled" and so on, with the broker's own
  word beside it. An open order can be cancelled from the same page. An order cannot be changed: cancel it and
  prepare another.
- "In doubt" means the order was sent and no clear answer came back. It is never sent again. The app looks
  for it in the broker's list; the owner should look in the EFG Hermes ONE app, and can mark it "not placed".
  Until then no other order for the same stock and side can be approved.
- The day's limits count orders that were sent, filled or not.
- Fees shown before sending are an estimate from the fee schedule in Settings.

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
