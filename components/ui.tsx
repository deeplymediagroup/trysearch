/**
 * The shared display components — 06-FRONTEND-SPEC.md §3.2.
 *
 * These are where the product's two hardest rules are enforced in the UI:
 *   - missing ≠ zero (DeltaBadge, RankPill, KpiTile all render null as an em dash)
 *   - every score is explainable (ScoreCell's ⓘ popover shows the inputs)
 *
 * Accessibility is not optional: never encode meaning in colour alone, so every coloured
 * value also carries a sign or a word.
 */
import * as fmt from "@/lib/format";
import { COUNTRY_NAMES } from "@/lib/stores/storefronts.mjs";

// ---------------------------------------------------------------------------
// Panels and headings
// ---------------------------------------------------------------------------

export function Panel({
  title,
  caption,
  action,
  children,
  className = "",
}: {
  title?: string;
  caption?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel p-4 ${className}`}>
      {(title || action) && (
        <header className="mb-3 flex items-start justify-between gap-3">
          <div>
            {title && <h2 className="text-[13px] font-semibold text-[var(--fg)]">{title}</h2>}
            {/* Every panel states its data source in a caption. */}
            {caption && <p className="mt-0.5 text-[11px] text-[var(--fg-subtle)]">{caption}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * KpiTile — must render a null value as an em dash, never 0.
 * Big number on top with the delta beside it, quiet label underneath. Meant to sit inside
 * KpiStrip's connected row.
 */
export function KpiTile({
  label,
  value,
  delta,
  subLabel,
  suffix,
}: {
  label: string;
  value: string | number | null | undefined;
  delta?: number | null;
  subLabel?: string;
  suffix?: string;
}) {
  const display = value == null || value === "" ? fmt.EM_DASH : String(value);
  return (
    <div className="min-w-0 flex-1 px-4 py-3.5">
      <div className="flex items-baseline gap-1.5">
        <span className="truncate text-[22px] font-semibold leading-none tracking-tight tabular-nums">{display}</span>
        {suffix && <span className="text-[12px] text-[var(--fg-subtle)]">{suffix}</span>}
        {delta !== undefined && <DeltaBadge value={delta} />}
      </div>
      <div className="mt-1 truncate text-[12px] text-[var(--fg-subtle)]" title={subLabel ? `${label} — ${subLabel}` : label}>
        {label}
        {subLabel && <span className="hidden xl:inline"> · {subLabel}</span>}
      </div>
    </div>
  );
}

/** The connected KPI row: one bordered container, hairline dividers between tiles. */
export function KpiStrip({ children }: { children: React.ReactNode }) {
  return <div className="panel flex flex-wrap divide-x divide-[var(--border)] overflow-hidden p-0">{children}</div>;
}

/**
 * DeltaBadge — the four states must be visually distinct, and this is where the
 * missing-≠-zero rule is enforced in the UI.
 *
 * '+30' green · '-64' red · '0' GREY (deliberately not green) · '—' for missing.
 */
export function DeltaBadge({ value, showZero = true }: { value: number | null | undefined; showZero?: boolean }) {
  const tone = fmt.deltaTone(value);
  if (tone === "none") {
    return (
      <span className="num text-[12px] text-[var(--fg-subtle)]" title="No comparison available">
        {fmt.EM_DASH}
      </span>
    );
  }
  if (tone === "zero" && !showZero) return null;

  const colour = tone === "up" ? "var(--up)" : tone === "down" ? "var(--down)" : "var(--neutral)";
  // The arrow is a second, non-colour signal — colour-blind users are a large share of developers.
  const glyph = tone === "up" ? "↑" : tone === "down" ? "↓" : "";
  const label = tone === "up" ? "improved by" : tone === "down" ? "worsened by" : "unchanged";

  return (
    <span className="num text-[12px] font-medium" style={{ color: colour }} title={`${label} ${Math.abs(value ?? 0)}`}>
      {glyph}
      {fmt.delta(value)}
    </span>
  );
}

const BRACKET_COLOURS: Record<string, string> = {
  top3: "var(--rank-top3)",
  r4_10: "var(--rank-4-10)",
  r11_30: "var(--rank-11-30)",
  r31_100: "var(--rank-31-100)",
  r100_plus: "var(--rank-100plus)",
};

function bracketOf(rank: number | null): string | null {
  if (rank == null) return null;
  if (rank <= 3) return "top3";
  if (rank <= 10) return "r4_10";
  if (rank <= 30) return "r11_30";
  if (rank <= 100) return "r31_100";
  return "r100_plus";
}

/** Value-scaled tones, shared by the popularity and difficulty cells. */
/**
 * Score colours, sampled from the reference tool's own computed styles rather than guessed:
 * green rgb(97,255,202), amber rgb(255,151,47), red rgb(251,57,67), and a muted
 * rgb(159,151,139) for a store-floored popularity of 5, which is "no measurable demand" and
 * must not read as a red alarm.
 *
 * Thresholds are theirs too, read off live rows: popularity 55 is green and 50 is amber;
 * difficulty 60 is amber and 61 is red.
 */
export const SCORE_GREEN = "rgb(97, 255, 202)";
export const SCORE_AMBER = "rgb(255, 151, 47)";
export const SCORE_RED = "rgb(251, 57, 67)";
export const SCORE_MUTED = "rgb(159, 151, 139)";

export function popularityTone(v: number) {
  if (v <= 5) return SCORE_MUTED; // the store's floor: not demand, not an alarm
  return v >= 55 ? SCORE_GREEN : v >= 30 ? SCORE_AMBER : SCORE_RED;
}

export function difficultyTone(v: number) {
  return v < 30 ? SCORE_GREEN : v <= 60 ? SCORE_AMBER : SCORE_RED;
}

/**
 * RankPill — the four-valued rank state as plain bracket-coloured text.
 * The bracket colours are the SAME ones the stacked chart uses, deliberately.
 */
export function RankPill({ state }: { state: fmt.RankState | null | undefined }) {
  const text = fmt.rank(state);
  const bracket = bracketOf(state?.rank ?? null);

  if (state?.rank != null && bracket) {
    return (
      <span className="num text-[13px] font-medium" style={{ color: BRACKET_COLOURS[bracket] }}>
        {text}
      </span>
    );
  }

  // Fell out of the crawl depth: muted with a warning tint, and the last known position
  // rendered smaller so the primary state stays readable.
  if (text.startsWith(">") || text.includes("was #")) {
    const [main, was] = text.split(" (");
    return (
      <span className="num inline-flex items-baseline gap-1 text-[12px] text-[var(--warn)]">
        {main}
        {was && <span className="text-[10px] text-[var(--fg-subtle)]">({was.replace(")", "")})</span>}
      </span>
    );
  }

  return <span className="num text-[12px] text-[var(--fg-subtle)]">{text}</span>;
}

/**
 * ScoreCell — a 0-100 value with an inline bar and an ⓘ popover showing the component
 * breakdown. This is THE trust feature: "hard because the incumbents are huge" is actionable,
 * "difficulty 61" is not.
 */
export function ScoreCell({
  value,
  parts,
  label,
  max = 100,
  tone,
}: {
  value: number | null | undefined;
  parts?: Record<string, unknown> | null;
  label?: string;
  max?: number;
  tone?: string;
}) {
  if (value == null) {
    return (
      <span className="num text-[12px] text-[var(--fg-subtle)]" title="Not measured — we don't know, which is different from zero">
        {fmt.EM_DASH}
      </span>
    );
  }

  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const rows = parts ? breakdownRows(parts) : [];
  // Default tone scales with the value the way a difficulty reads: low green, high red.
  const colour = tone ?? difficultyTone(value);

  return (
    <span className="group/score relative inline-flex items-center gap-2">
      <span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-[var(--bg-hover)]">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: colour }} />
      </span>
      <span className="num text-[12.5px] font-medium tabular-nums" style={{ color: colour }}>
        {fmt.score(value)}
      </span>

      {rows.length > 0 && (
        <>
          <button
            type="button"
            className="text-[10px] text-[var(--fg-subtle)] hover:text-[var(--fg)]"
            aria-label={`${label ?? "Score"} breakdown: ${rows.map((r) => `${r.label} ${r.value}`).join(", ")}`}
          >
            ⓘ
          </button>
          {/* CSS-only popover: no client JS needed for a read-only disclosure. */}
          <span
            role="tooltip"
            className="pointer-events-none invisible absolute left-0 top-full z-50 mt-1 w-60 rounded-[var(--radius-chip)] border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-2.5 text-left opacity-0 shadow-lg transition-opacity group-hover/score:visible group-hover/score:opacity-100 group-focus-within/score:visible group-focus-within/score:opacity-100"
          >
            <span className="th mb-1.5 block">{label ?? "Breakdown"}</span>
            {rows.map((r) => (
              <span key={r.label} className="flex items-baseline justify-between gap-2 py-0.5 text-[11px]">
                <span className="text-[var(--fg-muted)]">{r.label}</span>
                <span className="num text-[var(--fg)]">{r.value}</span>
              </span>
            ))}
          </span>
        </>
      )}
    </span>
  );
}

const PART_LABELS: Record<string, string> = {
  leaders: "Incumbent size",
  titleMatch: "Title targeting",
  specificity: "Specificity",
  appsAnalyzed: "Apps analysed",
  serpDepth: "Results returned",
  medianStrength: "Median ratings",
  titleMatches: "Titles with the term",
  strengthMetric: "Strength measured by",
  reveal: "Reveal depth",
  slot: "Slot in list",
  position: "Best position",
  breadth: "Prefix breadth",
  revealed_at_char: "Revealed at character",
  revealed_at_position: "Revealed at position",
  prefixes_seen: "Prefixes seen",
  auto_score: "Autocomplete score",
  install_score: "Install-volume score",
  median_real_installs: "Median real installs",
};

function breakdownRows(parts: Record<string, unknown>) {
  const out: { label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(parts)) {
    if (raw == null || typeof raw === "object") continue;
    const label = PART_LABELS[key];
    if (!label) continue;
    out.push({ label, value: typeof raw === "number" ? fmt.count(raw) : String(raw) });
  }
  return out;
}

/**
 * PopularityCell — renders '54' (measured) or '5 (28)' (the parenthesised number is ours).
 * A store glyph marks a genuinely store-sourced value.
 */
export function PopularityCell({
  keyword,
}: {
  keyword: { popularity?: number | null; popularity_estimate?: number | null; popularity_source?: string | null; platform?: string } | null;
}) {
  const text = fmt.popularity(keyword);
  const estimated = fmt.popularityIsEstimated(keyword);
  const fromStore = keyword?.popularity != null;
  const effective = keyword?.popularity_estimate ?? keyword?.popularity ?? null;

  if (effective == null) {
    return (
      <span className="num text-[12px] text-[var(--fg-subtle)]" title="Not measured — we don't know, which is different from zero.">
        {fmt.EM_DASH}
      </span>
    );
  }

  // Bar + plain value-coloured number, same grammar as the difficulty cell: green when
  // demand is real, amber mid, red weak. Parentheses still mean "our estimate" (house rule),
  // and the floored store value keeps its "5 (28)" form.
  const tone = popularityTone(effective);
  const pct = Math.max(4, Math.min(100, effective));

  return (
    <span
      className="inline-flex items-center gap-2"
      title={
        estimated
          ? "The store floors low-volume keywords at 5. The number in parentheses is our own estimate from autocomplete position."
          : fromStore
            ? "Reported by Apple Search Ads."
            : "Our estimate from autocomplete position — parentheses mean modelled, not store-reported."
      }
    >
      <span aria-hidden className="h-1 w-10 overflow-hidden rounded-full bg-[var(--bg-hover)]">
        <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: tone }} />
      </span>
      <span className="num text-[12.5px] font-medium tabular-nums" style={{ color: tone }}>
        {fromStore && keyword?.platform === "ios" && <span aria-label="store-reported" className="mr-0.5 text-[9px] text-[var(--fg-subtle)]">&#63743;</span>}
        {text}
      </span>
    </span>
  );
}

/** Chip — Branded / Generic / Beatable / source chips. */
const CHIP_TONES: Record<string, { fg: string; bg: string }> = {
  branded: { fg: "var(--accent)", bg: "var(--accent-soft)" },
  beatable: { fg: "rgb(119, 255, 214)", bg: "rgba(119, 255, 214, 0.15)" },
  warn: { fg: "var(--warn)", bg: "rgba(245,158,11,0.12)" },
  neutral: { fg: "var(--fg-muted)", bg: "var(--bg-hover)" },
};

export function Chip({
  children,
  tone = "neutral",
  title,
}: {
  children: React.ReactNode;
  tone?: keyof typeof CHIP_TONES;
  title?: string;
}) {
  const t = CHIP_TONES[tone] ?? CHIP_TONES.neutral;
  return (
    <span
      title={title}
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ color: t.fg, background: t.bg }}
    >
      {children}
    </span>
  );
}

export const SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  suggested: "Suggested",
  competitor: "Competitor",
  autocomplete: "Autocomplete",
  listing: "Your listing",
  ai: "AI",
  chart: "Chart",
  competitor_ai: "Competitor AI",
};

/** One colour per provenance, so a table of 900 rows reads by source at a glance. */
const SOURCE_COLORS: Record<string, { fg: string; bg: string }> = {
  manual: { fg: "rgb(172, 51, 255)", bg: "rgba(172, 51, 255, 0.15)" },
  suggested: { fg: "rgb(70, 147, 239)", bg: "rgba(70, 147, 239, 0.15)" },
  competitor: { fg: "#dc2626", bg: "rgba(220,38,38,0.12)" },
  competitor_ai: { fg: "#db2777", bg: "rgba(219,39,119,0.12)" },
  autocomplete: { fg: "#2563eb", bg: "rgba(37,99,235,0.12)" },
  listing: { fg: "rgb(119, 255, 214)", bg: "rgba(119, 255, 214, 0.15)" },
  ai: { fg: "rgb(190, 130, 255)", bg: "rgba(190, 130, 255, 0.15)" },
  chart: { fg: "#ea580c", bg: "rgba(234,88,12,0.12)" },
  play_console: { fg: "#0891b2", bg: "rgba(8,145,178,0.12)" },
};

export function SourceChip({ source }: { source: string }) {
  const c = SOURCE_COLORS[source] ?? SOURCE_COLORS.manual;
  return (
    <span
      title={`Source: ${SOURCE_LABELS[source] ?? source}`}
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ color: c.fg, background: c.bg }}
    >
      {SOURCE_LABELS[source] ?? source}
    </span>
  );
}

/** CountryFlag — never show a rank without one. Flag images (Windows has no flag emoji). */
export function CountryFlag({ country, showCode = true }: { country: string; showCode?: boolean }) {
  const cc = String(country ?? "").toLowerCase();
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" title={COUNTRY_NAMES[cc] ?? cc.toUpperCase()}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={`https://flagcdn.com/w20/${cc}.png`} alt="" width={16} height={12} loading="lazy" className="h-3 w-4 rounded-[2px] object-cover" />
      {showCode && <span className="num text-[11px] text-[var(--fg-muted)]">{cc.toUpperCase()}</span>}
    </span>
  );
}

/** AppIconStrip — the "Top Results" row. Hover reveals the app name and its rank. */
export function AppIconStrip({ apps, max = 6 }: { apps: { name?: string | null; icon_url?: string | null; position?: number }[]; max?: number }) {
  if (!apps.length) return <span className="text-[12px] text-[var(--fg-subtle)]">{fmt.EM_DASH}</span>;
  return (
    <span className="flex items-center -space-x-1">
      {apps.slice(0, max).map((a, i) => (
        <span
          key={`${a.name}-${i}`}
          title={`#${a.position ?? i + 1} ${a.name ?? "unknown"}`}
          className="inline-block h-5 w-5 shrink-0 overflow-hidden rounded-[5px] border border-[var(--border)] bg-[var(--bg-hover)]"
        >
          {a.icon_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={a.icon_url} alt="" width={20} height={20} className="h-full w-full object-cover" loading="lazy" />
          ) : null}
        </span>
      ))}
      {apps.length > max && <span className="num pl-2 text-[10px] text-[var(--fg-subtle)]">+{apps.length - max}</span>}
    </span>
  );
}

/**
 * Sparkline — a tiny inline rank trend with an INVERTED y-axis (rank 1 at the top).
 * Gaps are left as gaps: never interpolate across a day we did not measure.
 */
export function Sparkline({ ranks, width = 64, height = 18 }: { ranks: (number | null)[]; width?: number; height?: number }) {
  const points = ranks.map((r, i) => ({ i, r }));
  const measured = points.filter((p) => p.r != null) as { i: number; r: number }[];
  if (measured.length < 2) return <span className="text-[11px] text-[var(--fg-subtle)]">{fmt.EM_DASH}</span>;

  const maxRank = Math.max(...measured.map((p) => p.r));
  const minRank = Math.min(...measured.map((p) => p.r));
  const span = Math.max(1, maxRank - minRank);
  const stepX = width / Math.max(1, ranks.length - 1);

  // Inverted: a better (smaller) rank sits higher.
  const y = (r: number) => 1 + ((r - minRank) / span) * (height - 2);

  // Build separate path segments so missing days are visible gaps.
  const segments: string[] = [];
  let current: string[] = [];
  for (const p of points) {
    if (p.r == null) {
      if (current.length > 1) segments.push(current.join(" "));
      current = [];
      continue;
    }
    current.push(`${current.length ? "L" : "M"}${(p.i * stepX).toFixed(1)},${y(p.r).toFixed(1)}`);
  }
  if (current.length > 1) segments.push(current.join(" "));

  const improving = measured[measured.length - 1].r <= measured[0].r;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label={`Rank trend, currently #${measured[measured.length - 1].r}`} role="img">
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={improving ? "var(--up)" : "var(--down)"} strokeWidth="1.25" strokeLinecap="round" />
      ))}
    </svg>
  );
}

/** EmptyState — an explanation plus the action that fixes it. */
export function EmptyState({ title, children, action }: { title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed border-[var(--border)] px-6 py-10 text-center">
      <p className="text-[13px] font-medium text-[var(--fg)]">{title}</p>
      {children && <p className="max-w-md text-[12px] text-[var(--fg-muted)]">{children}</p>}
      {action}
    </div>
  );
}

/**
 * StalenessNote — required on every page that renders crawled data.
 * Silent stale data is worse than an error, so this is a product requirement, not just ops.
 */
export function StalenessNote({ date, label = "Store data as of" }: { date: Date | string | null | undefined; label?: string }) {
  if (!date) {
    return (
      <p className="text-[11px] text-[var(--warn)]">
        No crawl has run yet — run <code className="num">npm run crawl -- --all</code> to populate this page.
      </p>
    );
  }
  const d = date instanceof Date ? date : new Date(date);
  const stale = Date.now() - d.getTime() > 36 * 3600 * 1000;
  return (
    <p className={`text-[11px] ${stale ? "text-[var(--warn)]" : "text-[var(--fg-subtle)]"}`}>
      {label} {fmt.shortDate(d)} ({fmt.relativeDate(d)}){stale ? " — the nightly crawl may not have run." : ""}
    </p>
  );
}

/** The legend that must appear on any screen showing an estimate. */
export function EstimateLegend({ extra }: { extra?: string }) {
  return (
    <p className="text-[11px] text-[var(--fg-subtle)]">
      <span className="num">( )</span> = our estimate, not a store-reported number.{" "}
      <span className="num">{fmt.EM_DASH}</span> = not measured (different from zero).
      {extra ? ` ${extra}` : ""}
    </p>
  );
}

export function PlatformChip({ platform }: { platform: string }) {
  return <Chip tone="neutral" title={fmt.storeLabel(platform)}>{platform === "ios" ? "iOS" : "Android"}</Chip>;
}
