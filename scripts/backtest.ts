import { existsSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadJsonl, loadOutcomes, withHistory } from "../src/analysis/dataset.js";
import { calibrateHolders, calibrateScore, evaluateExitGrid, runBattery } from "../src/analysis/battery.js";
import { analyzePaperTrades, type TradeLogEntry } from "../src/analysis/paperTrades.js";
import { mean } from "../src/analysis/stats.js";
import {
  formatBattery,
  formatBuckets,
  formatExitGrid,
  formatPaperTrades,
  section,
} from "../src/analysis/report.js";

const HELP = `Banc d'essai statistique du Memecoin Radar

Usage : npm run backtest -- [options]

  --input <fichier>       Historique des candidats suivis (JSONL).
                          Défaut : logs/outcomes.jsonl, sinon l'échantillon data/sample/outcomes.jsonl
  --trades <fichier>      Journal de la simulation de trading (JSONL), pour le bilan des trades papier
  --seed <entier>         Graine aléatoire (défaut 42) : même graine = mêmes chiffres
  --iterations <entier>   Tirages bootstrap et placebo (défaut 5000)
  --sol-usd <nombre>      Prix du SOL pour convertir les seuils en dollars (défaut 123)
  --json                  Sortie JSON au lieu du texte
  --help                  Affiche cette aide
`;

const { values } = parseArgs({
  options: {
    input: { type: "string" },
    trades: { type: "string" },
    seed: { type: "string", default: "42" },
    iterations: { type: "string", default: "5000" },
    "sol-usd": { type: "string", default: "123" },
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

function positiveNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`Option --${name} invalide : "${raw}" (nombre positif attendu).`);
    process.exit(1);
  }
  return n;
}

const seed = positiveNumber("seed", values.seed!);
const iterations = Math.floor(positiveNumber("iterations", values.iterations!));
const solUsd = positiveNumber("sol-usd", values["sol-usd"]!);

const SAMPLE = "data/sample/outcomes.jsonl";
const inputFile = values.input ?? (existsSync("logs/outcomes.jsonl") ? "logs/outcomes.jsonl" : SAMPLE);
if (!existsSync(inputFile)) {
  console.error(`Fichier introuvable : ${inputFile}\nLance \`npm run demo\` pour utiliser l'échantillon fourni.`);
  process.exit(1);
}

const { rows, skipped } = loadOutcomes(inputFile);
const usable = withHistory(rows);
const battery = runBattery(usable, { seed, iterations, solUsd });

let paper = null;
if (values.trades) {
  if (!existsSync(values.trades)) {
    console.error(`Fichier introuvable : ${values.trades}`);
    process.exit(1);
  }
  paper = analyzePaperTrades(loadJsonl<TradeLogEntry>(values.trades).rows);
}

if (values.json) {
  console.log(
    JSON.stringify(
      {
        input: inputFile,
        candidates: rows.length,
        withPriceHistory: usable.length,
        skippedLines: skipped,
        scoreCalibration: calibrateScore(rows),
        holderCalibration: calibrateHolders(rows),
        exitGrid: evaluateExitGrid(usable),
        battery,
        paperTrades: paper,
      },
      null,
      2
    )
  );
  process.exit(0);
}

const alerted = rows.filter((r) => r.alerted !== false).length;
console.log(`Memecoin Radar — banc d'essai statistique`);
console.log(`Fichier : ${path.relative(process.cwd(), path.resolve(inputFile)) || inputFile}`);
console.log(
  `${rows.length} candidats notés (${alerted} alertés), dont ${usable.length} avec historique de prix` +
    (skipped ? ` · ${skipped} ligne(s) ignorée(s) car incomplète(s) ou illisible(s)` : "")
);
console.log(`Graine ${seed} · ${iterations} tirages · SOL = ${solUsd} $`);

console.log(section("1. Le score classe-t-il les candidats ?"));
console.log("  Pic = maximum atteint après l'entrée, mesuré APRÈS COUP : ce n'est pas un gain encaissable.\n");
console.log(formatBuckets(calibrateScore(rows)));
console.log("\n  Concentration des 10 plus gros holders :\n");
console.log(formatBuckets(calibrateHolders(rows)));

console.log(section("2. Existe-t-il une règle de sortie rentable ?"));
console.log(`  ${usable.length} candidats, entrée au prix de l'alerte, exécution parfaite (sans latence ni glissement).`);
console.log("  Moyenne > ×1,00 nécessaire pour gagner de l'argent ; « nette » = après frais estimés (~3 % de la mise).\n");
const grid = evaluateExitGrid(usable);
console.log(formatExitGrid(grid));
const best = Math.max(...grid.map((g) => g.mean));
console.log(`\n  → Meilleure moyenne de la grille : ${best.toFixed(3).replace(".", ",")} (en dessous de ×1,00).`);

console.log(section("3. Batterie d'hypothèses avec contrôle par placebo"));
console.log("  Pour chaque idée : le résultat est-il rentable après frais, et fait-il mieux que le hasard ?");
console.log(`  * = p-value corrigée pour ${battery.hypothesesTested} hypothèses testées (Bonferroni, volontairement sévère car ces idées sont corrélées).`);
console.log("  Démontré = rentable après frais (p rentable* < 0,05) ET meilleur que le hasard s'il s'agit d'un filtre (p placebo* < 0,05).");
console.log("  « p placebo » brut : un filtre peut mieux trier que le hasard sans pour autant être rentable.");
console.log("  Placebo = moyenne brute d'un sous-groupe tiré au hasard, de même taille, dans la même population.");
console.log(`  Un sous-groupe de moins de ${battery.options.minSampleSize} candidats n'est pas testé : un seul cas extrême ferait le résultat.\n`);
console.log(formatBattery(battery));
const proven = battery.results.filter((r) => r.demonstrated).length;
console.log(
  `\n  → ${proven} hypothèse(s) démontrée(s) sur ${battery.hypothesesTested}. ` +
    `Ces ${battery.hypothesesTested} tests ne sont qu'une partie de ceux réalisés pendant l'exploration : ` +
    `un résultat isolé « presque significatif » est à confirmer sur des tokens nouveaux, jamais à croire sur parole.`
);

if (paper) {
  console.log(section("4. Bilan de la simulation de trading (papier)"));
  console.log(formatPaperTrades(paper));
}

console.log(
  `\nMoyenne globale des multiplicateurs de pic : ${mean(rows.map((r) => r.multiple)).toFixed(2).replace(".", ",")} ` +
    `(maximum théorique, jamais encaissable tel quel).\n`
);
