/**
 * The public methodology page.
 *
 * 00-START-HERE.md: "One thing genuinely worth imitating: they publish a public page
 * explaining exactly how each score is computed. Do that. In a category where every vendor's
 * numbers disagree, being the one that shows its work is the strongest position available."
 *
 * Deliberately OUTSIDE the auth gate (see proxy.ts OPEN list) — it is the trust artefact and
 * the SEO surface, so it must be readable without an account.
 */
export const metadata = {
  title: "How every ASO score is calculated — trysearch",
  description: "The exact formula behind each keyword score, what is measured, what is modelled, and where the numbers come from.",
};

export default function ScoresExplainedPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <h1 className="text-2xl font-semibold">How every score is calculated</h1>
      <p className="mt-2 text-[14px] leading-relaxed text-[var(--fg-muted)]">
        Every number in this tool comes from free, public App Store and Google Play data. No paid vendor, no licensed
        feed. Below is the exact formula behind each score, and — just as importantly — which numbers are{" "}
        <strong className="text-[var(--fg)]">measured</strong> and which are{" "}
        <strong className="text-[var(--fg)]">modelled</strong>.
      </p>

      <Callout>
        <strong className="text-[var(--fg)]">The one fact that reframes the whole category.</strong> Apple&apos;s Search
        Ads popularity metric — the number nearly every paid ASO tool resells as &ldquo;search volume&rdquo; — collapsed
        between 29 September and 3 October 2025. US keywords scoring above 5 fell from roughly 165,875 to roughly
        39,254, a 77% drop, and everything below a floor now pins to a flat <code className="num">5</code>. Apple never
        announced it. So on the mid and long tail — exactly where a small app can win — the expensive tools are
        estimating too. We would rather tell you that than pretend otherwise.
      </Callout>

      <Section title="Popularity (0–100)" measured={false}>
        <p>
          How much a keyword is searched. When the store reports a real value we show it. When the store floors it at
          5, we show both: <code className="num">5 (28)</code> — the first number is the store&apos;s, the
          parenthesised one is ours. Parentheses always mean our estimate.
        </p>
        <p className="mt-2">Our estimate comes from the position and breadth of the term in store autocomplete, which is ordered by real search demand:</p>
        <Formula>{`reveal   = (25 - firstPrefixLength) / 24      // reveals after 3 chars → high demand
slot     = max(0, (4 - positionInThatList) / 4)
position = max(0, (10 - bestPositionEverSeen) / 10)
breadth  = min(1, distinctPrefixesThatSurfacedIt / 5)

popularity = round(100 × (0.50·reveal + 0.20·slot + 0.20·position + 0.10·breadth))`}</Formula>
        <p className="mt-2">
          <strong className="text-[var(--fg)]">Reveal depth carries the most weight</strong> because it discriminates
          best. A term the store starts suggesting after 6 characters (<em>motivational quotes</em>) is in far higher
          demand than one that needs 13 (<em>alarm clock for heavy sleepers</em>).
        </p>
        <p className="mt-2">
          On Android we blend in something iOS cannot offer: Google Play publishes an <em>exact</em> install count, so
          the autocomplete score is anchored to the install volume of the apps actually ranking in the top 10
          (70% autocomplete / 30% installs).
        </p>
        <p className="mt-2 text-[var(--warn)]">
          If a term never appears in autocomplete at any prefix length, popularity is <code className="num">null</code>,
          not zero. We did not observe it — which is different from observing that nobody searches it.
        </p>
      </Section>

      <Section title="Difficulty (0–100)" measured>
        <p>
          How hard it is to rank near the top, measured from the <strong className="text-[var(--fg)]">visible search
          results page</strong> — deliberately not derived from Apple&apos;s popularity metric, for the reason above.
        </p>
        <Formula>{`leaders     = min(100, 100 × log10(medianRatingsOfTop10 + 1) / 6)
              // 1k ratings ≈ 50, 100k ≈ 83, 1M = 100
              // Android uses median REAL INSTALLS instead — Play publishes them
titleMatch  = 100 × (howManyOfTheTop10HaveEveryQueryWordInTheirName) / 10
specificity = max(0, 100 - (wordCount - 1) × 25)

difficulty  = round(0.53·leaders + 0.35·titleMatch + 0.12·specificity)`}</Formula>
        <p className="mt-2">
          There is deliberately <strong className="text-[var(--fg)]">no result-count component</strong>. We tested it:
          the store&apos;s reported result count saturates against a 200-row response cap (<em>game</em> returns 188,{" "}
          <em>zen breathing timer app</em> returns 178). Those differ by noise, not by real competition, so including
          it would add a near-constant ~15 points to every keyword and compress the useful range.
        </p>
        <p className="mt-2">
          Labels: <strong>≥75</strong> Very hard · <strong>≥55</strong> Hard · <strong>≥35</strong> Moderate ·{" "}
          <strong>&lt;35</strong> Winnable. Every difficulty cell has an <span className="num">ⓘ</span> showing these
          three components, because &ldquo;hard because the incumbents are huge&rdquo; is actionable and
          &ldquo;difficulty 61&rdquo; is not.
        </p>
        <p className="mt-2 text-[var(--warn)]">
          If we have never fetched the results page for a keyword, difficulty is <code className="num">null</code>, not
          0. A zero would read as &ldquo;trivially easy&rdquo; and send you at an impossible keyword.
        </p>
      </Section>

      <Section title="Gap and Opportunity" measured={false}>
        <Formula>{`gap = popularity - difficulty        // null if either side is unknown

ease           = (100 - difficulty) / 100
demandWeighted = (popularity / 100) ^ 1.5      // dampens low-volume terms
upside(rank)   = unranked 0.80 · top3 0.10 · top10 0.25
                 · 11-30 1.00 · 31-60 0.75 · beyond 0.55

opportunity = round(100 × (0.40·demandWeighted + 0.35·upside + 0.15·ease + 0.10·relevance))`}</Formula>
        <p className="mt-2">
          Ranking #11–30 scores highest because that is where a small push actually pays off. #1 has nothing left to
          gain and #500 is a fantasy.
        </p>
      </Section>

      <Section title="Visibility and Share of Voice" measured={false}>
        <p>These two share one formula and differ only in what they include — and that difference is the insight.</p>
        <Formula>{`reach(rank) = #1 1.00 · #2 0.75 · #3 0.60 · ≤5 0.45 · ≤10 0.30
              · ≤20 0.15 · ≤50 0.06 · ≤100 0.02 · beyond 0.005

score(K) = 100 × Σ popularity(k)·reach(rank(k)) / Σ popularity(k)

Visibility     = score(all tracked keywords)
Share of Voice = score(tracked keywords where branded = false)`}</Formula>
        <p className="mt-2">
          An app ranks #1–#2 for its own name in every market, so branded terms pull Visibility up hard. Strip them out
          and what remains is how much <em>generic</em> demand you actually capture. Visibility 89 with a Share of Voice
          of 7.7% is telling you something specific: you dominate your own name and almost nothing else.
        </p>
      </Section>

      <Section title="Competitive buckets" measured>
        <Formula>{`gap      → a competitor ranked in the TOP 30 in the last 7 days, and you have no rank
winnable → a gap that ALSO has difficulty ≤ 40 and popularity ≥ 20
threat   → a competitor climbed ≥5 places INTO the top 20 vs a ~2-week baseline
lead     → you are in the top 10 AND ahead of every tracked competitor`}</Formula>
        <p className="mt-2">
          A competitor sitting at #180 is not an opportunity, so a gap needs top-30. Without the popularity floor,
          &ldquo;winnable&rdquo; fills with easy keywords nobody searches. A threat is defined by <em>movement</em> —
          a competitor parked at #4 forever is not news. And a threat needs an actual 14-day baseline: with no history
          there is no measurable movement, so nothing is reported rather than everything.
        </p>
      </Section>

      <Section title="Est. #1 downloads" measured={false}>
        <Formula>{`dailyImpressions(SP) = 254.4443 × exp(0.0615 × SP)
estimate             = round2sf(dailyImpressions × 0.07)`}</Formula>
        <p className="mt-2 text-[var(--warn)]">
          This curve is <strong>vendor folklore, not an Apple specification.</strong> Apple has never published a
          popularity-to-impressions mapping; the constants come from a third-party fit. It is defensible as a rough
          monotonic mapping and it is what competitors use, but it is an order of magnitude, not a forecast. We round to
          two significant figures for exactly that reason — <code className="num">670</code>, never{" "}
          <code className="num">672.4</code>. The column is off by default.
        </p>
      </Section>

      <Section title="Revenue estimates" measured={false}>
        <p>
          Modelled from install counts, real scraped in-app prices, category conversion benchmarks and retention
          assumptions. <strong className="text-[var(--fg)]">Nothing below $5,000/month is shown as a number</strong> —
          it renders <code className="num">&lt;$5K/mo</code>, because precision we do not have is a lie. iOS is always
          lower-confidence than Android, since Apple hides install counts entirely and we have to model them from
          rating volume. For competitive benchmarking, not financial reporting.
        </p>
      </Section>

      <Section title="Where the data comes from" measured>
        <ul className="list-disc space-y-1 pl-5">
          <li>App Store autocomplete — the demand signal, ordered by Apple&apos;s own popularity ranking</li>
          <li>The App Store&apos;s ranked search endpoint — 250 results deep, the true store ordering</li>
          <li>The iTunes lookup API — app metadata in batches of 200</li>
          <li>App Store product pages — subtitles and full 5-star rating histograms</li>
          <li>The public customer-reviews feed</li>
          <li>Google Play search, suggest and app pages — including exact install counts</li>
        </ul>
        <p className="mt-2">
          Every one is free and public. Ranks are always scoped to a specific store and country, because a rank without
          a storefront is meaningless.
        </p>
      </Section>

      <div className="mt-10 rounded-[var(--radius)] border border-[var(--border)] p-4">
        <h2 className="text-[14px] font-semibold">Two rules we hold ourselves to</h2>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-[13px] text-[var(--fg-muted)]">
          <li>
            <strong className="text-[var(--fg)]">Missing is not zero.</strong> Anything we have not measured renders as
            an em dash, never as 0. A difficulty of 0 means trivially easy; an unmeasured difficulty means we do not
            know, and confusing the two would send you at impossible keywords.
          </li>
          <li>
            <strong className="text-[var(--fg)]">Every estimate is labelled.</strong> Parentheses, a glyph or a tooltip,
            plus a legend on the same screen. If we modelled it, we say so.
          </li>
        </ol>
      </div>
    </main>
  );
}

function Section({ title, children, measured }: { title: string; children: React.ReactNode; measured?: boolean }) {
  return (
    <section className="mt-8">
      <div className="flex items-center gap-2">
        <h2 className="text-[16px] font-semibold">{title}</h2>
        <span
          className="rounded-[var(--radius-chip)] px-1.5 py-0.5 text-[10px] font-medium"
          style={
            measured
              ? { color: "var(--up)", background: "rgba(34,197,94,0.12)" }
              : { color: "var(--warn)", background: "rgba(245,158,11,0.12)" }
          }
        >
          {measured ? "measured" : "modelled"}
        </span>
      </div>
      <div className="mt-2 text-[13.5px] leading-relaxed text-[var(--fg-muted)]">{children}</div>
    </section>
  );
}

function Formula({ children }: { children: string }) {
  return (
    <pre className="num mt-2 overflow-x-auto rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-panel)] p-3 text-[11.5px] leading-relaxed text-[var(--fg)]">
      {children}
    </pre>
  );
}

function Callout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 rounded-[var(--radius)] border border-[var(--warn)] bg-[rgba(245,158,11,0.07)] p-4 text-[13.5px] leading-relaxed text-[var(--fg-muted)]">
      {children}
    </div>
  );
}
