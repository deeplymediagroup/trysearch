"use client";

/**
 * Screenshot Studio — one client component drives the whole loop: pick a set → edit slides
 * on a full-resolution canvas → export App Store-ready PNGs. No canvas library; the draw
 * function is ~60 lines and that is the whole render engine.
 */
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Panel, EmptyState } from "./ui";
import { createSet, renameSet, deleteSet, duplicateSet, saveSlide, deleteSlide } from "@/app/actions/screenshots";

// ponytail: mirrored in app/actions/screenshots.ts — extract when device #4 arrives.
const DEVICES: Record<string, { width: number; height: number }> = {
  'iPhone 6.9"': { width: 1320, height: 2868 },
  'iPhone 6.5"': { width: 1284, height: 2778 },
  'iPad 13"': { width: 2064, height: 2752 },
};

export type SlideConfig = {
  background: { type: "solid" | "linear-gradient"; colors: [string, string] };
  headline: { content: string; color: string; size: number; weight: number; align: "left" | "center" | "right"; yOffset: number };
  subtext: { content: string; color: string; size: number };
  image: string | null; // data URL of the raw app screenshot
  textPosition: "above" | "below";
  locales: Record<string, { headline?: string; subtext?: string }>;
};

export type SetRow = { id: string; name: string; device_label: string; width_px: number; height_px: number };
export type SlideRow = { id: string | null; position: number; config: SlideConfig };

const DEFAULT_LOCALE = "en-US";

function defaultConfig(): SlideConfig {
  return {
    background: { type: "linear-gradient", colors: ["#111827", "#374151"] },
    headline: { content: "Your headline", color: "#ffffff", size: 96, weight: 700, align: "center", yOffset: 0 },
    subtext: { content: "", color: "#d1d5db", size: 52 },
    image: null,
    textPosition: "above",
    locales: {},
  };
}

// ---------------------------------------------------------------------------
// Canvas rendering — full App Store resolution, shared by preview and export
// ---------------------------------------------------------------------------

function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const probe = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(probe).width > maxWidth) {
        lines.push(line);
        line = word;
      } else {
        line = probe;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawSlide(ctx: CanvasRenderingContext2D, W: number, H: number, cfg: SlideConfig, locale: string, img: HTMLImageElement | null) {
  // background
  if (cfg.background.type === "linear-gradient") {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, cfg.background.colors[0]);
    g.addColorStop(1, cfg.background.colors[1]);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = cfg.background.colors[0];
  }
  ctx.fillRect(0, 0, W, H);

  const ov = locale === DEFAULT_LOCALE ? undefined : cfg.locales[locale];
  const headline = ov?.headline ?? cfg.headline.content;
  const subtext = ov?.subtext ?? cfg.subtext.content;

  const pad = Math.round(W * 0.07);
  const textAreaH = Math.round(H * 0.24);
  const above = cfg.textPosition === "above";

  // text block
  ctx.textAlign = cfg.headline.align;
  const tx = cfg.headline.align === "left" ? pad : cfg.headline.align === "right" ? W - pad : W / 2;
  let ty = (above ? pad + cfg.headline.size : H - textAreaH + cfg.headline.size) + cfg.headline.yOffset;
  ctx.font = `${cfg.headline.weight} ${cfg.headline.size}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillStyle = cfg.headline.color;
  for (const line of wrapText(ctx, headline, W - pad * 2)) {
    ctx.fillText(line, tx, ty);
    ty += Math.round(cfg.headline.size * 1.15);
  }
  if (subtext) {
    ty += Math.round(cfg.subtext.size * 0.5);
    ctx.font = `400 ${cfg.subtext.size}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = cfg.subtext.color;
    for (const line of wrapText(ctx, subtext, W - pad * 2)) {
      ctx.fillText(line, tx, ty);
      ty += Math.round(cfg.subtext.size * 1.3);
    }
  }

  // device frame — flat, rounded corners, a plain dark bezel; fits the free area
  const areaTop = above ? textAreaH : pad;
  const areaBottom = above ? H - pad : H - textAreaH;
  const availH = areaBottom - areaTop;
  const aspect = W / H; // the frame mimics the target device's own proportions
  const fw = Math.min((W - pad * 2) * 0.85, availH * aspect);
  const fh = fw / aspect;
  const fx = (W - fw) / 2;
  const fy = areaTop + (availH - fh) / 2;
  const bezel = Math.round(fw * 0.03);
  const radius = fw * 0.11;

  ctx.fillStyle = "#18181b";
  roundedPath(ctx, fx, fy, fw, fh, radius);
  ctx.fill();

  ctx.save();
  roundedPath(ctx, fx + bezel, fy + bezel, fw - bezel * 2, fh - bezel * 2, Math.max(0, radius - bezel));
  ctx.clip();
  if (img) {
    // cover-fit the screenshot inside the screen
    const sw = fw - bezel * 2;
    const sh = fh - bezel * 2;
    const scale = Math.max(sw / img.width, sh / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, fx + bezel + (sw - dw) / 2, fy + bezel + (sh - dh) / 2, dw, dh);
  } else {
    ctx.fillStyle = "#000000";
    ctx.fillRect(fx, fy, fw, fh);
  }
  ctx.restore();
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const safe = (s: string) => s.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "set";

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

const inputCls = "h-7 w-full rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] px-2 text-[12px]";
const btnCls = "h-7 shrink-0 rounded-[var(--radius-chip)] border border-[var(--border)] px-2 text-[12px] text-[var(--fg-muted)] hover:text-[var(--fg)]";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="th mb-1 block">{label}</span>
      {children}
    </label>
  );
}

export function ScreenshotStudio({
  trackedAppId,
  sets,
  selected,
  slides: initialSlides,
}: {
  trackedAppId: string | null;
  sets: SetRow[];
  selected: SetRow | null;
  slides: SlideRow[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newDevice, setNewDevice] = useState('iPhone 6.9"');

  // Local slide state — edits live here until Save; new slides exist only here until saved.
  const [slides, setSlides] = useState<SlideRow[]>(() =>
    initialSlides.length ? initialSlides.map((s) => ({ ...s, config: { ...defaultConfig(), ...s.config } })) : [],
  );
  const [sel, setSel] = useState(0);
  const [locale, setLocale] = useState(DEFAULT_LOCALE);
  const [newLocale, setNewLocale] = useState("");
  const [extraLocales, setExtraLocales] = useState<string[]>(() => {
    const set = new Set<string>();
    for (const s of initialSlides) for (const l of Object.keys(s.config?.locales ?? {})) set.add(l);
    return [...set];
  });
  const [dirty, setDirty] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const undoRef = useRef<{ stack: string[]; lastPush: number }>({ stack: [], lastPush: 0 });

  const slide = slides[sel] ?? null;
  const W = selected?.width_px ?? 1320;
  const H = selected?.height_px ?? 2868;

  const run = (fn: () => Promise<{ error?: string } | void>) =>
    start(async () => {
      setError(null);
      const res = await fn();
      if (res && res.error) setError(res.error);
      else router.refresh();
    });

  // Undo: coalesced 20-deep snapshot stack of all slides.
  const update = (fn: (c: SlideConfig) => SlideConfig) => {
    setSlides((prev) => {
      const now = Date.now();
      if (now - undoRef.current.lastPush > 500) {
        undoRef.current.stack.push(JSON.stringify(prev));
        if (undoRef.current.stack.length > 20) undoRef.current.stack.shift();
        undoRef.current.lastPush = now;
      }
      return prev.map((s, i) => (i === sel ? { ...s, config: fn(s.config) } : s));
    });
    setDirty((d) => new Set(d).add(sel));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return; // native undo wins in fields
      const snap = undoRef.current.stack.pop();
      if (snap) {
        e.preventDefault();
        setSlides(JSON.parse(snap));
        undoRef.current.lastPush = 0;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Load the current slide's screenshot for the preview.
  useEffect(() => {
    let alive = true;
    if (slide?.config.image) loadImage(slide.config.image).then((img) => alive && setImgEl(img)).catch(() => alive && setImgEl(null));
    else setImgEl(null);
    return () => {
      alive = false;
    };
  }, [slide?.config.image]);

  // Redraw the preview whenever anything visual changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !slide) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawSlide(ctx, W, H, slide.config, locale, imgEl);
  }, [slide, locale, imgEl, W, H]);

  const onUpload = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 5_000_000) return setError("Screenshot too large — keep it under 5 MB.");
    const reader = new FileReader();
    reader.onload = () => update((c) => ({ ...c, image: String(reader.result) }));
    reader.readAsDataURL(file);
  };

  const addSlide = () => {
    const position = slides.length ? Math.max(...slides.map((s) => s.position)) + 1 : 1;
    setSlides((prev) => [...prev, { id: null, position, config: defaultConfig() }]);
    setDirty((d) => new Set(d).add(slides.length));
    setSel(slides.length);
  };

  const duplicateSlide = () => {
    if (!slide) return;
    const position = Math.max(...slides.map((s) => s.position)) + 1;
    setSlides((prev) => [...prev, { id: null, position, config: JSON.parse(JSON.stringify(slide.config)) }]);
    setDirty((d) => new Set(d).add(slides.length));
    setSel(slides.length);
  };

  const removeSlide = (i: number) => {
    const s = slides[i];
    setSlides((prev) => prev.filter((_, j) => j !== i));
    setSel((cur) => Math.max(0, cur >= i ? cur - 1 : cur));
    setDirty((d) => {
      const next = new Set([...d].filter((j) => j !== i).map((j) => (j > i ? j - 1 : j)));
      return next;
    });
    if (s.id && selected) run(() => deleteSlide(selected.id, s.position));
  };

  const save = (i: number) => {
    const s = slides[i];
    if (!s || !selected) return;
    run(async () => {
      const res = await saveSlide(selected.id, s.position, s.config as unknown as Record<string, unknown>);
      if (!res.error) setDirty((d) => { const next = new Set(d); next.delete(i); return next; });
      return res;
    });
  };

  const exportOne = async (s: SlideRow) => {
    if (!selected) return;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d")!;
    const img = s.config.image ? await loadImage(s.config.image).catch(() => null) : null;
    drawSlide(ctx, W, H, s.config, locale, img);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (blob) downloadBlob(blob, `${safe(selected.name)}-${locale}-${s.position}.png`);
  };

  const exportAll = async () => {
    setExporting(true);
    try {
      for (const s of slides) {
        await exportOne(s);
        await new Promise((r) => setTimeout(r, 400)); // let the browser accept each download
      }
    } finally {
      setExporting(false);
    }
  };

  const locales = [DEFAULT_LOCALE, ...extraLocales];
  const ov = slide && locale !== DEFAULT_LOCALE ? slide.config.locales[locale] : undefined;

  if (!trackedAppId) {
    return (
      <div className="p-6">
        <EmptyState title="Track an app first">Screenshot sets belong to a tracked app — add one from the sidebar.</EmptyState>
      </div>
    );
  }

  return (
    <div className="grid gap-4 p-6 lg:grid-cols-[240px_1fr_270px]">
      {/* ------------------------------------------------ left: sets + slides */}
      <div className="space-y-3">
        <Panel title="Sets">
          <div className="space-y-1.5">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="New set name" aria-label="New set name" className={inputCls} />
            <div className="flex gap-1.5">
              <select value={newDevice} onChange={(e) => setNewDevice(e.target.value)} aria-label="Device" className={`${inputCls} flex-1`}>
                {Object.keys(DEVICES).map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={pending || !newName.trim()}
                onClick={() => run(async () => { const r = await createSet(trackedAppId, newName, newDevice); if (!r.error) setNewName(""); return r; })}
                className="h-7 shrink-0 rounded-[var(--radius-chip)] bg-[var(--primary)] px-2 text-[12px] font-medium text-white disabled:opacity-50"
              >
                Create
              </button>
            </div>
          </div>
          <ul className="mt-2 space-y-0.5">
            {sets.map((s) => (
              <li key={s.id} className="flex items-center gap-1">
                <Link
                  href={`/screenshots?id=${s.id}`}
                  className={`min-w-0 flex-1 truncate rounded px-1.5 py-1 text-[12.5px] ${selected?.id === s.id ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)] hover:text-[var(--fg)]"}`}
                >
                  {s.name} <span className="num text-[10px] text-[var(--fg-subtle)]">{s.width_px}×{s.height_px}</span>
                </Link>
                <button
                  type="button"
                  title="Rename set"
                  onClick={() => { const n = window.prompt("Set name", s.name); if (n != null) run(() => renameSet(s.id, n)); }}
                  className="shrink-0 rounded px-1 text-[11px] text-[var(--fg-subtle)] hover:text-[var(--fg)]"
                >
                  ✎
                </button>
                <button
                  type="button"
                  title="Delete set and all its slides"
                  onClick={() => { if (window.confirm(`Delete "${s.name}" and all its slides?`)) run(() => deleteSet(s.id)); }}
                  className="shrink-0 rounded px-1 text-[12px] text-[var(--fg-subtle)] hover:text-[var(--down)]"
                >
                  ✕
                </button>
              </li>
            ))}
            {sets.length === 0 && <li className="text-[11.5px] text-[var(--fg-subtle)]">No sets yet.</li>}
          </ul>
          {selected && (
            <select
              value=""
              onChange={(e) => { if (e.target.value) run(() => duplicateSet(selected.id, e.target.value === "same" ? undefined : e.target.value)); }}
              aria-label="Duplicate set"
              className={`${inputCls} mt-2`}
            >
              <option value="">Duplicate this set…</option>
              <option value="same">Same device ({selected.device_label})</option>
              {Object.keys(DEVICES).filter((d) => d !== selected.device_label).map((d) => (
                <option key={d} value={d}>To {d}</option>
              ))}
            </select>
          )}
        </Panel>

        {selected && (
          <Panel title="Slides" caption={selected.device_label}>
            <ul className="space-y-0.5">
              {slides.map((s, i) => (
                <li key={`${s.position}`} className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setSel(i)}
                    className={`min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-[12.5px] ${sel === i ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--fg-muted)] hover:text-[var(--fg)]"}`}
                  >
                    <span className="num">{s.position}.</span> {s.config.headline.content || "Untitled"}
                    {dirty.has(i) && <span className="pl-1 text-[var(--warn)]" title="Unsaved changes">●</span>}
                  </button>
                  <button type="button" title="Delete slide" onClick={() => removeSlide(i)} className="shrink-0 rounded px-1 text-[12px] text-[var(--fg-subtle)] hover:text-[var(--down)]">
                    ✕
                  </button>
                </li>
              ))}
              {slides.length === 0 && <li className="text-[11.5px] text-[var(--fg-subtle)]">No slides yet.</li>}
            </ul>
            <div className="mt-2 flex gap-1.5">
              <button type="button" onClick={addSlide} disabled={slides.length >= 10} className={btnCls}>+ Add</button>
              <button type="button" onClick={duplicateSlide} disabled={!slide || slides.length >= 10} className={btnCls}>Duplicate</button>
            </div>
          </Panel>
        )}
      </div>

      {/* ------------------------------------------------ centre: canvas */}
      <div className="space-y-3">
        {error && <p className="text-[12px] text-[var(--down)]">{error}</p>}
        {!selected ? (
          <Panel>
            <EmptyState title="Pick or create a set">
              A set is one device size's worth of App Store screenshots. Create one on the left, add slides, and export
              full-resolution PNGs.
            </EmptyState>
          </Panel>
        ) : !slide ? (
          <Panel>
            <EmptyState title="Add a slide" action={<button type="button" onClick={addSlide} className="btn-primary h-8 px-3 text-[12px]">Add slide</button>}>
              Each slide renders at {W}×{H} — the exact resolution App Store Connect expects for {selected.device_label}.
            </EmptyState>
          </Panel>
        ) : (
          <Panel
            title={`Slide ${slide.position} — ${W}×${H}`}
            caption="Rendered at full resolution, scaled to fit. Ctrl+Z undoes."
            action={
              <div className="flex gap-1.5">
                <button type="button" disabled={pending || !dirty.has(sel)} onClick={() => save(sel)} className="btn-primary h-7 px-2.5 text-[12px] disabled:opacity-50">
                  {dirty.has(sel) ? "Save slide" : "Saved"}
                </button>
                <button type="button" disabled={exporting} onClick={() => exportOne(slide)} className={btnCls}>Export PNG</button>
                <button type="button" disabled={exporting || !slides.length} onClick={exportAll} className={btnCls}>
                  {exporting ? "Exporting…" : "Export all"}
                </button>
              </div>
            }
          >
            <div className="flex justify-center rounded-[var(--radius-chip)] bg-[var(--bg-hover)] p-4">
              <canvas
                ref={canvasRef}
                width={W}
                height={H}
                role="img"
                aria-label={`Preview of slide ${slide.position}`}
                className="h-auto max-h-[72vh] w-auto max-w-full rounded-[6px] border border-[var(--border)]"
              />
            </div>
          </Panel>
        )}
      </div>

      {/* ------------------------------------------------ right: slide controls */}
      {selected && slide && (
        <div className="space-y-3">
          <Panel title="Locale" caption="Overrides apply to headline and subtext only.">
            <select value={locale} onChange={(e) => setLocale(e.target.value)} aria-label="Locale" className={inputCls}>
              {locales.map((l) => (
                <option key={l} value={l}>{l === DEFAULT_LOCALE ? `${l} (base)` : l}</option>
              ))}
            </select>
            <div className="mt-1.5 flex gap-1.5">
              <input value={newLocale} onChange={(e) => setNewLocale(e.target.value)} placeholder="e.g. de-DE" aria-label="Add locale" className={inputCls} />
              <button
                type="button"
                disabled={!newLocale.trim()}
                onClick={() => {
                  const code = newLocale.trim();
                  if (!extraLocales.includes(code) && code !== DEFAULT_LOCALE) setExtraLocales((p) => [...p, code]);
                  setLocale(code);
                  setNewLocale("");
                }}
                className={btnCls}
              >
                Add
              </button>
            </div>
          </Panel>

          <Panel title="Text">
            <div className="space-y-2.5">
              <Field label={locale === DEFAULT_LOCALE ? "Headline" : `Headline (${locale})`}>
                <textarea
                  value={locale === DEFAULT_LOCALE ? slide.config.headline.content : ov?.headline ?? ""}
                  placeholder={locale === DEFAULT_LOCALE ? "" : slide.config.headline.content}
                  onChange={(e) =>
                    update((c) =>
                      locale === DEFAULT_LOCALE
                        ? { ...c, headline: { ...c.headline, content: e.target.value } }
                        : { ...c, locales: { ...c.locales, [locale]: { ...c.locales[locale], headline: e.target.value } } },
                    )
                  }
                  rows={2}
                  className="w-full rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] p-2 text-[12px]"
                />
              </Field>
              <Field label={locale === DEFAULT_LOCALE ? "Subtext" : `Subtext (${locale})`}>
                <textarea
                  value={locale === DEFAULT_LOCALE ? slide.config.subtext.content : ov?.subtext ?? ""}
                  placeholder={locale === DEFAULT_LOCALE ? "" : slide.config.subtext.content}
                  onChange={(e) =>
                    update((c) =>
                      locale === DEFAULT_LOCALE
                        ? { ...c, subtext: { ...c.subtext, content: e.target.value } }
                        : { ...c, locales: { ...c.locales, [locale]: { ...c.locales[locale], subtext: e.target.value } } },
                    )
                  }
                  rows={2}
                  className="w-full rounded-[var(--radius-chip)] border border-[var(--border)] bg-[var(--bg-elevated)] p-2 text-[12px]"
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Headline colour">
                  <input type="color" value={slide.config.headline.color} onChange={(e) => update((c) => ({ ...c, headline: { ...c.headline, color: e.target.value } }))} className="h-7 w-full cursor-pointer rounded border border-[var(--border)]" />
                </Field>
                <Field label="Subtext colour">
                  <input type="color" value={slide.config.subtext.color} onChange={(e) => update((c) => ({ ...c, subtext: { ...c.subtext, color: e.target.value } }))} className="h-7 w-full cursor-pointer rounded border border-[var(--border)]" />
                </Field>
                <Field label="Headline size">
                  <input type="number" min={24} max={200} value={slide.config.headline.size} onChange={(e) => update((c) => ({ ...c, headline: { ...c.headline, size: Number(e.target.value) || 96 } }))} className={`${inputCls} num`} />
                </Field>
                <Field label="Subtext size">
                  <input type="number" min={16} max={120} value={slide.config.subtext.size} onChange={(e) => update((c) => ({ ...c, subtext: { ...c.subtext, size: Number(e.target.value) || 52 } }))} className={`${inputCls} num`} />
                </Field>
                <Field label="Weight">
                  <select value={slide.config.headline.weight} onChange={(e) => update((c) => ({ ...c, headline: { ...c.headline, weight: Number(e.target.value) } }))} className={inputCls}>
                    {[400, 500, 600, 700, 800].map((w) => (
                      <option key={w} value={w}>{w}</option>
                    ))}
                  </select>
                </Field>
                <Field label="Align">
                  <select value={slide.config.headline.align} onChange={(e) => update((c) => ({ ...c, headline: { ...c.headline, align: e.target.value as SlideConfig["headline"]["align"] } }))} className={inputCls}>
                    <option value="left">left</option>
                    <option value="center">center</option>
                    <option value="right">right</option>
                  </select>
                </Field>
                <Field label="Y offset (px)">
                  <input type="number" step={10} value={slide.config.headline.yOffset} onChange={(e) => update((c) => ({ ...c, headline: { ...c.headline, yOffset: Number(e.target.value) || 0 } }))} className={`${inputCls} num`} />
                </Field>
                <Field label="Text position">
                  <select value={slide.config.textPosition} onChange={(e) => update((c) => ({ ...c, textPosition: e.target.value as SlideConfig["textPosition"] }))} className={inputCls}>
                    <option value="above">above device</option>
                    <option value="below">below device</option>
                  </select>
                </Field>
              </div>
            </div>
          </Panel>

          <Panel title="Background">
            <div className="grid grid-cols-2 gap-2">
              <Field label="Type">
                <select
                  value={slide.config.background.type}
                  onChange={(e) => update((c) => ({ ...c, background: { ...c.background, type: e.target.value as SlideConfig["background"]["type"] } }))}
                  className={inputCls}
                >
                  <option value="solid">solid</option>
                  <option value="linear-gradient">gradient</option>
                </select>
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={slide.config.background.type === "solid" ? "Colour" : "Top"}>
                  <input type="color" value={slide.config.background.colors[0]} onChange={(e) => update((c) => ({ ...c, background: { ...c.background, colors: [e.target.value, c.background.colors[1]] } }))} className="h-7 w-full cursor-pointer rounded border border-[var(--border)]" />
                </Field>
                {slide.config.background.type === "linear-gradient" && (
                  <Field label="Bottom">
                    <input type="color" value={slide.config.background.colors[1]} onChange={(e) => update((c) => ({ ...c, background: { ...c.background, colors: [c.background.colors[0], e.target.value] } }))} className="h-7 w-full cursor-pointer rounded border border-[var(--border)]" />
                  </Field>
                )}
              </div>
            </div>
          </Panel>

          <Panel title="Screenshot" caption="Drawn inside the device frame, cover-fit.">
            <input
              type="file"
              accept="image/*"
              aria-label="Upload screenshot"
              onChange={(e) => onUpload(e.target.files?.[0])}
              className="block w-full text-[12px] text-[var(--fg-muted)] file:mr-2 file:h-7 file:cursor-pointer file:rounded-[var(--radius-chip)] file:border file:border-[var(--border)] file:bg-[var(--bg-elevated)] file:px-2 file:text-[12px]"
            />
            {slide.config.image && (
              <button type="button" onClick={() => update((c) => ({ ...c, image: null }))} className={`${btnCls} mt-2`}>
                Remove image
              </button>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
