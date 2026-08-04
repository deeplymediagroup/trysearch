"use client";

/**
 * Achievements — seven feats derived live from rank data (no table; the ranks ARE the
 * source of truth), plus a canvas-rendered shareable PNG card per unlocked feat.
 */
import { useRef } from "react";

export type Feat = {
  id: string;
  title: string;
  detail: string;
  unlocked: boolean;
  evidence?: string; // e.g. the keyword that did it
};

export function computeFeats(keywords: { term: string; rank: number | null; best_rank: number | null; delta_30d: number | null }[]): Feat[] {
  const ranked = keywords.filter((k) => k.rank != null);
  const everRanked = keywords.filter((k) => k.best_rank != null);
  const top10 = ranked.filter((k) => (k.rank as number) <= 10);
  const top3 = ranked.filter((k) => (k.rank as number) <= 3);
  const number1 = ranked.find((k) => k.rank === 1);
  const climber = keywords.find((k) => (k.delta_30d ?? 0) >= 20);
  const first = everRanked[0];

  return [
    { id: "first", title: "First rank", detail: "A keyword entered the charts", unlocked: everRanked.length > 0, evidence: first?.term },
    { id: "page-one", title: "Page One", detail: "A keyword in the top 10", unlocked: top10.length > 0, evidence: top10[0]?.term },
    { id: "podium", title: "Podium", detail: "A keyword in the top 3", unlocked: top3.length > 0, evidence: top3[0]?.term },
    { id: "number-one", title: "#1", detail: "The top spot on a keyword", unlocked: !!number1, evidence: number1?.term },
    { id: "climber", title: "20-spot Climber", detail: "+20 places in 30 days", unlocked: !!climber, evidence: climber?.term },
    { id: "five-top10", title: "High Five", detail: "5 keywords in the top 10", unlocked: top10.length >= 5, evidence: top10.length >= 5 ? `${top10.length} keywords` : undefined },
    { id: "ten-top10", title: "Perfect Ten", detail: "10 keywords in the top 10", unlocked: top10.length >= 10, evidence: top10.length >= 10 ? `${top10.length} keywords` : undefined },
  ];
}

export function AchievementsGrid({
  keywords,
  appName,
  hideApp = false,
}: {
  keywords: { term: string; rank: number | null; best_rank: number | null; delta_30d: number | null }[];
  appName: string;
  hideApp?: boolean;
}) {
  const feats = computeFeats(keywords);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  function share(feat: Feat) {
    const canvas = canvasRef.current ?? document.createElement("canvas");
    canvasRef.current = canvas;
    canvas.width = 1200;
    canvas.height = 630;
    const ctx = canvas.getContext("2d")!;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 1200, 630);
    ctx.fillStyle = "#f04c5a";
    ctx.fillRect(0, 0, 1200, 10);

    ctx.fillStyle = "#737373";
    ctx.font = "500 28px system-ui, sans-serif";
    ctx.fillText(hideApp ? "App Store Optimization" : appName, 80, 120);

    ctx.fillStyle = "#0a0a0a";
    ctx.font = "700 92px system-ui, sans-serif";
    ctx.fillText(feat.title, 80, 280);

    ctx.fillStyle = "#525252";
    ctx.font = "400 40px system-ui, sans-serif";
    ctx.fillText(feat.detail + (feat.evidence && !hideApp ? ` — “${feat.evidence}”` : ""), 80, 360);

    ctx.fillStyle = "#f04c5a";
    ctx.font = "600 30px system-ui, sans-serif";
    ctx.fillText("Unlocked " + new Date().toLocaleDateString(), 80, 540);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `achievement-${feat.id}.png`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {feats.map((f) => (
        <button
          key={f.id}
          type="button"
          disabled={!f.unlocked}
          onClick={() => share(f)}
          title={f.unlocked ? `${f.detail}${f.evidence ? ` — ${f.evidence}` : ""}. Click to download a share card.` : f.detail}
          className={`rounded-[var(--radius)] border p-2.5 text-left transition-colors ${
            f.unlocked
              ? "border-[var(--border)] bg-[var(--bg)] hover:border-[var(--accent)]"
              : "border-dashed border-[var(--border)] opacity-45"
          }`}
        >
          <span aria-hidden className="block text-[18px]">{f.unlocked ? "🏆" : "🔒"}</span>
          <span className="mt-1 block text-[12px] font-semibold leading-tight">{f.title}</span>
          <span className="block text-[10px] text-[var(--fg-subtle)]">{f.detail}</span>
        </button>
      ))}
    </div>
  );
}
