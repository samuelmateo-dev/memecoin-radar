import type { BatteryReport, BucketStats, RuleRow } from "./battery.js";
import type { PaperTradeReport } from "./paperTrades.js";

// Mise en forme texte des résultats (console). Pas de dépendance, colonnes alignées.

type Align = "l" | "r";

export function table(headers: string[], rows: string[][], align: Align[] = []): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const pad = (cell: string, i: number) =>
    (align[i] ?? (i === 0 ? "l" : "r")) === "l" ? cell.padEnd(widths[i]) : cell.padStart(widths[i]);
  const line = (cells: string[]) => "  " + cells.map(pad).join("   ");
  return [line(headers), "  " + widths.map((w) => "─".repeat(w)).join("───"), ...rows.map(line)].join("\n");
}

const x = (v: number, digits = 2) => (Number.isFinite(v) ? `×${v.toFixed(digits).replace(".", ",")}` : "—");
const pct = (v: number) => (Number.isFinite(v) ? `${v.toFixed(0)} %` : "—");
const pval = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : v < 0.001 ? "<0,001" : v.toFixed(3).replace(".", ","));
const sol = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(2).replace(".", ",")} SOL`;

/** Titre de section souligné (le numéro, s'il y en a un, fait partie du titre passé). */
export function section(title: string): string {
  return `\n${title}\n${"═".repeat(title.length)}`;
}

export function formatBuckets(buckets: BucketStats[]): string {
  return table(
    ["Tranche", "n", "Pic médian", "Pic moyen", "Atteint ×2"],
    buckets.map((b) => [b.label, String(b.n), x(b.medianPeak), x(b.meanPeak), pct(b.shareReachingX2)])
  );
}

export function formatExitGrid(rows: RuleRow[]): string {
  return table(
    ["Règle de sortie", "n", "Moyenne", "Médiane", "Moy. nette"],
    rows.map((r) => [r.label, String(r.n), x(r.mean), x(r.median), x(r.meanNet)]),
    ["l", "r", "r", "r", "r"]
  );
}

export function formatBattery(report: BatteryReport): string {
  const minN = report.options.minSampleSize;
  const rows = report.results.map((r) =>
    r.insufficientSample
      ? [r.label, String(r.n), "—", "—", "—", "—", "—", "—", "—", `n < ${minN}`]
      : [
          r.label,
          String(r.n),
          x(r.meanGross),
          x(r.meanNet),
          `[${x(r.ciLow)} ; ${x(r.ciHigh)}]`,
          r.placebo ? x(r.placebo.placeboMean) : "—",
          pval(r.placebo ? r.placebo.pValue : null),
          pval(r.pPlaceboAdjusted),
          pval(r.pProfitableAdjusted),
          r.demonstrated ? "OUI" : "non",
        ]
  );
  return table(
    ["Hypothèse", "n", "Brute", "Nette", "IC 95 % (net)", "Placebo", "p placebo", "p placebo*", "p rentable*", "Démontré"],
    rows,
    ["l", "r", "r", "r", "r", "r", "r", "r", "r", "r"]
  );
}

export function formatPaperTrades(report: PaperTradeReport): string {
  const reasons = Object.entries(report.exitReasons)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  const lines = [
    `  Ordres : ${report.buys} achats, ${report.closedTrades} ventes chiffrées` +
      (report.unpriced ? `, ${report.unpriced} sans multiplicateur (exclues)` : "") +
      (report.stillOpen ? `, ${report.stillOpen} positions non clôturées` : ""),
    `  Multiplicateur moyen : ${x(report.meanGross, 3)} brut → ${x(report.meanNet, 3)} après frais (médiane ${x(report.medianGross)})`,
    `  Trades gagnants : ${pct(report.winRatePercent)}`,
    `  Résultat cumulé : ${sol(report.pnlGrossSol)} brut → ${sol(report.pnlNetSol)} après frais`,
    `  Sorties : ${reasons}`,
    "",
    table(
      ["Session (début)", "Trades", "Moy. brute", "Moy. nette"],
      report.sessions.map((s) => [
        new Date(s.start).toISOString().slice(0, 16).replace("T", " "),
        String(s.trades),
        x(s.meanGross),
        x(s.meanNet),
      ]),
      ["l", "r", "r", "r"]
    ),
  ];
  return lines.join("\n");
}
