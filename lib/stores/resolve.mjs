/**
 * "Paste anything" app resolution — the parsing half, kept pure so it is testable with no
 * network and no database (see resolve.test.mjs).
 *
 * The fetching half lives in app/actions/apps.ts, which takes this result and asks the
 * right store about it.
 *
 * A dotted token is DELIBERATELY ambiguous: `com.example.app` is a valid iOS bundle id and a
 * valid Play package name, and nothing in the string distinguishes them. We say so rather
 * than guess, and the caller asks both stores.
 */

/**
 * @param {string} raw anything a teammate might paste: a store URL, a share link, a numeric
 *   iOS id, a bundle id / package name, or an app name.
 * @returns {null | { store: 'ios'|'android'|null, id?: string, bundle?: string, query?: string, country: string|null }}
 */
export function parseAppRef(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  // Apple: apps.apple.com/us/app/mindset/id1487761500, itunes.apple.com/app/id123, share links.
  if (/apple\.com/i.test(s)) {
    const id = s.match(/\/id(\d+)/)?.[1] ?? s.match(/[?&]id=(\d+)/)?.[1];
    // The two-letter path segment right after the host is the storefront. "app" is three
    // letters, so a country-less URL cannot match this by accident.
    const country = s.match(/apple\.com\/([a-z]{2})\//i)?.[1];
    if (id) return { store: "ios", id, country: country?.toLowerCase() ?? null };
  }

  // Play: play.google.com/store/apps/details?id=com.example.app&gl=gb
  if (/play\.google\.com/i.test(s)) {
    const id = s.match(/[?&]id=([A-Za-z0-9_.]+)/)?.[1];
    const country = s.match(/[?&](?:gl|hl)=([a-z]{2})\b/i)?.[1];
    if (id) return { store: "android", id, country: country?.toLowerCase() ?? null };
  }

  // A bare number is an iOS trackId. Apple's are 9-10 digits; allow 6-12 for old apps.
  if (/^\d{6,12}$/.test(s)) return { store: "ios", id: s, country: null };

  // Dotted, space-free → bundle id or package name. Which store is unknowable from the text.
  if (/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_-]+)+$/.test(s)) return { store: null, bundle: s, country: null };

  return { store: null, query: s, country: null };
}
