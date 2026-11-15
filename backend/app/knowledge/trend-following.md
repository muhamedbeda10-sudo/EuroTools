# Trend following
The systematic approach of riding established trends with fixed entry, exit and sizing rules and no forecasting. Read it for questions about trend systems, trailing stops, why a system has many small losses, and how to judge the app's trend strategies.

Sources: Michael Covel, "Trend Following" (fifth edition); Rayner Teo, "The Ultimate Guide to Trend Following".
Restated for this app.

## The idea
- Nobody can forecast prices consistently. A trend follower does not try: the system reacts to what price has
  already done, enters after a trend is under way, and stays until price itself says the trend is over.
- Price is the only input. News, opinions and valuations are either already in the price or cannot be acted on in
  a repeatable way.
- The whole edge comes from asymmetry: losses are cut quickly and are small and frequent; a few winners are allowed
  to run for months and pay for everything. A typical trend system is right well under half the time and is still
  profitable, because the average win is several times the average loss.
- It follows that the tops and bottoms are given up by design. The system buys after the low and sells after the
  high, and takes the middle.

## The parts of a system
Every rule is written down before the trade, so that nothing is decided in the heat of the moment.
1. **What to trade**: liquid instruments only, and as many unrelated ones as possible, because nobody knows where
   the next big trend will be. On EGX this means liquid stocks across different sectors, not five banks.
2. **Trend filter**: trade only in the direction of the long trend, for example long only while price is above a
   rising 200-session average.
3. **Entry**: a breakout to a new high of the last N sessions, or a pullback in an established trend that turns
   back up, or a moving-average cross. The exact trigger matters much less than people think.
4. **Initial stop**: placed where the trade idea is proven wrong, at a distance that reflects the stock's normal
   noise, commonly two to three average true ranges from the entry.
5. **Position size**: chosen from the stop, so that being stopped out costs a small fixed fraction of the account,
   commonly 1% or less. See `risk-and-position-sizing`.
6. **Exit**: there is no profit target. The position is closed by a trailing stop: a close below a moving average,
   a low of the last M sessions, or a multiple of average true range below the highest close since entry.
7. **Consistency**: take every signal. The trade that is skipped out of fear after a string of losses is often the
   one that would have paid for them.

## What to expect
- Long runs of small losses in sideways markets. This is the cost of the method, not a fault in it.
- Drawdowns that are deeper and longer than is comfortable. Size positions so that the worst historical drawdown
  of the system, and one somewhat worse, can be lived through.
- Returns that come in bursts: a small number of trades and a few periods account for most of the profit.
- Giving back a real part of every open profit before the trailing stop takes the position out.
- The discipline is the hard part. Changing the rules after losses, taking profits early "to be safe", or
  overriding a stop are the usual ways a sound system is turned into a losing one.

## Average true range
True range is the largest of: the session's high minus low, the high minus the previous close, the previous close
minus the low. The average over the last 14 or 20 sessions is the stock's normal daily movement. The app does not
report it; compute it from the candles `stock_report` returns when a stop or a size depends on it, and say that
it was computed from that many sessions.

## In this app
- The strategy types that are trend following in spirit: "Moving-average crossover" (enter on the fast average
  crossing above the slow, exit on the opposite cross) and "Volume-confirmed breakout" (enter on a close above the
  high of the last N sessions with volume, exit on a close below the low of the last M sessions). Both are long
  only, read signals at the close and fill at the next open with slippage and fees.
- Each strategy has a stop-loss percentage, an optional take-profit, a maximum allocation per trade, a maximum
  number of open positions and a cash reserve. A pure trend system would leave take-profit empty and rely on the
  exit rule. Position size here is a share of equity per trade, not a risk-per-trade calculation: for a manual
  paper trade, `size_position` gives the fixed-risk share count and `set_protective_order` holds the stop.
- A trend system needs many trades across many stocks to show its character. A backtest on one stock, or with
  fewer than about 30 trades, says almost nothing. Compare with holding the same stocks, look at the largest
  drawdown beside the return, and remember the test covers only about three years of EGX history, mostly one
  market regime.
- Fees and thin trading hurt systems that trade often. Longer look-backs trade less and survive costs better.
- The method works on the long side only here, so in a falling market the right result is to be mostly in cash,
  and that is a success of the filter, not a failure.

## Using this in answers
- When a user asks "will it go up?", a trend follower's answer is the state of the trend and the price that
  would end it. Give those.
- When a user is discouraged by a losing streak in a trend strategy, check whether the losses are small and inside
  the plan before suggesting any change. Changing parameters to fit the last few months is curve fitting.
- When a user wants to hold a big winner or take the profit, say what the exit rule says and where the trailing
  stop now sits.
