# Price action: trends, channels and trading ranges
Reading the chart bar by bar without indicators: the market cycle of breakout, channel and trading range, how strong a move is, and why most breakouts fail. Read it when describing what a chart is doing right now or judging a breakout.

Source: Al Brooks's price-action method (the "Trading Price Action" books: Trends, Trading Ranges, Reversals), from
the author's summary slides. It was developed on intraday futures charts; the ideas below are the ones that carry
over to daily candles of EGX stocks. Restated for this app.

## The cycle
The market is always in one of three states and moves between them in order:
1. **Breakout (spike)**: a strong trend. One or several long candles in the same direction, closing near their
   extremes, with little overlap between them. One side is clearly in control.
2. **Channel**: a weaker trend. Price keeps making progress in the same direction but in a sloping band with
   pullbacks and overlapping candles. Every trend starts with a spike and decays into a channel.
3. **Trading range**: no trend. Channels get broader and flatter until both sides are in balance. A small range is
   just a pullback inside a trend; a large one ends with a breakout in either direction, and the cycle starts
   again.

Decide which state the chart is in before anything else, because the right action is opposite in each:
- In a spike, trade with it; pullbacks are shallow and brief, and waiting for a deep one means missing the move.
- In a strong (tight, steep) channel, trade with the trend only, buying pullbacks to the trend line. It behaves
  like a spike on a longer timeframe.
- In a weak (broad, stair-stepping) channel, expect a test of the channel's start; both directions are tradable.
- In a trading range, buy low and sell high, take profits quickly, and distrust every breakout.

## How to tell a strong move from a weak one
Strong: long bodies in one direction; closes near the extremes; small or no shadows on the side the move is
going; little overlap between consecutive candles; gaps that stay open; pullbacks of one or two candles only; each
new extreme beyond the last by a clear margin.
Weak: many shadows; candles that overlap the previous one by half or more; alternating colours; small bodies;
progress that needs many candles to gain little.

## Shadows are failed breakouts
Every shadow is a price that was tried and rejected within the session. When most candles have prominent shadows
and overlap their neighbours, breakouts in that market are failing, and buying new highs or selling new lows will
lose. In such conditions it is better to buy near the bottom of the range and sell near the top than to chase.
When candles have full bodies and no shadows in the direction of the move, breakouts are succeeding and waiting
for a pullback is the mistake.

## Breakouts
- Most attempts to break out of a trading range fail and reverse back in. The longer and more balanced the range,
  the more that holds. Do not assume a breakout will follow through; look for the evidence.
- A breakout that is likely to succeed: a long candle closing near its extreme and well beyond the range, on
  volume, followed by a second candle that also closes in the same direction. The follow-through candle is the
  confirmation.
- A breakout that is likely to fail: a candle with a long shadow against the breakout, a small body, a close back
  inside the range, or no follow-through on the next session.
- After a successful breakout, expect a pullback to test the breakout level. If the test holds, that is the
  better-risk entry.
- A failed breakout is itself a signal in the other direction, with the failure's extreme as the stop.

## Channels and lines
- Draw the trend line along the pullback lows of a rising channel and a parallel line along the highs. When price
  reaches either line it will either reverse or break out; both can offer good reward against risk.
- A push beyond the far side of a channel that quickly fails ("overshoot and reversal") often leads to a move back
  through the whole channel.
- Three pushes in one direction with shrinking momentum (a wedge) frequently end a move.
- Channels usually end with a break of the trend line and then a trading range, not with an immediate reversal.

## Reversals
- A trend does not reverse directly into the opposite trend. First the trend line breaks, then the old extreme is
  tested (often with a slightly higher high or lower low that fails), and only then does the new trend begin.
- A strong trend's first reversal attempt usually fails and becomes a pullback. Give the second attempt more
  weight.
- A climactic acceleration late in a trend (the longest candles of the whole move after a long run) is more often
  exhaustion than new strength.

## Entries, stops and the trader's equation
- A trade makes sense only if the probability of success times the reward exceeds the probability of failure times
  the risk. A low-probability trade needs a large reward against its risk; a high-probability one can accept less.
- The signal candle should close in the direction of the trade. The stop goes beyond the signal candle or beyond
  the swing that the trade relies on.
- When unsure which state the market is in, assume a trading range: that is where markets spend most of their
  time.

## In this app
- Use the candles from `stock_report` (up to 120 daily, weekly or monthly candles) to describe the state: count
  how many of the last candles closed in the upper or lower third of their range, how much they overlap, where the
  swing highs and lows are.
- The app trades on completed daily sessions and fills at the next open, long only. Intraday techniques from this
  method (entering on a stop one tick beyond a bar, scalping a few ticks) do not apply and should not be
  suggested as if the app could do them.
- Pair this with `candlesticks` for single-candle signals and `chart-patterns` for the larger shapes.
