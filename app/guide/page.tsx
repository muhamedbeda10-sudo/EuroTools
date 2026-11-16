import Link from "next/link";

const TOPICS: { id: string; title: string; body: React.ReactNode }[] = [
  { id: "indicators", title: "Technical indicators in this app", body: (
    <>
      <p><strong>Moving averages (SMA 20 / 50 / 200).</strong> The average closing price over the last 20, 50 or 200 sessions. Price above a rising average suggests an up-trend; the 50 crossing above the 200 is a classic long-term signal. Averages lag: they confirm a trend, they do not predict it.</p>
      <p><strong>RSI (14).</strong> A 0–100 gauge of how one-sided recent moves have been. Above 70 is called overbought and below 30 oversold. In a strong trend RSI can stay extreme for weeks, so it is a warning, not an order to trade.</p>
      <p><strong>MACD (12, 26, 9).</strong> The gap between a fast and a slow average, and a signal line that smooths it. MACD crossing above its signal line shows momentum turning up. It gives many false signals in a sideways market.</p>
      <p><strong>Support and resistance.</strong> Here they are simply the lowest low and highest high of the last 60 sessions: prices where buyers or sellers stepped in before. A break through either on high volume matters more than a touch.</p>
      <p><strong>Volume.</strong> A move on volume well above the 20-day average has more people behind it than the same move on thin volume.</p>
    </>
  ) },
  { id: "candles", title: "Candle patterns", body: (
    <>
      <p>A candle shows one session: the <strong>body</strong> runs from the open to the close, and the thin <strong>shadows</strong> reach the high and the low. The shape says who won the session. A long body is a clear win for buyers or sellers; a small body, or a <strong>doji</strong> where the open and the close almost meet, is a draw.</p>
      <p>Each stock&apos;s page marks the patterns it finds on the chart and lists them in the <em>Candle patterns</em> card. They are found by fixed rules, the same way every time:</p>
      <ul>
        <li><strong>After a decline, pointing up:</strong> hammer, inverted hammer, bullish engulfing, piercing pattern, bullish harami, morning star, a doji, three white soldiers.</li>
        <li><strong>After an advance, pointing down:</strong> hanging man, shooting star, bearish engulfing, dark-cloud cover, bearish harami, evening star, a doji, three black crows.</li>
        <li><strong>Windows:</strong> a gap between two sessions. A gap up tends to act as support and a gap down as resistance, until a close goes back through it.</li>
      </ul>
      <p><strong>The same shape means different things in different places.</strong> A hammer matters only after a fall and a shooting star only after a rise, which is why the app looks at the sessions before the pattern. A reversal pattern says the move may be tiring; it does not say the price will turn at once, and in a strong trend most of them fail.</p>
      <p><strong>Status.</strong> <em>Forming</em>: the candle is not complete, so the shape can still change. <em>Awaiting next session</em>: nothing has followed yet. <em>Confirmed</em>: the next session closed beyond the pattern in its direction. <em>Not confirmed</em>: it did not. <em>Failed</em>: a later session closed through the pattern&apos;s own low (if it points up) or high (if it points down). That price is shown as the <strong>level</strong>, and it is the natural place for a stop.</p>
      <p>Weigh a pattern with what surrounds it: one that forms at support or resistance, on volume above average, and in the direction of the larger trend deserves more attention than one in the middle of nowhere. In thinly traded stocks single candles are unreliable. To see whether patterns have paid on a stock after fees, test the <em>Candlestick reversal</em> strategy in the <Link href="/simulator">Simulator</Link>.</p>
    </>
  ) },
  { id: "depth", title: "Reading price depth", body: (
    <>
      <p>The order book lists buy orders (bids) and sell orders (asks) waiting at each price. The <strong>spread</strong> is the gap between the highest bid and the lowest ask; a wide spread means trading the stock costs more than the fee schedule alone suggests.</p>
      <p>A large order sitting at one price can act as a floor or a ceiling for a while, but orders can be cancelled in an instant. Treat depth as a picture of the moment, not a forecast. In thinly traded stocks a modest order of your own can move the price: check the size available near the top of the book against the size you intend to trade.</p>
    </>
  ) },
  { id: "statements", title: "Reading financial statements", body: (
    <>
      <p><strong>Income statement:</strong> revenue, costs and profit over a period. Look at the trend over several years and at margins (profit ÷ revenue), not one quarter.</p>
      <p><strong>Balance sheet:</strong> what the company owns and owes on one date. Compare debt with equity and with cash; rising debt alongside flat profit is a strain.</p>
      <p><strong>Cash-flow statement:</strong> cash actually received and paid. Profit that never turns into operating cash flow deserves a hard look.</p>
      <p>In Egypt, check which currency the debt is in and how much of revenue is exported: a devaluation helps exporters and hurts companies with foreign-currency debt. Compare growth with inflation; revenue growing 20% when prices rose 30% is shrinking in real terms.</p>
    </>
  ) },
  { id: "ratios", title: "Financial ratios", body: (
    <>
      <p><strong>EPS</strong> is profit per share. <strong>P/E</strong> is price ÷ EPS: how many years of current profit the price represents. A low P/E can mean cheap, or that the market expects profit to fall.</p>
      <p><strong>P/B</strong> is price ÷ book value per share; useful for banks and asset-heavy companies. <strong>ROE</strong> is profit ÷ equity: how well the company uses shareholders&apos; money. A high ROE produced by heavy debt is riskier than it looks.</p>
      <p><strong>Dividend yield</strong> is the annual dividend ÷ price. A very high yield often means the price has fallen because the dividend is in doubt.</p>
      <p>Always compare a ratio with the same company&apos;s history and with its sector, never in isolation. This app does not yet show these figures: no verified source for them is connected.</p>
    </>
  ) },
  { id: "disclosures", title: "Evaluating company disclosures and news", body: (
    <>
      <p>The company&apos;s own filing on the EGX disclosure site is the primary source. A news article about it is second-hand and can leave out the part that matters.</p>
      <p>Read for what changed: results against the same period last year, capital increases and rights issues (they dilute existing holders), related-party deals, auditor qualifications, changes in major shareholders, and board decisions on dividends.</p>
      <p>In <Link href="/research">Research &amp; News</Link>, record the source and its reliability, and tick &quot;verified&quot; only after you have seen the official document.</p>
    </>
  ) },
  { id: "risk", title: "Risk management", body: (
    <>
      <p><strong>Size each position.</strong> Decide the most you are prepared to lose on a trade before you enter it. Risking a small, fixed share of capital per trade means a run of losses does not end the experiment.</p>
      <p><strong>Use an exit rule.</strong> A stop-loss turns &quot;I&apos;ll see how it goes&quot; into a decision made while calm. On EGX a price can gap past your stop; the loss is then larger than planned, and both the backtester and paper trading model that.</p>
      <p><strong>Diversify.</strong> The portfolio page warns when one stock passes 25% or one sector 40% of the total. Stocks in one sector tend to fall together.</p>
      <p><strong>Mind liquidity.</strong> A thin stock can be easy to buy and hard to sell. Look at average volume and the order book before sizing a position.</p>
      <p><strong>Keep cash.</strong> A reserve lets you act on the next opportunity and means a bad week does not force a sale.</p>
    </>
  ) },
  { id: "fees", title: "Trading fees and their impact", body: (
    <>
      <p>Every buy and every sell pays brokerage commission plus exchange, clearing, regulatory and tax charges. On a round trip they are paid twice. A trade that gains 1% before costs can lose money after them.</p>
      <p>That is why every profit in this app is shown twice: <strong>gross</strong> (price movement only) and <strong>net</strong> (after the fees actually charged, and for open positions after the fees you would pay to sell). Frequent trading multiplies costs: a strategy with many small wins needs a much higher win rate than one with few larger ones.</p>
      <p>The fee schedule in <Link href="/settings">Settings</Link> starts as a placeholder. Enter your broker&apos;s real tariff and mark it verified; until then every net figure is an estimate.</p>
    </>
  ) },
  { id: "sectors", title: "EGX sectors", body: (
    <>
      <p>The exchange groups listed companies by sector: banks, non-bank financial services, real estate, basic resources, food and beverages, health care, industrial goods, telecom and technology, building materials, energy, and others. Sector membership here comes from the data feed.</p>
      <p>Sectors react to different things. Banks follow interest rates and credit growth; real estate follows rates, construction costs and the currency; basic resources and fertilisers follow export prices and energy costs; consumer companies follow inflation and purchasing power.</p>
      <p>The <Link href="/market">Market</Link> page compares sectors by day, week and month. Sector figures there are simple averages of the stocks covered, not official sector indices.</p>
    </>
  ) },
  { id: "testing", title: "Testing a strategy honestly", body: (
    <>
      <p>A backtest answers one question: had these rules been followed on this history, what would have happened after costs? It cannot promise the future.</p>
      <p>Be wary of a result built on few trades (the simulator warns below 30), of rules tuned until the past looks perfect, and of a test that covers only a rising market. Compare with simply holding the same stocks. Then run the strategy in automatic paper trading for a while before believing it.</p>
      <p>Use the <Link href="/journal">Journal</Link> to write down why you expect a strategy to work before you see the result.</p>
    </>
  ) },
  { id: "orders", title: "Stop-loss and take-profit orders", body: (
    <>
      <p>On the <Link href="/portfolio">Portfolio</Link> page you can leave a standing instruction on a holding: sell if the price falls to a level (stop-loss) or rises to one (take-profit). The app carries it out by itself and records an ordinary sale in the ledger, with fees.</p>
      <ul>
        <li>On a completed session the whole day counts: a stop fills at its price, or at the open if the stock opened below it.</li>
        <li>While a session is running, and on the day you placed the order, only the latest price the app has seen counts.</li>
        <li>Orders are checked while the app is open; sessions that completed while it was closed are caught up the next time you open it.</li>
        <li>One stop and one target per stock; a new one replaces the old. Selling the shares another way cancels them.</li>
      </ul>
    </>
  ) },
  { id: "automatic", title: "How automatic paper trading decides", body: (
    <>
      <p>A run follows one strategy with its own slice of the paper cash. It uses completed sessions only, with the same rules and arithmetic as the simulator: a signal read at a close is filled at the next open, with slippage and fees; stops and targets are checked against each day&apos;s low and high.</p>
      <ul>
        <li><strong>A session is handled when it is complete.</strong> The day&apos;s final bars are read once after the close. Until every stock a run follows has its final bar, the run waits, so a stop is never skipped because one price arrived late. A stock whose data stays several sessions behind is set aside with a note.</li>
        <li><strong>The ledger is the record.</strong> Every fill is an ordinary entry in <Link href="/trades">Trades</Link>. If you sell a run&apos;s shares by hand they leave the run at what it paid for them. A run does not buy a stock the portfolio already holds outside that run, so one stock never has two owners.</li>
        <li><strong>Capital is set aside.</strong> Cash promised to one run cannot be promised to another.</li>
        <li><strong>Stopping is final.</strong> A stopped run keeps the result it had at that moment; its shares stay in the portfolio as ordinary holdings.</li>
      </ul>
    </>
  ) },
  { id: "assistant", title: "The assistant", body: (
    <>
      <p>The <strong>Assistant</strong> button in the top bar opens a panel where you can ask about the market, a stock or your own portfolio, or say what you want done: place a paper trade, build and test a strategy, start an automatic run, set an alert, write a journal entry. Arabic or English.</p>
      <ul>
        <li><strong>It works on your real data.</strong> It looks things up in the app rather than answering from memory, and everything it does is recorded in <Link href="/trades">Trades</Link> and the activity log like any other action.</li>
        <li><strong>You choose how far it may go</strong>, at the bottom of the panel: <em>Full access</em> acts straight away; <em>Ask me first</em> shows each trade, run change, deletion or settings change and waits for you; <em>Look only</em> changes nothing.</li>
        <li><strong>It cannot send a real order</strong> and it does not manage sign-in accounts. For the brokerage account&apos;s owner it can propose one; see <em>The real account</em> below for when a proposal goes out by itself.</li>
        <li><strong>It knows what changed.</strong> The assistant reads the same release notes as <em>What&apos;s new</em> in the menu: ask it what is new.</li>
        <li><strong>It is not an adviser.</strong> Its views come from price history and your own notes: there are no company financials in the app, and the simulation has the limits listed below. It can be wrong.</li>
        <li><strong>It has a cost.</strong> It runs on Claude through an API key billed per use; the panel shows an estimate for the conversation and the day.</li>
        <li><strong>You set it up in <Link href="/settings?tab=assistant">Settings → Assistant</Link>:</strong> which model it uses and how hard it thinks (both change the cost), a daily and a monthly spending ceiling, the language it answers in, standing instructions it follows every time, and limits on its own trades (largest trade, largest holding, cash always kept, trades per day). The app enforces those limits itself, whatever the assistant decides.</li>
        <li><strong>The app watches for it.</strong> On <Link href="/alerts">Alerts</Link>, tick <em>Also wake the assistant</em> on a price level, a day&apos;s move or a time, and write what it should check. The assistant sets such watches for itself too. The watching is done by the app and costs nothing; only the short review that follows costs money.</li>
        <li><strong>You can see what it spent.</strong> The same page shows today (conversations and its own reviews apart), this month and the last seven days. When a ceiling is reached it stops until the next day or month, or until you raise it.</li>
        <li><strong>Autopilot.</strong> Switched on there, the assistant reviews the portfolio after each close (and, if you choose, during the session), trades inside the limits following the instructions you wrote, and leaves a conversation you can read. With <em>When a watch fires</em> it also wakes for a short review whenever something the app is watching for it happens, which costs far less than reviewing every so many minutes. You choose the most reviews in one day and whether your devices are told when one changed something. It works while the app is open in a browser; for the brokerage account&apos;s owner it can also run with the app closed (see <em>The real account</em>).</li>
      </ul>
    </>
  ) },
  { id: "limits", title: "What the simulation leaves out", body: (
    <>
      <p>Every paper result here is a simplification. Know these before trusting a number:</p>
      <ul>
        <li><strong>Corporate actions.</strong> Splits, bonus shares and dividends are not handled: a split looks like a crash and can trigger a stop; dividends are not credited.</li>
        <li><strong>Closing price.</strong> The last traded price is used as the close. The official EGX close is a volume-weighted average and can differ slightly.</li>
        <li><strong>Liquidity.</strong> Orders fill in full at the open or at the stop price. Real orders in thin stocks may fill partly, later, or not at all; price limits and trading halts are not modelled, and slippage is a flat percentage.</li>
        <li><strong>Same-day exits.</strong> A stop or target can sell on the day of the purchase. On EGX that is allowed only for stocks approved for same-day trading.</li>
        <li><strong>Which stocks.</strong> Tests run on the stocks listed today, about three years back. Companies that were delisted are missing, which flatters the past.</li>
        <li><strong>When signals outnumber free positions,</strong> stocks are taken in alphabetical order.</li>
        <li><strong>Calendar.</strong> Sunday to Thursday; public holidays are not marked.</li>
        <li><strong>Benchmark.</strong> The data feed has no index history, so results are compared with holding the same stocks, not with EGX 30.</li>
        <li><strong>Fees.</strong> The schedule in <Link href="/settings">Settings</Link> is a placeholder until you check it against your broker&apos;s tariff.</li>
        <li><strong>Manual paper trades</strong> fill at the stock&apos;s latest price and are dated with the market&apos;s current session.</li>
      </ul>
    </>
  ) },
  { id: "real-account", title: "The paper portfolio and the real account", body: (
    <>
      <p>The app keeps two things apart, and never mixes their figures.</p>
      <p><strong>The paper portfolio</strong> is the simulation: every trade, order, strategy run and profit figure elsewhere in the app belongs to it. No real money moves.</p>
      <p><strong>The real account</strong> is the brokerage account at EFG Hermes. Its owner can look at it on the <em>Real account</em> page: cash, holdings, what the broker says they are worth, and how many shares are free to sell.</p>
      <p><strong>Real orders</strong> are the one thing in the app that moves real money, and only for the account&apos;s owner. An order is first <em>prepared</em> (by you, or proposed by the assistant) and waits. It goes to the broker only when you open it, read the last look and press <em>Send</em>. Nothing else can send one: not the assistant, not a strategy, not an automatic run.</p>
      <ul>
        <li><strong>Who sees it.</strong> Only the sign-in the server names as the account&apos;s owner. For everyone else the page is not in the menu at all.</li>
        <li><strong>Free to sell.</strong> Shares you bought settle two sessions later. Until then they count in the quantity but may not be sellable; the page shows them as unsettled.</li>
        <li><strong>Two prices.</strong> The broker&apos;s price and the app&apos;s own latest price are shown side by side. After the close they can differ a little, because the official close is a volume-weighted average and the app shows the last trade.</li>
        <li><strong>The checks.</strong> Each reading is checked: the holdings must add up to the broker&apos;s total, the total must equal cash plus stocks, and the two prices must agree. A check that fails is shown, not hidden.</li>
        <li><strong>Switched on twice.</strong> Real orders are off until they are enabled on the server and you switch them on in <Link href="/settings?tab=real">Settings → Real trading</Link>, after writing your limits: most for one order, most in a day, and how far a price may be past the market.</li>
        <li><strong>Limit orders for the day only.</strong> No market orders. Before sending, the app asks the broker what you can spend or how many shares are free to sell, and the session must be running.</li>
        <li><strong>In doubt.</strong> If an order was sent and no clear answer came back, it is marked <em>in doubt</em> and never sent again. Look in the EFG Hermes ONE app; the page looks for it too.</li>
        <li><strong>Start small.</strong> Make the first real order a single cheap share, and compare what the page shows with the broker&apos;s own app.</li>
      </ul>
      <p>The assistant can read the real account for its owner and propose an order with its reasoning, but it cannot approve, send or cancel one. A proposal is analysis: the decision is yours. How many proposals it may write in one day is yours to set in <Link href="/settings?tab=assistant">Settings → Assistant</Link>, down to none.</p>
      <p><strong>Automatic orders</strong> are a further step that you switch on yourself in <Link href="/settings?tab=real">Settings → Real trading</Link>. With them on, an order the assistant proposes is sent <em>without asking you</em>, as long as it fits the box you set there.</p>
      <ul>
        <li><strong>Locked at first.</strong> The switch opens only after three real orders you approved yourself were accepted by the broker and at least one of them filled.</li>
        <li><strong>The box.</strong> The stocks it may trade (you name them), the most for one order, the most buys in a day (as a count and, if you wish, as an amount in EGP), a budget, and a stop-loss on every buy. Anything outside it waits for your approval as before, and the page says why.</li>
        <li><strong>The budget is the most it can lose.</strong> It is what the automation may have in the market at once; what it has lost so far comes off it.</li>
        <li><strong>Only while the app is open, unless you set up the background.</strong> By default it runs from your open app during the session: close the app or lock the phone and nothing is sent, and <em>no stop-loss is watched</em>, until it is open again. The Real account page shows when it last looked.</li>
        <li><strong>Running without the app open.</strong> In the same Settings tab you can let the server take the looks itself, once a minute during the session. You create a <em>background key</em> there (your own sign-in, sealed for this server), place it in the server&apos;s settings, and switch it on. If the server ever stops looking, the app says so.</li>
        <li><strong>Notifications.</strong> Turn them on for a phone or a computer in that card, and it is told when an automatic order is sent, when a stop-loss sells, or when you are needed. On an iPhone, install the app to the Home Screen first.</li>
        <li><strong>Stop-losses are the app&apos;s, not the broker&apos;s.</strong> When the price reaches a stop, the app sends a sale priced to fill. It sells only shares it bought itself. Shares the broker does not yet show as free to sell have to wait: on EGX that is usually two sessions after the purchase, so a stop on a fresh purchase may not be able to act straight away.</li>
        <li><strong>One tap stops it.</strong> <em>Stop automatic orders</em> on the Real account page: nothing more is sent, its open buys are cancelled, and its shares stay in your account for you to manage.</li>
        <li><strong>Start smaller than you think.</strong> A budget you could lose entirely without minding, one or two liquid stocks, and watch the first days closely.</li>
      </ul>
    </>
  ) },
];

export default function Guide() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Guide</h1>
          <p className="sub">Short explanations of what the app shows and how to use it with care. General education, not investment advice.</p>
        </div>
      </div>
      <div className="guide">
        <nav className="toc" aria-label="Guide contents">
          {TOPICS.map((t) => <a key={t.id} href={`#${t.id}`}>{t.title}</a>)}
        </nav>
        <div className="grid">
          {TOPICS.map((t) => (
            <section className="card" id={t.id} key={t.id}>
              <h2>{t.title}</h2>
              {t.body}
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
