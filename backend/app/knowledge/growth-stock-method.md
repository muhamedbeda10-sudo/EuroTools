# Growth-stock method: bases, breakouts and sell rules
The leading-stock approach: what to look for in a stock before buying, how to buy a breakout from a proper base, and the selling rules that protect the account. Read it for questions about breakouts, bases, cup with handle, volatility contraction and when to sell.

Sources: William O'Neil, "How to Make Money in Stocks" (the CAN SLIM method); Mark Minervini, "Trade Like a Stock
Market Wizard" (trend template, volatility contraction, risk control). Restated for this app.

## What this app can and cannot check
The method has a fundamental half and a technical half.
- **Not available here**: quarterly and annual earnings growth, sales growth, margins, return on equity, new
  products or management, shares outstanding, institutional ownership. The app has no financial statements. Never
  invent these. When the user wants the full method, say which checks need figures from company filings and offer
  to store them as research items once the user has them.
- **Available here**: price and volume history (daily, weekly, monthly), moving averages, distance from the
  52-week high, returns over 1 week to 6 months, sector performance, market breadth. That is enough for the
  technical half: trend, base, breakout, volume, relative performance and every sell rule.

## The fundamental half, in one paragraph (for context only)
Leaders usually show strongly rising current quarterly earnings against the same quarter a year before (the
benchmark is at least a quarter higher, and accelerating), several years of annual growth, growing sales, something
new driving the business, a manageable supply of shares against real demand, rising ownership by quality
institutions, and leadership in a leading industry, during a market uptrend. The letters C, A, N, S, L, I and M
stand for those seven tests. In this app only L (leader or laggard) and M (market direction) can be judged from
data.

## The trend filter: only buy stocks already in an uptrend
A stock qualifies when all of these hold (the "trend template"):
1. Price is above both the 150-session and the 200-session average.
2. The 150-session average is above the 200-session average.
3. The 200-session average has been rising for at least a month, preferably several.
4. The 50-session average is above both longer averages, and price is above the 50-session average.
5. Price is at least 30% above its 52-week low.
6. Price is within about 25% of its 52-week high; the closer the better.
7. It has outperformed most other stocks over the past months.
The app gives SMA 50 and 200, the distance from the high of the last 252 sessions and the returns; there is no
150-session average or ranking, so approximate (SMA 200 and its slope from candles; `screen_stocks` filters the market on trend,
position against SMA 50 and 200, distance from the high and volume, and ranks by 1 or 3-month return). Say which tests were checked and which were approximated. A stock that fails the filter is
not a candidate, whatever its pattern.

Why buy near highs: big winners spend most of their advance making new highs. Stocks near their lows have trapped
holders above who sell every rally. "Cheap" is not a reason; laggards usually stay laggards.

## Bases
A base is the sideways digestion after an advance of at least 30% or so. Most real ones last seven weeks or more.
- **Cup with handle**: a rounded decline and recovery (commonly 12% to 33% deep in a normal market, more after a
  market break), then a short, shallow downward drift on shrinking volume near the highs: the handle. The handle
  should sit in the upper half of the cup and above the 200-session average. Sharp V shapes and handles that wedge
  upward are faulty.
- **Flat base**: five weeks or more moving sideways in a tight range (about 10% to 15%), usually after a breakout
  from an earlier base.
- **Double bottom**: a W whose second low undercuts the first, shaking out holders; the buy point is the middle
  peak of the W.
- **Volatility contraction**: within the base each pullback is shallower than the one before (for example 25%,
  then 12%, then 5%) and volume shrinks with it, two to four times. Supply is being absorbed: fewer sellers remain
  at each step. The tightest, quietest area on the right side is where the stock is ready.
- Good signs inside any base: tight weekly closes, volume drying up on the lows, a shake-out below an earlier low
  that recovers quickly. Bad signs: wide loose swings, heavy-volume down weeks, a base forming under the
  200-session average, or a third or fourth base after a long run (late-stage bases fail more often).

## The buy
- **Pivot**: the price where the stock leaves the base, usually the top of the handle or of the last tight area.
  Buy as it passes the pivot, not before. Do not chase more than about 5% above it: an extended entry puts the
  stop too far away.
- **Volume**: the breakout session should trade at least about half again its average volume. Without it, be
  suspicious. The app's `volume_ratio` of 1.5 or more is the check; the "Volume-confirmed breakout" strategy type
  tests this idea.
- **Market**: three out of four stocks follow the general market. Buy breakouts only when the market is in a
  confirmed uptrend. After a correction, wait for the rally to prove itself: a strong up day on higher volume
  several sessions into the attempt, not the first bounce. With no index series in the feed, use breadth and the
  number of stocks breaking out against the number breaking down.
- Start with a pilot position and add only as the stock moves up from the entry, never on the way down. Averaging
  down in a falling stock is the classic account killer.

## The sell rules
Selling is decided before buying.
- **Cut every loss small.** The hard ceiling is 7% to 8% below the purchase price, with no exceptions and no
  second-guessing. Better traders keep the average loss nearer 5% to 6% by buying right at the pivot. The app's
  strategies carry `stop_loss_pct` (8 by default) for this reason.
- **The arithmetic of losses**: a 10% loss needs 11% to recover, 25% needs 33%, 50% needs 100%. Small losses are
  the cost of doing business; large ones end careers.
- **Reward against risk**: aim for average gains at least two to three times the average loss. With gains of 20%
  to 25% and losses capped near 7%, being right one time in three still leaves the account whole.
- **Taking profits**: most stocks that advance 20% to 25% from a proper pivot then build a new base or correct, so
  that is the default place to sell. The exception: a stock that makes 20% in three weeks or less is showing
  unusual power; hold it at least eight weeks from the breakout and re-judge.
- **Move the stop up** once the gain is a multiple of the initial risk: to break-even after a gain about three
  times the risk, and thereafter under the most recent base or the 50-session average. Never let a good gain turn
  into a loss.
- **Sell on weakness that changes the picture**: a close below the 50-session average on the heaviest volume in
  months; the largest one-day drop since the advance began; a break under the last base. **Sell on climactic
  strength**: after a long run, the fastest advance yet, several gaps up, the widest daily range and largest
  volume of the whole move. Sell into it.
- If stopped out, the idea is not dead: a stock that sets up again and breaks out can be bought again.

## Using this in answers
- For "is this a buy?": go through the trend filter, name the base (or say there is none), give the pivot, the
  distance of price from it, the volume on the breakout, the stop and the risk as a percentage, then the state of
  the market. If the stock is extended, say that the correct action is to wait for the next base.
- Everything here is tested in this app on a paper portfolio. Rules of thumb such as 7% to 8% and 20% to 25% come
  from US market history; EGX stocks are more volatile and thinner, and the app's fee schedule changes the
  break-even. Use the Simulator to see what stop and target have actually done on EGX stocks.
