/**
 * Review analysis WITHOUT a language model.
 *
 * 07-CRAWLER-AND-JOBS.md §8 point 2: use a local heuristic classifier where it suffices, and
 * for review analysis it does. This is the 7-bucket keyword classifier from Brandon's
 * DATA-LAYER-SPEC, ported. It costs nothing, runs instantly, and needs no API key — which is
 * the whole point, since every other feature in this product is $0/month.
 *
 * If a real model is wired in later it goes behind lib/ai.ts and this stays as the fallback.
 */

export type ReviewLike = { rating: number; title?: string | null; body?: string | null };

const BUCKETS: { theme: string; group: "praise" | "complaints" | "feature_requests"; patterns: RegExp }[] = [
  {
    theme: "love",
    group: "praise",
    patterns: /\b(love|amazing|incredible|best app|life ?chang|excellent|fantastic|obsessed|perfect|brilliant|helped me|game ?changer)\b/i,
  },
  {
    theme: "content",
    group: "praise",
    patterns: /\b(content|speech|speeches|quotes?|audio|voice|narrat|playlist|variety|selection)\b/i,
  },
  {
    theme: "bug",
    group: "complaints",
    patterns: /\b(bug|crash|crashe?s|freez\w*|broken|glitch|error|won'?t (open|load|play)|stuck|not working|doesn'?t work|fails? to)\b/i,
  },
  {
    theme: "paywall_pricing",
    group: "complaints",
    patterns: /\b(expensive|overpriced|price|pricing|subscription|paywall|free trial|charged|refund|scam|rip ?off|too much money|cancel)\b/i,
  },
  {
    theme: "ads",
    group: "complaints",
    patterns: /\b(ads?|advert\w*|commercials?|pop ?ups?)\b/i,
  },
  {
    theme: "alarm",
    group: "complaints",
    patterns: /\b(alarm|wake ?up|snooze|didn'?t go off|notification)\b/i,
  },
  {
    theme: "feature_request",
    group: "feature_requests",
    patterns: /\b(wish|please add|would love|hope(fully)? (you|they)|suggestion|it would be (nice|great)|需要|feature request|add (a|an|more)|allow us)\b/i,
  },
  {
    theme: "content_request",
    group: "feature_requests",
    patterns: /\b(more (content|speeches|quotes|voices|categories|options)|new (content|speakers)|update the (content|library))\b/i,
  },
];

export type Theme = { theme: string; count: number; quotes: string[] };

export function classifyReviews(reviews: ReviewLike[]): {
  praise: Theme[];
  complaints: Theme[];
  feature_requests: Theme[];
  reviewCount: number;
} {
  const tally = new Map<string, { group: string; count: number; quotes: string[] }>();

  for (const r of reviews) {
    const text = `${r.title ?? ""} ${r.body ?? ""}`.trim();
    if (!text) continue;

    for (const bucket of BUCKETS) {
      if (!bucket.patterns.test(text)) continue;

      // A 4-5★ review mentioning "expensive" is a complaint inside a positive review; a 1-2★
      // review saying "love" is usually sarcasm or a caveat. Rating gates the praise bucket
      // so the summary is not misleading.
      if (bucket.group === "praise" && r.rating <= 3) continue;

      const entry = tally.get(bucket.theme) ?? { group: bucket.group, count: 0, quotes: [] };
      entry.count++;
      if (entry.quotes.length < 3) {
        const quote = (r.body ?? r.title ?? "").trim();
        if (quote) entry.quotes.push(quote.length > 180 ? `${quote.slice(0, 177)}…` : quote);
      }
      tally.set(bucket.theme, entry);
    }
  }

  const pick = (group: string) =>
    [...tally.entries()]
      .filter(([, v]) => v.group === group)
      .map(([theme, v]) => ({ theme, count: v.count, quotes: v.quotes }))
      .sort((a, b) => b.count - a.count);

  return {
    praise: pick("praise"),
    complaints: pick("complaints"),
    feature_requests: pick("feature_requests"),
    reviewCount: reviews.length,
  };
}
