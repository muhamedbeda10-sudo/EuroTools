# Trend and stage analysis
How to decide which way a stock is going and where it is in its cycle: trend definitions, support and resistance, trendlines, moving averages, volume, and the four-stage model. Read it before calling a stock an uptrend, a base or a top.

Sources: Stan Weinstein, "Secrets for Profiting in Bull and Bear Markets" (the four stages); John Murphy, "Technical
Analysis of the Financial Markets"; Martin Pring, "Technical Analysis Explained". Restated for this app.

## The premises
- Price already reflects what is known, hoped and feared. Read the chart; do not argue with it using the news.
- Prices move in trends, and a trend in force is more likely to continue than to reverse. The job is to find the
  trend early in its life and stay until there is evidence it has ended.
- Three trends run at once: the primary trend (many months to years), secondary reactions against it (weeks to a
  few months, typically giving back a third to two thirds of the last leg), and minor swings (days). Decide which
  one a question is about before answering. Trade in the direction of the next larger trend.

## What a trend is
- **Uptrend**: rising peaks and rising troughs. **Downtrend**: falling peaks and falling troughs. Anything else is
  a range. The first sign of a turn is a failure to make a new extreme; the turn is established when the last
  trough (in an uptrend) or peak (in a downtrend) is broken.
- **Support** is a price where buying stopped earlier declines; **resistance** is where selling stopped rallies.
  The more often and more recently a level was tested, and the more volume traded there, the more it matters.
  Round numbers attract orders.
- **Role reversal**: once clearly broken, support becomes resistance and resistance becomes support. A return to
  the broken level that holds is the low-risk place to act.
- **Trendlines**: join rising troughs in an uptrend, falling peaks in a downtrend. Two points draw a line, a third
  touch that holds confirms it. Longer, more often tested and less steep lines matter more. A break is judged on
  a close, and is more convincing with volume and a margin beyond the line. A broken trendline often means the
  trend is slowing, not ending.
- **Retracements**: corrections commonly return a third, a half or two thirds of the previous leg. A correction
  that gives back much more than two thirds puts the trend in doubt.
- **Gaps**: a gap out of a pattern on volume (breakaway) starts a move and often stays open; a gap midway
  (runaway) suggests the move is about half done; a gap late in an extended move that is filled within days
  (exhaustion) warns of the end.

## Volume
- Volume should expand in the direction of the trend: heavier on advances and lighter on pullbacks in an uptrend.
  Rising price on shrinking volume is a warning.
- An upside breakout needs volume to be believed. Downside breaks can happen on little volume: prices fall of
  their own weight.
- A final surge on extreme volume after a long advance (a blow-off), or a panic low on extreme volume after a long
  decline (a selling climax), often marks the end of the move.
- The app gives `volume_ratio` (latest session against the 20 before it) and volume on every candle.

## Moving averages
- An average is a smoothed trend line. It follows; it never leads. It works in trends and whipsaws in ranges.
- Direction first: a rising average with price above it is an uptrend on that horizon. In this app SMA 20 is the
  short swing, SMA 50 the intermediate trend, SMA 200 the primary trend.
- Common signals: price closing across an average; a faster average crossing a slower one (the app's
  moving-average crossover strategy). Longer averages give fewer, later and more reliable signals.
- In a healthy uptrend pullbacks tend to stop near the rising 50-session average; a decisive close below a
  flattening 200-session average is a primary-trend warning.

## The four stages (weekly charts)
The model uses weekly candles and a 30-week moving average (about 150 sessions). The app does not plot that
average: approximate it from weekly candles (`stock_report` with timeframe "w" and enough bars, averaging the last
30 closes) or use the daily SMA 200 as a slower stand-in and say which was used.

| Stage | Picture | What to do (long only) |
|---|---|---|
| 1. Base | after a decline the average flattens; price moves sideways across it; volume dries up, then picks up late | watch, do not buy yet; money sits idle here |
| 2. Advance | price breaks above the base's resistance and the average, which turns up; breakout on clearly heavier volume; then higher highs and higher lows above a rising average | buy the breakout or, better, the first pullback toward the breakout level; hold while the average rises |
| 3. Top | the advance stalls; the average flattens; price swings above and below it; volume is heavy but progress is nil | stop buying; tighten stops; take profits on strength |
| 4. Decline | price breaks below the top's support and stays under a falling average; rallies fail at the average | do not hold and do not buy, however "cheap" it looks |

Rules that go with it:
- Never buy a stock trading below a falling 30-week average, and never hold one in Stage 4 hoping for a recovery.
- The ideal buy has little resistance overhead: the fewer recent highs above the breakout, the freer the move.
  A stock breaking to new highs has no trapped holders waiting to sell.
- The breakout week should show volume well above recent weeks (roughly double is the benchmark), and the
  following weeks should stay active. A breakout on dull volume is suspect.
- Prefer stocks stronger than the market, in groups that are themselves in Stage 2: the forest, then the trees.
  The feed has no index history, so judge relative strength by comparing the stock's 1, 3 and 6-month returns with
  its sector's and the market's breadth (`market_overview`, `screen_stocks` sorted by month or three-month change).
- Stops: place the first stop under the base's support or the last correction low. As the advance proceeds, raise
  it to just under each new correction low once the stock has pulled back and resumed, keeping it under the 30-week
  average while that average rises. When the average flattens (Stage 3), tighten to just under the latest low.
  Stops only ever move up.
- A big base supports a big advance: the longer the Stage 1 base, the more sustained Stage 2 tends to be.

## Reading the market as a whole
- Do not fight the general trend: most stocks follow the market. When most stocks are in Stage 4, the best trade
  is cash.
- Breadth tells the truth about an index: an advance joined by fewer and fewer stocks is weakening. The app's
  `market_overview` gives the count of advancing and declining stocks and sector performance.

## Using this in answers
- State the horizon (primary, intermediate, short), then the evidence: sequence of highs and lows, position
  against SMA 50 and 200 and their slope, the nearest support and resistance, and what volume has done.
- The app's `assessment.trend` is a three-vote score (price against SMA 50, SMA 50 against SMA 200, MACD against
  its signal). It is a summary, not a stage. Name the stage only after looking at weekly candles.
- The app's support and resistance are simply the lowest low and highest high of the last 60 sessions. Look at
  the candles for the real shelves.
- EGX specifics: many stocks are thin; a "breakout" in a stock that trades a few times a day means little. The
  app's prices are not adjusted for splits, bonus shares or dividends, so a sudden one-day drop of a third or a
  half is more likely a corporate action than a Stage 4 break. Say so and check the news before concluding.
