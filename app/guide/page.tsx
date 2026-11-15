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
      <div className="card" style={{ marginBottom: 14 }}>
        <h3>Contents</h3>
        <ul style={{ margin: 0, paddingLeft: 18, columns: "2 240px" }}>
          {TOPICS.map((t) => <li key={t.id}><a href={`#${t.id}`}>{t.title}</a></li>)}
        </ul>
      </div>
      <div className="grid" style={{ maxWidth: 860 }}>
        {TOPICS.map((t) => (
          <section className="card" id={t.id} key={t.id} style={{ scrollMarginTop: 12 }}>
            <h2>{t.title}</h2>
            {t.body}
          </section>
        ))}
      </div>
    </>
  );
}
