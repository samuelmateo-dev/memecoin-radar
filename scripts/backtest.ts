import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadJsonl, loadOutcomes, withHistory } from "../src/analysis/dataset.js";
import {
  HYPOTHESES,
  calibrateHolders,
  calibrateScore,
  evaluateExitGrid,
  runBattery,
  type Hypothesis,
} from "../src/analysis/battery.js";
import { HypothesisFileError, describeCatalogue, parseHypotheses, selectBuiltIn } from "../src/analysis/custom.js";
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

Choisir ce qui est testé :
  --list                  Liste les hypothèses, les règles de sortie et le format du fichier, puis s'arrête
  --sections <liste>      Sections du rapport, séparées par des virgules : score, exits, battery, paper
                          Défaut : toutes (paper seulement avec --trades)
  --only <ids>            Ne lance que ces hypothèses de la batterie d'origine (identifiants de --list)
  --hypotheses <fichier>  Lance TES hypothèses (fichier JSON, voir examples/hypotheses.example.json)
                          à la place de la batterie d'origine. Incompatible avec --only.
  --tests-counted <n>     Nombre de tests sur lequel la correction de Bonferroni est calculée
                          (défaut : le nombre d'hypothèses lancées). À augmenter si tu as regardé
                          d'autres idées sur ces mêmes données.
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
    list: { type: "boolean", default: false },
    sections: { type: "string" },
    only: { type: "string" },
    hypotheses: { type: "string" },
    "tests-counted": { type: "string" },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (values.list) {
  console.log(describeCatalogue());
  process.exit(0);
}

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

function positiveNumber(name: string, raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    die(`Option --${name} invalide : "${raw}" (nombre positif attendu).`);
  }
  return n;
}

const seed = positiveNumber("seed", values.seed!);
const iterations = Math.floor(positiveNumber("iterations", values.iterations!));
const solUsd = positiveNumber("sol-usd", values["sol-usd"]!);

// --- Sections choisies -------------------------------------------------------------------
const ALL_SECTIONS = ["score", "exits", "battery", "paper"] as const;
type SectionName = (typeof ALL_SECTIONS)[number];
let selected: Set<SectionName>;
if (values.sections !== undefined) {
  const asked = values.sections.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = asked.filter((s) => !(ALL_SECTIONS as readonly string[]).includes(s));
  if (asked.length === 0 || unknown.length > 0) {
    die(`Option --sections invalide : ${unknown.length ? unknown.map((s) => `« ${s} »`).join(", ") + " inconnu(es). " : ""}Sections acceptées : ${ALL_SECTIONS.join(", ")}.`);
  }
  selected = new Set(asked as SectionName[]);
  if (selected.has("paper") && !values.trades) die("La section « paper » demande --trades <fichier>.");
} else {
  selected = new Set<SectionName>(["score", "exits", "battery", ...(values.trades ? (["paper"] as const) : [])]);
}

// --- Hypothèses choisies -----------------------------------------------------------------
if (values.only !== undefined && values.hypotheses !== undefined) {
  die("--only et --hypotheses sont incompatibles : choisis dans la batterie d'origine OU écris la tienne.");
}
let hypotheses: Hypothesis[] | undefined; // undefined = batterie d'origine complète
try {
  if (values.only !== undefined) {
    hypotheses = selectBuiltIn(values.only.split(",").map((s) => s.trim()).filter(Boolean));
  } else if (values.hypotheses !== undefined) {
    if (!existsSync(values.hypotheses)) die(`Fichier introuvable : ${values.hypotheses}`);
    hypotheses = parseHypotheses(readFileSync(values.hypotheses, "utf8"));
  }
} catch (e) {
  if (e instanceof HypothesisFileError) die(`Erreur : ${e.message}`);
  throw e;
}
const customMode = hypotheses !== undefined;

let correctionCount: number | undefined;
if (values["tests-counted"] !== undefined) {
  const raw = values["tests-counted"];
  const n = Number(raw);
  const launched = hypotheses ? hypotheses.length : HYPOTHESES.length;
  if (!Number.isInteger(n) || n < launched) {
    die(`Option --tests-counted invalide : "${raw}" (entier attendu, au moins ${launched} : le nombre d'hypothèses lancées).`);
  }
  correctionCount = n;
}

const SAMPLE = "data/sample/outcomes.jsonl";
const inputFile = values.input ?? (existsSync("logs/outcomes.jsonl") ? "logs/outcomes.jsonl" : SAMPLE);
if (!existsSync(inputFile)) {
  die(`Fichier introuvable : ${inputFile}\nLance \`npm run demo\` pour utiliser l'échantillon fourni.`);
}

const { rows, skipped } = loadOutcomes(inputFile);
const usable = withHistory(rows);
const battery = selected.has("battery")
  ? runBattery(usable, { seed, iterations, solUsd, hypotheses, correctionCount, independentStreams: customMode })
  : null;

let paper = null;
if (values.trades && selected.has("paper")) {
  if (!existsSync(values.trades)) {
    die(`Fichier introuvable : ${values.trades}`);
  }
  paper = analyzePaperTrades(loadJsonl<TradeLogEntry>(values.trades).rows);
}

if (values.json) {
  const everything = values.sections === undefined;
  console.log(
    JSON.stringify(
      {
        input: inputFile,
        candidates: rows.length,
        withPriceHistory: usable.length,
        skippedLines: skipped,
        ...(selected.has("score")
          ? { scoreCalibration: calibrateScore(rows), holderCalibration: calibrateHolders(rows) }
          : {}),
        ...(selected.has("exits") ? { exitGrid: evaluateExitGrid(usable) } : {}),
        ...(battery ? { battery } : {}),
        ...(everything || selected.has("paper") ? { paperTrades: paper } : {}),
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
if (battery && (customMode || correctionCount !== undefined)) {
  const which = values.only !== undefined
    ? `${battery.hypothesesTested} sur ${HYPOTHESES.length} hypothèses de la batterie d'origine (--only)`
    : values.hypotheses !== undefined
      ? `${battery.hypothesesTested} hypothèse(s) définie(s) dans ${values.hypotheses}`
      : `batterie d'origine (${battery.hypothesesTested} hypothèses)`;
  console.log(`Hypothèses : ${which} · correction de Bonferroni pour ${battery.correctionCount} test(s)`);
}

let sectionNumber = 0;
const nextTitle = (title: string) => section(`${++sectionNumber}. ${title}`);

if (selected.has("score")) {
  console.log(nextTitle("Le score classe-t-il les candidats ?"));
  console.log("  Pic = maximum atteint après l'entrée, mesuré APRÈS COUP : ce n'est pas un gain encaissable.\n");
  console.log(formatBuckets(calibrateScore(rows)));
  console.log("\n  Concentration des 10 plus gros holders :\n");
  console.log(formatBuckets(calibrateHolders(rows)));
}

if (selected.has("exits")) {
  console.log(nextTitle("Existe-t-il une règle de sortie rentable ?"));
  console.log(`  ${usable.length} candidats, entrée au prix de l'alerte, exécution parfaite (sans latence ni glissement).`);
  console.log("  Moyenne > ×1,00 nécessaire pour gagner de l'argent ; « nette » = après frais estimés (~3 % de la mise).\n");
  const grid = evaluateExitGrid(usable);
  console.log(formatExitGrid(grid));
  const best = Math.max(...grid.map((g) => g.mean));
  console.log(`\n  → Meilleure moyenne de la grille : ${best.toFixed(3).replace(".", ",")} (en dessous de ×1,00).`);
}

if (battery) {
  console.log(nextTitle("Batterie d'hypothèses avec contrôle par placebo"));
  console.log("  Pour chaque idée : le résultat est-il rentable après frais, et fait-il mieux que le hasard ?");
  console.log(`  * = p-value corrigée pour ${battery.correctionCount} ${battery.correctionCount > 1 ? "hypothèses testées" : "hypothèse testée"} (Bonferroni, volontairement sévère car ces idées sont corrélées).`);
  console.log("  Démontré = rentable après frais (p rentable* < 0,05) ET meilleur que le hasard s'il s'agit d'un filtre (p placebo* < 0,05).");
  console.log("  « p placebo » brut : un filtre peut mieux trier que le hasard sans pour autant être rentable.");
  console.log("  Placebo = moyenne brute d'un sous-groupe tiré au hasard, de même taille, dans la même population.");
  console.log(`  Un sous-groupe de moins de ${battery.options.minSampleSize} candidats n'est pas testé : un seul cas extrême ferait le résultat.\n`);
  console.log(formatBattery(battery));
  const proven = battery.results.filter((r) => r.demonstrated).length;
  if (values.hypotheses !== undefined) {
    console.log(
      `\n  → ${proven} hypothèse(s) démontrée(s) sur ${battery.hypothesesTested}. ` +
        `Ces hypothèses sont les tiennes : le verdict n'a de valeur que si tu les as fixées AVANT de regarder ces données. ` +
        `Chaque autre idée essayée avant d'arriver à celles-ci doit être comptée (--tests-counted), ` +
        `et un résultat « presque significatif » est à confirmer sur des tokens nouveaux.`
    );
  } else if (values.only !== undefined) {
    console.log(
      `\n  → ${proven} hypothèse(s) démontrée(s) sur ${battery.hypothesesTested}. ` +
        `Sous-ensemble de la batterie d'origine : les autres idées ont, elles, été regardées pendant l'exploration. ` +
        `Choisir après coup celles qui ont l'air bonnes fausse la correction : compte-les avec --tests-counted.`
    );
  } else {
    console.log(
      `\n  → ${proven} hypothèse(s) démontrée(s) sur ${battery.hypothesesTested}. ` +
        `Ces ${battery.hypothesesTested} tests ne sont qu'une partie de ceux réalisés pendant l'exploration : ` +
        `un résultat isolé « presque significatif » est à confirmer sur des tokens nouveaux, jamais à croire sur parole.`
    );
  }
}

if (paper) {
  console.log(nextTitle("Bilan de la simulation de trading (papier)"));
  console.log(formatPaperTrades(paper));
}

console.log(
  `\nMoyenne globale des multiplicateurs de pic : ${mean(rows.map((r) => r.multiple)).toFixed(2).replace(".", ",")} ` +
    `(maximum théorique, jamais encaissable tel quel).\n`
);
