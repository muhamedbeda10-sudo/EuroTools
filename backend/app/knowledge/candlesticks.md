# Japanese candlestick patterns
How to read candle patterns and weigh them with trend, volume and support or resistance, and how the app's pattern detector works. Read it before judging any pattern returned by `stock_report` or `candle_scan`.

Source: the method taught in Steve Nison's "Japanese Candlestick Charting Techniques" (second edition), restated in
this app's own words and fitted to what the app can see (daily, weekly and monthly candles of EGX stocks, long only).

## What one candle says
- The **body** spans the open and the close; the **shadows** reach the session's high and low. A candle that closes
  above its open is "white" (the app draws it in the up colour), one that closes below is "black" (down colour).
- The body is the essence of the session. A long body means one side controlled it from open to close. A small body
  (a "spinning top") means neither side got far, whatever the shadows did.
- A **doji** has an open and close that almost meet. It is a session that ended in a draw. On its own it only says
  the previous conviction is gone.
- Shadows show rejected prices. A long upper shadow means higher prices were tried and refused; a long lower shadow
  means lower prices were refused. A run of long shadows on the same side near the same price is a warning even
  when no named pattern forms.

## The rules that matter more than pattern names
1. **A reversal needs something to reverse.** A hammer after a fall is a signal; the same shape in a flat range is
   noise. Always name the move that came before the pattern.
2. **"Reversal" means the prior trend is likely to change, not to flip.** After a top pattern the price may simply
   go sideways. Treat a reversal pattern as a reason to tighten up, take part of a profit or stop adding, and only
   sometimes as a reason to act in the opposite direction.
3. **Candles give timing, not targets.** A pattern says nothing about how far the next move goes. Take targets from
   support and resistance, earlier highs and lows, or the measured moves of chart patterns.
4. **Location decides the weight.** A pattern at a level that already mattered (earlier support or resistance, a
   widely watched moving average, a half-way retracement of the last swing, a trendline, an open window) deserves
   far more attention than one in empty space. Several independent signals at one price are the real setup.
5. **Trade with the larger trend.** A bullish pattern on a pullback inside an uptrend is a continuation entry with
   the odds behind it. A bullish pattern in a long downtrend is at best a bounce. The reverse holds for bearish
   patterns: in a strong uptrend most of them fail.
6. **Wait for the close.** A candle's shape is not known until its session ends. Some patterns also need the next
   session before they count (see "needs confirmation" below).
7. **The pattern's own extreme is its line in the sand.** The low of a bullish pattern becomes support and the high
   of a bearish one becomes resistance. Judge a break by the close, not by an intraday poke: a close through that
   level means the pattern failed, and that is where the stop belongs.
8. **Risk before reward.** If the distance to the pattern's stop is large compared with the distance to the first
   sensible target, pass, however clean the pattern looks.

## Patterns the app detects
`stock_report` returns `candle_patterns` for one stock; `candle_scan` searches the market. Each hit has a
`direction`, a `level` (the price it defends), and a `state`.

Bullish, after a decline:
| Pattern | Shape | Reading |
|---|---|---|
| Hammer | small body at the top of the range, lower shadow at least twice the body, almost no upper shadow | sellers pushed down hard and lost it all by the close; body colour matters little |
| Inverted hammer | small body at the bottom, long upper shadow | weak alone; **needs** a higher close next session |
| Bullish engulfing | a white body wraps the previous black body | buyers overwhelmed sellers; stronger when the first body is small, the second large, and volume rises |
| Piercing pattern | long black candle, then an open below its close and a close above the middle of its body | the deeper the close into the black body, the better; a close below the middle is a weak rally, not this pattern |
| Bullish harami / harami cross | a small body (or a doji) inside the previous long black body | the fall has lost force; a brake rather than a turn, so **needs** confirmation; the cross is the stronger form |
| Morning star / morning doji star | long black, a small body or doji below it, then a white candle closing well into the first body | three-step bottom: control, stalemate, takeover |
| Doji after a decline | open and close meet after a fall | less reliable at bottoms than at tops; **needs** confirmation |
| Three white soldiers | three long white candles, each opening inside the previous body and closing near its high | steady accumulation; if the second or third shows a small body or long upper shadow the advance is tiring |

Bearish, after an advance:
| Pattern | Shape | Reading |
|---|---|---|
| Hanging man | the hammer's shape after a rise | the sell-off inside the session is the warning; **needs** a lower close next session, ideally below the hanging man's body |
| Shooting star | small body at the bottom, upper shadow at least twice the body | the rally was sold into before the close |
| Bearish engulfing | a black body wraps the previous white body | the mirror of the bullish engulfing |
| Dark-cloud cover | long white candle, then an open above its close and a close below the middle of its body | the deeper the close, the stronger; the classical form opens above the previous high |
| Bearish harami / harami cross | a small body (or doji) inside the previous long white body | the rise has stalled; **needs** confirmation |
| Evening star / evening doji star | long white, a small body or doji above it, then a black candle closing well into the first body | the mirror of the morning star |
| Doji after an advance | open and close meet after a rise, more so after a long white candle | a real warning at tops: buyers ran out of conviction; **needs** confirmation |
| Three black crows | three long black candles, each opening inside the previous body and closing near its low | persistent selling from a high level |

Continuation:
| Pattern | Shape | Reading |
|---|---|---|
| Rising window | a gap up: the low is above the previous high | the gap becomes support; the trend is intact while no close falls back through the bottom of the gap |
| Falling window | a gap down: the high is below the previous low | the gap becomes resistance until a close rises through its top |

### States
- `forming`: the candle is not complete (today's session is running, or the week or month has not ended). Do not
  treat it as a pattern yet; say what it would be if the session ended now.
- `pending`: complete, with no later session to judge it.
- `confirmed`: the next session closed beyond the pattern's last body in the pattern's direction.
- `unconfirmed`: the next session did not. For patterns marked `needs_confirmation` this means no signal.
- `failed`: within five sessions a close went through the pattern's `level`. Say so plainly; a failed bullish
  pattern is mild evidence the decline continues, and the reverse.
- `open` (windows): no close has gone back through the gap.

### How the detector reads "long", "small" and "after a decline"
The classical texts leave these to the eye; the app fixes them so the same chart always gives the same answer.
A body is long when it is at least the average body of the ten sessions before it and at least half of its own
range; small when it is at most half that average; a doji when the body is at most a tenth of the range. "After a
decline" means the close is below its ten-session average and has fallen, over five sessions, by at least one
average session's range; "after an advance" is the mirror. Sessions with no price range (a thinly traded stock that printed one price) are ignored.
These are deliberately plain rules: a pattern the app missed can still be real, and one it found can be marginal.
When the candles returned by `stock_report` show something the detector does not name, describe it from the
figures.

## Patterns the app does not detect
Judge these from the candles when they matter.
- **Tweezers**: two or more sessions with matching highs (top) or lows (bottom). Minor alone; meaningful when the
  second session is itself a reversal candle or the match sits at a known level.
- **Belt-hold**: a long candle that opens at its extreme and runs the other way (opens on its low and closes high
  after a fall: bullish; opens on its high and closes low after a rise: bearish).
- **Counterattack lines**: after a long candle the next session opens far beyond it in the trend's direction, then
  closes back at the previous close. The trend's push was fully answered. Weaker than piercing or dark cloud.
- **Upside-gap two crows, three-line shapes, and the "three" tops and bottoms** (three mountains, three rivers):
  rare or simply the candle names for triple tops, head-and-shoulders and their inverses. Use `chart-patterns`.
- **Rounded tops and bottoms** (dumpling top, frypan bottom) and **tower** tops and bottoms: a slow turn made of
  small bodies, completed by a window or a long candle in the new direction.
- **Rising and falling three methods**: a long candle, a few small candles drifting against it that stay inside its
  range, then another long candle to a new extreme. A pause, not a reversal. The pattern fails if the small candles
  close beyond the first candle's range.
- **Tasuki gaps and side-by-side lines**: small patterns that follow a window; what matters is whether the window
  holds.
- **Long-legged, gravestone and dragonfly doji**: a doji with long shadows on both sides shows the most confusion;
  a gravestone (all upper shadow) is most telling at a top, a dragonfly (all lower shadow) at a bottom.
- **High-wave candles**: a small body with very long shadows on both sides; a group of them after a trend says the
  market has lost its bearings.
- **Stretched runs**: after eight to ten sessions in a row of new highs (or new lows) with no real pause, a
  reversal candle carries more weight, because the move is extended.

## Windows in more detail
- Corrections often stop inside a window. The whole gap is a support or resistance zone; its far edge (the price
  before the gap) is the last line. The app reports that edge as `level`.
- A window that opens on a break out of a range or through an old high, on heavy volume, is the strongest kind.
- If a close goes back through a window, the move that made it is over. The app then marks it `failed`.
- After three windows in the same direction the move is mature: watch for reversal candles rather than adding.
- On EGX many stocks trade thinly and gap for no reason. Give weight to a window only in a stock with steady
  volume, and check `volume_ratio`.

## Joining candles with the other tools
- **Support, resistance and change of polarity**: old support that broke becomes resistance and the reverse. A
  bearish pattern at broken support, or a bullish one at broken resistance, is a high-quality setup.
- **False breaks**: a close back inside a range after a push below its floor (a spring) points to a test of the top
  of the range; a failed push above the ceiling (an upthrust) points to a test of the bottom. A reversal candle on
  the day of the false break is the entry signal; the extreme of the false break is the stop.
- **Moving averages**: a bullish pattern on a pullback to a rising 50-day or 200-day average is a trend entry. The
  app gives SMA 20, 50 and 200 in the stock report.
- **Volume**: a reversal pattern on volume well above the 20-session average has more behind it. A breakout candle
  on thin volume is suspect.
- **Oscillators**: a bullish pattern while RSI makes a higher low against a lower price low (a divergence), or
  while RSI is leaving the oversold zone, is stronger. An overbought RSI with a bearish pattern at resistance is
  the classic top warning. See `momentum-indicators`.
- **Retracements**: pullbacks often end near half of the previous swing; a pattern there fits the trend.
- **Timeframes**: a pattern on weekly candles outweighs one on daily candles. Use `stock_report` with timeframe
  "w" to check whether the daily signal agrees with the weekly picture.

## Using this in answers
- Name the pattern, its date, what came before it, its state and its level, in that order. Then say what else
  agrees or disagrees: trend from the assessment, the moving averages, support or resistance, volume.
- Never present a pattern as a forecast. Say what it suggests, what would confirm it and what would cancel it.
- For a possible paper trade, give the stop from the pattern's level and size the position with `size_position`
  (the rules are in `risk-and-position-sizing`). If the stop is too far for the planned risk, say the trade does not fit.
- On EGX, daily candles of illiquid stocks are unreliable: check average volume and how many of the last sessions
  traded at all before leaning on a single candle.
- To learn whether patterns have actually paid on a stock or sector after fees, test the "Candlestick reversal"
  strategy type in the Simulator instead of arguing from the textbook.
