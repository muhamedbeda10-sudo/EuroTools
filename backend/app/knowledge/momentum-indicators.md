# Momentum indicators: RSI, MACD and how to read them
What oscillators measure, the handful of ways to interpret any of them (overbought and oversold, divergence, trend breaks, centre-line and signal crossovers), and the traps. Read it before drawing a conclusion from the app's RSI or MACD.

Sources: Martin Pring, "Martin Pring on Market Momentum" and "Technical Analysis Explained"; John Murphy,
"Technical Analysis of the Financial Markets". Restated for this app.

## What momentum is
Momentum is the speed of the price move, not its direction. A stock can keep rising while its momentum falls: it
is still going up, only more slowly. Momentum usually peaks before price does and bottoms before price does, which
is why oscillators give early warnings, and also why they are early far more often than they are right.

The governing rule: **momentum warns, price confirms.** A momentum signal says the trend is tiring. It becomes
something to act on only when price itself does something: breaks a trend line, breaks a support or resistance
level, crosses an average, or completes a pattern. Never treat an oscillator reading alone as a buy or sell
signal.

## The first question: is the stock trending or ranging?
The same reading means opposite things in the two conditions.
- In a **range**, oscillators work well: overbought near the top of the range and oversold near the bottom are
  usable turning signals.
- In a **strong trend**, they fail in the trend's direction: RSI can stay above 70 for weeks in a powerful
  advance, and every "overbought" reading is a sell signal that loses. In an uptrend only the oversold readings
  are useful (they mark the end of pullbacks: buy points); in a downtrend only the overbought readings are (they
  mark the end of rallies).
Decide the trend first with `trend-and-stages`, then read the oscillator in that light.

## The ways to read any oscillator
1. **Overbought and oversold zones.** An extreme reading says the move has gone unusually far, unusually fast.
   The signal is not entering the zone but **leaving it**: the oscillator turning back across the boundary. The
   app's "RSI mean reversion" strategy buys when RSI recovers above the oversold level for this reason.
2. **Divergence.** Price makes a new high but the oscillator makes a lower high (negative divergence): the
   advance is losing force. Price makes a new low but the oscillator makes a higher low (positive divergence):
   the selling is drying up. Rules of thumb:
   - Divergences that form while the oscillator is in the overbought or oversold zone count most.
   - Several successive divergences are stronger than one, but they also show how long a tired trend can go on.
   - A divergence is only a setup. It needs price confirmation, and in strong trends divergences form and fail
     repeatedly.
   - The reverse case also matters: the oscillator reaches a new extreme that price does not confirm on a
     reaction, showing underlying strength or weakness in the main trend.
3. **Trend lines and patterns on the oscillator itself.** Momentum makes its own trend lines, support and
   resistance. A break of a trend line on the oscillator, followed by a break of the corresponding trend line on
   price, is one of the more reliable combinations.
4. **Centre-line crossings.** For oscillators that swing around a middle value (RSI around 50, MACD around zero),
   which side the oscillator is on tells which side has the upper hand. In an uptrend RSI tends to hold above
   roughly 40 on pullbacks; in a downtrend it tends to fail below roughly 60 on rallies. A shift of that whole
   range is evidence the trend has changed.
5. **Signal-line crossings** (MACD and similar): the oscillator crossing its own smoothed average. Timely, and
   prone to whipsaws in flat markets.
6. **Extremes after a long trend.** An exceptionally strong momentum thrust out of a long decline (the strongest
   reading in a long time, with a jump in volume) is often the first sign of a new bull trend, not a reason to
   sell; expect a pullback and look to buy it. The mirror, an exceptionally weak reading after a long advance,
   often starts a bear trend. Likewise, in a bull trend oscillators rarely reach oversold and bounce quickly when
   they do; in a bear trend they rarely reach overbought. The oscillator's own behaviour tells which market it is.

## RSI (14 sessions in this app)
- Compares the size of recent gains with recent losses on a 0 to 100 scale. Above 70 is conventionally
  overbought, below 30 oversold; in strong bull trends 80 and 40 are the more useful boundaries, in bear trends
  60 and 20.
- **Failure swings**: at a top, RSI peaks above 70, pulls back, rallies to a lower peak that stays below the
  first, then breaks its own pullback low. At a bottom, the mirror below 30. These are RSI's own reversal
  pattern and need no divergence with price.
- Shorter periods swing more and give more signals; longer periods are smoother and give fewer.
- The app reports RSI on every daily candle and in the assessment, and the Wilder smoothing it uses needs about
  a hundred sessions of history to settle.

## MACD (12, 26, 9 in this app)
- The difference between a fast and a slow exponential average, a signal line that smooths it, and a histogram of
  the gap between the two.
- **Above or below zero** says whether the short-term trend is above or below the longer one. **Crossing the
  signal line** says momentum is turning. A bullish crossover that happens well below zero after a decline, or a
  bearish one well above zero after an advance, matters more than one near zero in a flat market.
- The **histogram** turns before the lines cross: a histogram shrinking toward zero is the early warning.
  Histogram divergences against price are the earliest and the least reliable signals.
- MACD has no fixed scale, so its "overbought" level is relative to the stock's own history.
- The app's assessment counts MACD above its signal line as one of three trend votes, and the "MACD signal
  crossover" strategy trades the crossing. Both whipsaw in sideways stocks.

## Rate of change and others (not shown by the app)
- **Rate of change** is the price now against the price N sessions ago. The app's returns over 1 week, 1, 3 and
  6 months are exactly this; a stock whose 1-month return is negative while its 6-month return is strongly
  positive is correcting inside an uptrend.
- **Stochastics** measure where the close sits in the recent high-low range. Closes cluster near the top of the
  range in uptrends and near the bottom in downtrends. Not computed here; the same information can be read
  directly from recent candles.
- **Smoothed, summed rate-of-change measures** over several time spans exist to capture the short, intermediate
  and long cycles in one line; comparing the 1, 3 and 6-month returns is the plain-language equivalent.
- **Volume** is a momentum measure in its own right: rising price on falling volume is a divergence.

## Common mistakes
- Selling a strong stock because RSI is above 70. In a healthy uptrend that is a sign of strength.
- Buying a falling stock because RSI is below 30. In a downtrend it can stay there, and "oversold" becomes "more
  oversold".
- Acting on a divergence without waiting for price.
- Stacking several oscillators and calling it confirmation. RSI, MACD and stochastics are all computed from the
  same closes; agreement among them is one piece of evidence, not three. Real confirmation comes from a
  different kind of evidence: trend, volume, a level, a candle pattern.
- Reading daily oscillators against the weekly trend. Check weekly candles first.

## Using this in answers
- Lead with the trend, then say what momentum adds: confirming, diverging or neutral. Give the readings with
  their dates.
- When RSI is extreme, say which regime the stock is in and therefore what the extreme means there.
- To check for a divergence, compare the last two swing highs (or lows) in price with the RSI values on those
  dates, using the candles from `stock_report`, which carry RSI on each row. State the two dates and the four
  numbers.
- Offer a test instead of an opinion when the user wants to trade an oscillator rule: the Simulator can run "RSI
  mean reversion" and "MACD signal crossover" on the stocks in question, after fees.
