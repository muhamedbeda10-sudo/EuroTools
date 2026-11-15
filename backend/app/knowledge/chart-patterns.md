# Chart patterns
The larger price shapes that take weeks or months to form: reversal patterns (head and shoulders, double and triple tops and bottoms, rounding), continuation patterns (triangles, flags, pennants, rectangles, wedges), how to confirm a breakout, set a target and place a stop. Read it when a question is about a formation rather than a single candle.

Sources: John Murphy, "Technical Analysis of the Financial Markets"; Thomas Bulkowski, "Encyclopedia of Chart
Patterns" (third edition), for what large samples of patterns have shown. Restated for this app. The statistics
behind these observations come from US stocks; treat them as tendencies and test on EGX data.

## Rules for every pattern
1. **A pattern is not complete until price closes beyond its boundary.** Until then it is only a possibility.
   Acting inside a pattern on the guess that it will complete is the most common mistake.
2. **A reversal pattern needs a prior trend to reverse.** The larger the pattern (height and duration), the
   larger the move that tends to follow.
3. **Tops are shorter and more volatile than bottoms.** Bottoms take longer and move in a narrower range.
4. **Volume matters more on the upside.** An upward breakout should come with clearly higher volume. A downward
   break does not need it.
5. **The measured move** is a minimum expectation, not a promise: take the pattern's height and project it from
   the breakout point. Large-sample studies find that a full measured move is reached only part of the time, less
   often for downward breaks and in weak markets. Use it to judge reward against risk, and prefer the nearest real
   support or resistance when it is closer.
6. **Return moves are common.** After a breakout, price returns to the boundary in roughly half of all cases
   (a "throwback" after an upward break, a "pullback" after a downward one). It is a second chance to act, but
   patterns that return tend to go less far afterwards than those that run without looking back.
7. **Failed patterns are signals.** A breakout that closes back inside the pattern and out through the other side
   often produces a fast move in the new direction.
8. **Taller is better.** Patterns that are tall relative to the stock's price tend to perform better than short
   ones; breakouts near the yearly high, with space overhead, do better than those under heavy resistance.
9. **The general market decides a lot.** Upward breakouts do best in rising markets and fail far more often in
   falling ones.

## Reversal patterns
| Pattern | What it looks like | Completed by | Target | Notes |
|---|---|---|---|---|
| Head and shoulders top | three peaks after an advance, the middle one highest; a "neckline" through the two troughs between them | a close below the neckline | the head-to-neckline height projected down from the break | volume usually lighter on the head than on the left shoulder and lightest on the right shoulder; a return to the neckline from below is common and should fail |
| Inverse head and shoulders | the mirror, after a decline | a close above the neckline on higher volume | the same height projected up | volume on the breakout is essential; without it, distrust it |
| Double top | two peaks at about the same level, a clear trough between, weeks to months apart | a close below the trough | the height projected down | two peaks alone are not a top: most "double tops" called before the trough breaks turn out to be pauses |
| Double bottom | the mirror, a W | a close above the middle peak | the height projected up | the second low on lighter volume and a breakout on heavier volume is the healthy form |
| Triple top or bottom | three tests of the same level | a close through the opposite boundary | the height | rarer; behaves like a wide double |
| Rounding bottom (saucer) | a slow, bowl-shaped turn with volume fading into the low and rising out of it | a close above the rim | the depth of the bowl | long, quiet bases lead to long advances; common in neglected stocks |
| V reversal (spike) | an abrupt turn with no pattern, often after a climax | only clear in hindsight | none | cannot be anticipated; a candle signal or a key reversal day on extreme volume is the only warning |
| Broadening formation | swings that widen: higher highs and lower lows | a decisive break of the last swing | the height | marks an unstable, emotional market, usually near tops; hard to trade |
| Rising wedge | both boundaries slope up and converge, in an advance or as a rally in a downtrend | a close below the lower line | to the start of the wedge | bearish in either setting |
| Falling wedge | both boundaries slope down and converge | a close above the upper line | to the start of the wedge | bullish in either setting |

## Continuation patterns
Pauses in a trend that usually resolve in the trend's direction. They are shorter than reversal patterns.
| Pattern | What it looks like | Completed by | Target | Notes |
|---|---|---|---|---|
| Symmetrical triangle | lower highs and higher lows converging | a close through either line, normally in the direction of the prior trend | the widest height projected from the breakout | the breakout should come between half and three quarters of the way to the apex; a drift out of the very tip means little |
| Ascending triangle | a flat top and rising lows | a close above the flat top | the height | buyers paying up at each dip; bullish even without a prior trend |
| Descending triangle | a flat bottom and falling highs | a close below the flat bottom | the height | the mirror; bearish |
| Rectangle | a sideways range between parallel support and resistance | a close through either side | the height | watch which half of the range the heavier-volume moves occur in |
| Flag | after a near-vertical move (the pole), a small parallelogram sloping against the move, on falling volume | a close out of the flag in the pole's direction | the pole's length projected from the breakout | should last one to three weeks; flags "fly at half mast" |
| Pennant | the same, but a small symmetrical triangle | the same | the same | the same |
| High, tight flag | a stock roughly doubles in under two months, then drifts sideways or slightly down for a few weeks giving back little | a close above the top of the drift | open-ended | rare, and in large samples among the best-performing upward patterns; buy only on the breakout |
| Cup with handle | see `growth-stock-method` | a close above the handle's high on volume | open-ended | a continuation base within an uptrend |
| Measured move (swing) | a leg up, a correction of a third to two thirds, then a second leg | the correction's high being exceeded | the second leg is often similar in size to the first | useful for targets in a trending stock |

## Confirming a breakout
- Use the close, not the intraday high or low.
- Ask for a margin: a close a few percent beyond the boundary for a daily pattern, or two consecutive closes
  beyond it.
- Check `volume_ratio` on the breakout session for upward breaks: 1.5 or more is supportive.
- Check the larger trend and the market's breadth: a bullish pattern against a falling 200-session average and a
  weak market has poor odds.
- In thin EGX stocks a single trade can print beyond a boundary. Require that the stock actually traded in size.

## Stops and failure
- The stop for an upward breakout goes just under the breakout level or under the last low inside the pattern,
  whichever gives a tolerable loss. For patterns bought near their low (double bottoms, rounding bottoms after
  completion), under the pattern's low.
- If price closes back inside the pattern, the breakout has failed: get out. Do not wait for the stop on the far
  side.
- Compare the distance to the stop with the distance to the target before the trade. If the target is not at
  least about twice the risk, the pattern is not worth taking.

## In this app
- The app does not detect chart patterns. Read them from the candles returned by `stock_report`: ask for weekly
  candles (timeframe "w") for anything longer than about three months, and locate the swing highs and lows by
  their dates and prices. Give the boundary prices explicitly so the user can see them on the chart.
- The app's support and resistance lines are the lowest low and highest high of the last 60 sessions, which often
  coincide with a pattern's boundary but are not derived from one.
- The "Volume-confirmed breakout" strategy type (a close above the high of the last N sessions with volume) is a
  mechanical stand-in for breakout trading and can be backtested. A price alert at the boundary
  (`save_alert`, price above or below) is the practical way to watch a pattern that has not completed.
- Prices are not adjusted for splits or bonus shares. A sudden step in the chart may be a corporate action, not a
  breakout or breakdown; check before naming a pattern that includes it.
- Be honest about ambiguity: if the shape could be read two ways, say so, and state which close would settle it.
