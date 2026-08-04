/**
 * Storefront and genre identifiers — 02-DATA-SOURCES.md §3.5 and §8.1.
 *
 * Verified fact worth preserving: ONLY the numeric storefront id matters. `143441-1,29`,
 * `143441,29`, `143441-1,26` and `143441` all returned byte-identical US results, so the
 * `-N` language segment is decoration. We keep the plain number and append the platform
 * segment at the call site, because THAT part is load-bearing (see apple.mjs).
 */

export const STOREFRONTS = {
  us: 143441, gb: 143444, ca: 143455, au: 143460, nz: 143461, ie: 143449,
  de: 143443, fr: 143442, it: 143450, es: 143454, nl: 143452, be: 143446,
  at: 143445, ch: 143459, se: 143456, no: 143457, dk: 143458, fi: 143447,
  jp: 143462, kr: 143466, cn: 143465, hk: 143463, tw: 143470, sg: 143464,
  in: 143467, id: 143476, my: 143473, th: 143475, vn: 143471, ph: 143474,
  br: 143503, mx: 143468, ar: 143505, cl: 143483, co: 143501, pe: 143507,
  ru: 143469, pl: 143478, tr: 143480, za: 143472, ae: 143481, sa: 143479,
  pt: 143453, gr: 143448, cz: 143489, hu: 143482, ro: 143487, ua: 143492,
  // Second wave (2026-08): the long tail. Same decade-stable Apple storefront table.
  lu: 143451, pk: 143477, np: 143484, pa: 143485, lk: 143486, il: 143491,
  kw: 143493, hr: 143494, cr: 143495, sk: 143496, lb: 143497, qa: 143498,
  si: 143499, ve: 143502, gt: 143504, sv: 143506, do: 143508, ec: 143509,
  hn: 143510, jm: 143511, ni: 143512, py: 143513, uy: 143514, mo: 143515,
  eg: 143516, kz: 143517, ee: 143518, lv: 143519, lt: 143520, mt: 143521,
  md: 143523, am: 143524, bw: 143525, bg: 143526, jo: 143528, ke: 143529,
  mu: 143533, sn: 143535, tn: 143536, ug: 143537, tt: 143551, bz: 143555,
  bo: 143556, cy: 143557, is: 143558, bh: 143559, bn: 143560, ng: 143561,
  om: 143562, dz: 143563, by: 143565, uz: 143566, az: 143568, gh: 143573,
};

/**
 * Brandon's standing rule: Mindset is English-only content, so all ads/ASO work targets
 * English-first markets. This is the default country set for a new tracked app.
 */
export const ENGLISH_FIRST = ["us", "gb", "ca", "au", "nz", "ie"];

export function storefrontId(country) {
  const id = STOREFRONTS[String(country).toLowerCase()];
  if (!id) throw new Error(`Unknown storefront "${country}". Add it to STOREFRONTS.`);
  return id;
}

/** @type {Record<string, string>} */
export const COUNTRY_NAMES = {
  us: "United States", gb: "United Kingdom", ca: "Canada", au: "Australia",
  nz: "New Zealand", ie: "Ireland", de: "Germany", fr: "France", it: "Italy",
  es: "Spain", nl: "Netherlands", jp: "Japan", kr: "South Korea", br: "Brazil",
  mx: "Mexico", in: "India", se: "Sweden", no: "Norway", dk: "Denmark",
  fi: "Finland", pl: "Poland", tr: "Turkey", za: "South Africa",
  be: "Belgium", at: "Austria", ch: "Switzerland", cn: "China", hk: "Hong Kong",
  tw: "Taiwan", sg: "Singapore", id: "Indonesia", my: "Malaysia", th: "Thailand",
  vn: "Vietnam", ph: "Philippines", ar: "Argentina", cl: "Chile", co: "Colombia",
  pe: "Peru", ru: "Russia", ae: "United Arab Emirates", sa: "Saudi Arabia",
  pt: "Portugal", gr: "Greece", cz: "Czechia", hu: "Hungary", ro: "Romania",
  ua: "Ukraine", lu: "Luxembourg", pk: "Pakistan", np: "Nepal", pa: "Panama",
  lk: "Sri Lanka", il: "Israel", kw: "Kuwait", hr: "Croatia", cr: "Costa Rica",
  sk: "Slovakia", lb: "Lebanon", qa: "Qatar", si: "Slovenia", ve: "Venezuela",
  gt: "Guatemala", sv: "El Salvador", do: "Dominican Republic", ec: "Ecuador",
  hn: "Honduras", jm: "Jamaica", ni: "Nicaragua", py: "Paraguay", uy: "Uruguay",
  mo: "Macao", eg: "Egypt", kz: "Kazakhstan", ee: "Estonia", lv: "Latvia",
  lt: "Lithuania", mt: "Malta", md: "Moldova", am: "Armenia", bw: "Botswana",
  bg: "Bulgaria", jo: "Jordan", ke: "Kenya", mu: "Mauritius", sn: "Senegal",
  tn: "Tunisia", ug: "Uganda", tt: "Trinidad and Tobago", bz: "Belize",
  bo: "Bolivia", cy: "Cyprus", is: "Iceland", bh: "Bahrain", bn: "Brunei",
  ng: "Nigeria", om: "Oman", dz: "Algeria", by: "Belarus", uz: "Uzbekistan",
  az: "Azerbaijan", gh: "Ghana",
};

/** Flag emoji from an ISO-3166 alpha-2 code. Zero image requests (06 §6). */
export function flagEmoji(country) {
  const cc = String(country).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return "🏳";
  return String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * iOS genre ids. `app-store-scraper`'s constants are stale — it is MISSING 6026 Developer
 * Tools, 6027 Graphics & Design and 36 (All Apps), and still lists the retired 6022
 * Catalogs. This map is corrected. For live category lists prefer the `categories[]` array
 * in the charts SSR payload (02 §8.4.2), which stays current on its own.
 */
export const IOS_GENRES = {
  36: "All Apps",
  6018: "Books", 6000: "Business", 6026: "Developer Tools", 6017: "Education",
  6016: "Entertainment", 6015: "Finance", 6023: "Food & Drink", 6014: "Games",
  6027: "Graphics & Design", 6013: "Health & Fitness", 6012: "Lifestyle",
  6020: "Medical", 6011: "Music", 6010: "Navigation", 6009: "News",
  6013.1: "", 6008: "Photo & Video", 6007: "Productivity", 6006: "Reference",
  6024: "Shopping", 6005: "Social Networking", 6004: "Sports", 6003: "Travel",
  6002: "Utilities", 6001: "Weather",
};

/** Chart slugs used by the SSR charts route, e.g. /us/charts/iphone/health-fitness-apps/6013 */
export const GENRE_SLUGS = {
  36: "top-apps",
  6013: "health-fitness-apps",
  6012: "lifestyle-apps",
  6007: "productivity-apps",
  6017: "education-apps",
  6008: "photo-video-apps",
  6002: "utilities-apps",
  6015: "finance-apps",
  6018: "books-apps",
  6011: "music-apps",
  6005: "social-networking-apps",
  6016: "entertainment-apps",
  6014: "games-apps",
};

/** Android category ids, for Play category rankings. */
export const PLAY_CATEGORIES = {
  HEALTH_AND_FITNESS: "Health & Fitness",
  LIFESTYLE: "Lifestyle",
  PRODUCTIVITY: "Productivity",
  EDUCATION: "Education",
  TOOLS: "Tools",
  ENTERTAINMENT: "Entertainment",
  SOCIAL: "Social",
  FINANCE: "Finance",
  BOOKS_AND_REFERENCE: "Books & Reference",
  MUSIC_AND_AUDIO: "Music & Audio",
  PHOTOGRAPHY: "Photography",
};
