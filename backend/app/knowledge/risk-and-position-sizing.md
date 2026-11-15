# Risk, position sizing and trading discipline
How much to risk on a trade and why: risk of ruin, expectancy, the main position-sizing methods, validating a method before trusting it, and the habits successful traders share. Read it before sizing any paper trade or judging whether a strategy is worth following.

Sources: Brent Penfold, "The Universal Principles of Successful Trading"; Jack Schwager, "Unknown Market Wizards";
the risk rules in O'Neil, Minervini, Weinstein, Covel and Teo (see the other references). Restated for this app.

## The order of importance
Successful traders who disagree about everything else (timeframe, market, indicators, discretionary or mechanical)
agree on the same few principles. In order of weight:
1. **Money management**: how much is risked per trade. It decides survival, and survival comes first.
2. **Methodology**: a rule set with a positive expectancy, simple enough to be robust: a setup, an entry, a stop
   and an exit, all defined beforehand.
3. **Psychology**: the discipline to follow the plan through losses and wins.
Most people study these in the reverse order of what actually matters, and most lose.

## Risk of ruin
Ruin is not zero; it is the point at which the trader stops, financially or emotionally. Its probability depends
on three things: how often the method wins, how large the average win is against the average loss, and what
fraction of the account each trade risks. The first two belong to the method; the third is a choice, and it has
the largest effect.
- A method with an edge still reaches ruin if each trade risks too much, because a normal run of losses arrives
  before the edge has time to work.
- Cutting the risk per trade from a tenth of the account to a small percentage takes the probability of ruin from
  likely to negligible for the same method.
- Long losing runs are certain, not unlucky. A method that wins 40% of the time will produce runs of eight or ten
  losses in a few hundred trades. Size so that such a run is survivable and unremarkable.

## Expectancy
Expectancy is the average result per unit risked:
`expectancy = (win rate x average win) - (loss rate x average loss)`, with wins and losses measured in multiples of
the amount risked (R).
- A method that wins 35% of the time with average wins of 3R and average losses of 1R earns
  0.35 x 3 - 0.65 x 1 = +0.40R per trade. A method that wins 70% of the time with wins of 0.5R and losses of 1.5R
  earns 0.35 - 0.45 = -0.10R per trade and loses money while feeling good.
- Win rate alone says nothing. Always ask for both the win rate and the size of wins against losses.
- What an account earns is expectancy times the number of opportunities. A modest edge that trades often can beat
  a large edge that trades twice a year, provided costs are covered. Fees count: on EGX a round trip pays the
  schedule twice, so measure R after fees.
- The app's backtests report the number of trades, win rate, average win and loss, profit factor and maximum
  drawdown. Turn them into expectancy before praising a strategy.

## Sizing a position from the stop
The standard method (fixed-percentage risk):
1. Decide the fraction of the account to risk on one trade. Common practice is 0.5% to 2%; 1% is the usual
   starting point.
2. Set the stop where the trade idea is wrong (under the pattern's low, the base, the trend line), not where the
   loss feels comfortable.
3. Shares = (account value x risk fraction) / (entry price - stop price).
4. Check the result against liquidity and concentration: the position's value as a share of the account, and of
   the stock's average daily value traded.
Example: account EGP 50,000, risk 1% = EGP 500; entry 40.00, stop 38.00, risk per share 2.00; size = 250 shares =
EGP 10,000, a fifth of the account. If the stop were at 39.50 the same risk would buy 1,000 shares = EGP 40,000,
which is too concentrated: a tight stop does not justify a huge position, because a gap through the stop loses
far more than planned.

Consequences worth saying aloud:
- A wider stop means fewer shares, not more risk. Never move a stop further away to avoid being stopped out, and
  never widen it after entry.
- If the correct stop gives a position too small to be worth the fees, the trade does not fit; skip it.
- Total open risk matters too. Five positions at 1% each that all sit in one sector are one 5% bet.

## The other sizing methods, briefly
| Method | Rule | Character |
|---|---|---|
| Fixed percentage risk | risk the same percentage of current equity on every trade | grows with the account, shrinks in drawdowns; the default |
| Fixed risk (amount) | risk the same money amount on every trade | simple; does not compound, does not shrink in a drawdown |
| Fixed capital | one unit per fixed amount of equity | ignores the trade's actual risk |
| Fixed units | the same number of shares every time | ignores price and risk; only for testing a method's raw edge |
| Fixed ratio | add a unit after each fixed amount of profit per unit already held | grows slowly at first, protecting a small account |
| Volatility-based | size so that a normal day's move (average true range) is a fixed percentage of equity | equalises risk across quiet and wild stocks; used by trend followers |
| Fixed risk on starting balance | risk a percentage of the starting balance, plus closed profits | a middle course between fixed amount and fixed percentage |
Anti-martingale methods (risk more as the account grows, less as it falls) survive; martingale methods (doubling
after losses, averaging down) do not. The app's strategies size by "maximum allocation per trade" as a share of
equity, which is a fixed-capital rule: for a manual paper trade use `size_position`, which does the calculation above from the stop and the risk
fraction and also applies the limits the user set, then protect the position with `set_protective_order`.

## Drawdowns and the equity curve
- The loss needed to recover grows faster than the loss: down 20% needs 25% to get back, down 50% needs 100%.
- Decide in advance the drawdown at which trading stops for review (for example a fixed percentage from the
  equity high, or a daily and weekly loss limit). The app's Portfolio page and `portfolio` tool show the value
  history.
- Reduce size when trading badly and increase it only when trading well. Raising size to win back losses is the
  usual road to ruin.
- A method whose live results fall well outside what its history showed should be stopped and re-examined, not
  given more money.

## Validating a method before trusting it
- Write the rules so that another person would take the same trades. If two people would disagree, it is not yet
  a method.
- Backtest it, then trade it on paper for at least thirty trades, recording each one exactly as the rules say, with
  no discretion, before believing its expectancy. Thirty is the minimum for the numbers to mean anything; fewer
  proves nothing in either direction. The app's Simulator warns below 30 trades for the same reason, and its
  automatic paper runs are the forward test.
- Prefer simple methods with few adjustable parameters. Every parameter tuned on past data is a chance to fit
  noise. A robust method works acceptably across neighbouring parameter values and across many stocks.
- Judge a method by expectancy, maximum drawdown, the longest losing run and how smooth the equity curve is, not
  by total return alone.

## What the best traders have in common
- There is no single right method. Each found an approach that fits their own temperament, and none succeeded by
  copying someone else's. A method that the trader cannot follow calmly is the wrong method for them.
- Risk control comes before everything: they know the exit before the entry, keep losses small, and cut size or
  stop trading altogether when they are out of step with the market.
- They look for asymmetric trades, where the possible gain is several times the possible loss, and do nothing the
  rest of the time. Patience, the willingness to wait for the exceptional setup, is the most repeated lesson.
- They are comfortable being wrong often. A loss taken according to plan is a good trade; a profit made by
  breaking the rules is a bad one.
- They keep records: every trade with its reason, written before the outcome is known, and reviewed afterwards.
  Most of the edge they describe came from studying their own mistakes. The app's Journal exists for this.
- They do not trade to recover a loss, out of boredom, or on a tip. After a large win or loss they reduce
  activity, because both distort judgement.
- They hold conviction in the method and none in any single trade.

## Using this in answers
- Whenever a user asks whether to take a paper trade, give the stop, the risk per share, the share count for
  their chosen risk fraction from `size_position` (ask once if unknown; assume 1% and say so), the position's
  share of the account, and the reward against risk to the first target.
- With "full" or "confirm" access, never place a paper trade far larger than this arithmetic supports without
  pointing it out first. The Portfolio page warns above 25% in one stock and 40% in one sector.
- When a user praises a strategy for its win rate or return, complete the picture: expectancy after fees, number
  of trades, maximum drawdown, comparison with simply holding.
- When a user is on a losing run, look at whether the losses were inside the plan before suggesting changes;
  suggest smaller size and a review of the journal rather than a new indicator.
- This is practice on a paper portfolio. Paper results flatter real ones: no fear, perfect fills, no partial
  fills in thin stocks. Say so when a user is deciding whether a method is ready for real money, and make clear
  that is their decision, not advice from the app.
