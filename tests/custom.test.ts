import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EXIT_GRID,
  HYPOTHESES,
  runBattery,
  streamSeed,
  type Hypothesis,
  type HypothesisContext,
} from "../src/analysis/battery.js";
import { FILTER_KEYS, HypothesisFileError, describeCatalogue, parseHypotheses, selectBuiltIn } from "../src/analysis/custom.js";
import { bonferroni, mulberry32 } from "../src/analysis/stats.js";
import type { OutcomeRow } from "../src/types.js";

const ctx: HypothesisContext = { solUsd: 100 };

function row(i: number, patch: Partial<OutcomeRow> = {}, multiple = 1): OutcomeRow {
  return {
    mint: `mint-${i}`,
    name: `Token ${i}`,
    score: 50,
    entryMarketCapSol: 100,
    peakMarketCapSol: 100 * Math.max(multiple, 1),
    multiple: Math.max(multiple, 1),
    alertedAt: 1_000_000 + i,
    priceHistory: [
      { t: 0, marketCapSol: 100 },
      { t: 10_000, marketCapSol: 100 * multiple },
    ],
    ...patch,
  };
}

const signals = (patch: Partial<NonNullable<OutcomeRow["signals"]>> = {}): NonNullable<OutcomeRow["signals"]> => ({
  uniqueBuyers: 10,
  buySellRatio: 2,
  topHolderPercent: 50,
  hasTwitterLink: false,
  authoritiesRevoked: true,
  devBuyPercent: 5,
  ...patch,
});

function parseOne(spec: unknown): Hypothesis {
  return parseHypotheses(JSON.stringify([spec]))[0];
}

function assertRejects(spec: unknown, fragment: string): void {
  assert.throws(
    () => parseHypotheses(JSON.stringify(spec)),
    (e: unknown) => e instanceof HypothesisFileError && e.message.includes(fragment),
    `devait être refusé avec « ${fragment} »`
  );
}

const takeProfit15 = { type: "takeProfit", multiple: 1.5 };

describe("hypothèses définies par l'utilisateur : lecture du fichier", () => {
  it("lit le fichier d'exemple fourni : identifiants, types et libellés", () => {
    const hs = parseHypotheses(readFileSync("examples/hypotheses.example.json", "utf8"));
    assert.deepEqual(hs.map((h) => h.id), ["mon-filtre-1", "custom-2", "vente-2-minutes"]);
    assert.deepEqual(hs.map((h) => h.kind), ["filter", "filter", "entry"]);
    assert.equal(hs[0].label, "Score ≥ 80, holders ≤ 70 %, lien X, objectif ×1,5");
    assert.equal(hs[1].label, "Entrée ≥ 15 000 $ et autorités révoquées, stop suiveur −15 %");
    assert.equal(hs[2].label, "Vente après 2 min, tous les candidats");
  });

  it("refuse une clé inconnue, partout (une faute de frappe ne doit jamais supprimer un filtre en silence)", () => {
    assertRejects([{ filter: { minScor: 80 }, exit: takeProfit15 }], "hypotheses[0].filter.minScor");
    assertRejects([{ filtre: {}, exit: takeProfit15 }], "hypotheses[0].filtre");
    assertRejects([{ exit: { type: "takeProfit", multiple: 1.5, stop: 0.5 } }], "hypotheses[0].exit.stop");
  });

  it("refuse les structures invalides", () => {
    assertRejects([], "tableau non vide");
    assertRejects({ exit: takeProfit15 }, "tableau non vide");
    assertRejects([42], "objet attendu");
    assertRejects([{ filter: { minScore: 80 } }], "hypotheses[0].exit");
    assertRejects([{ exit: { type: "magie" } }], "type de sortie inconnu");
    assertRejects([{ exit: { type: "takeProfit" } }], "hypotheses[0].exit.multiple");
    assert.throws(() => parseHypotheses("{pas du json"), /JSON illisible/);
  });

  it("refuse les valeurs hors limites ou absurdes", () => {
    assertRejects([{ filter: { minScore: -1 }, exit: takeProfit15 }], "minScore");
    assertRejects([{ filter: { minScore: 120 }, exit: takeProfit15 }], "minScore");
    assertRejects([{ filter: { minScore: "80" }, exit: takeProfit15 }], "nombre attendu");
    assertRejects([{ filter: { minScore: 90, maxScore: 80 }, exit: takeProfit15 }], "aucun candidat ne peut passer");
    assertRejects([{ filter: { minEntrySol: 0 }, exit: takeProfit15 }], "minEntrySol");
    assertRejects([{ filter: { twitterLink: "oui" }, exit: takeProfit15 }], "true ou false");
    assertRejects([{ filter: { waveRank: 3 }, exit: takeProfit15 }], "1 ou 2");
    assertRejects([{ exit: { type: "takeProfit", multiple: 1 } }], "multiple");
    assertRejects([{ exit: { type: "trailingStop", dropPercent: 100 } }], "dropPercent");
    assertRejects([{ exit: { type: "fixedTime", minutes: 0 } }], "minutes");
    assertRejects([{ exit: { type: "bracket", target: 1.2, stop: 1 } }], "stop");
    assertRejects([{ exit: { type: "crossing", fromUsd: 40000, toUsd: 30000 } }], "inférieur");
  });

  it("refuse un filtre avec une sortie « crossing » et les identifiants invalides ou en double", () => {
    assertRejects([{ filter: { minScore: 70 }, exit: { type: "crossing", fromUsd: 20000, toUsd: 30000 } }], "crossing");
    assertRejects([{ id: "a", exit: takeProfit15 }, { id: "a", exit: takeProfit15 }], "déjà utilisé");
    assertRejects([{ id: "pas d'espace", exit: takeProfit15 }], "id");
    assertRejects([{ label: "   ", exit: takeProfit15 }], "label");
  });

  it("accepte un filtre vide comme « aucun filtre » (kind entry, pas de placebo)", () => {
    const h = parseOne({ filter: {}, exit: takeProfit15 });
    assert.equal(h.kind, "entry");
    assert.equal(h.filter, undefined);
  });

  it("construit chaque type de sortie avec le bon identifiant de règle", () => {
    const rule = (exit: unknown) => parseOne({ exit }).exit(ctx).id;
    assert.equal(rule({ type: "takeProfit", multiple: 2 }), "tp-2");
    assert.equal(rule({ type: "trailingStop", dropPercent: 10 }), "trail-10");
    assert.equal(rule({ type: "fixedTime", minutes: 3 }), "fixed-3");
    assert.equal(rule({ type: "bracket", target: 1.25, stop: 0.7 }), "bracket-1.25-0.7");
    assert.equal(rule({ type: "crossing", fromUsd: 20000, toUsd: 30000 }), "cross-200.0-300.0"); // 20 000 $ / 100 $ par SOL
  });
});

describe("hypothèses définies par l'utilisateur : sémantique des filtres", () => {
  const keep = (spec: Record<string, unknown>, r: OutcomeRow) => parseOne({ filter: spec, exit: takeProfit15 }).filter!(r, ctx);

  it("score : les suivis « vague de noms » (score -1) sont exclus, minimum comme maximum", () => {
    assert.equal(keep({ minScore: 70 }, row(1, { score: 70 })), true);
    assert.equal(keep({ minScore: 70 }, row(1, { score: 69 })), false);
    assert.equal(keep({ minScore: 0 }, row(1, { score: -1 })), false);
    assert.equal(keep({ maxScore: 60 }, row(1, { score: -1 })), false);
    assert.equal(keep({ maxScore: 60 }, row(1, { score: 60 })), true);
  });

  it("taille d'entrée en SOL et en dollars (converti avec le prix du SOL de l'analyse)", () => {
    assert.equal(keep({ minEntrySol: 100 }, row(1, { entryMarketCapSol: 100 })), true);
    assert.equal(keep({ minEntrySol: 100 }, row(1, { entryMarketCapSol: 99.9 })), false);
    assert.equal(keep({ maxEntrySol: 100 }, row(1, { entryMarketCapSol: 100.1 })), false);
    // SOL = 100 $ : 10 000 $ = 100 SOL
    assert.equal(keep({ minEntryUsd: 10_000 }, row(1, { entryMarketCapSol: 100 })), true);
    assert.equal(keep({ minEntryUsd: 10_000 }, row(1, { entryMarketCapSol: 99 })), false);
    assert.equal(keep({ maxEntryUsd: 10_000 }, row(1, { entryMarketCapSol: 101 })), false);
  });

  it("un signal absent exclut la ligne : on ne devine pas", () => {
    const noSignals = row(1); // ancienne ligne, sans « signals »
    for (const f of [{ twitterLink: false }, { authoritiesRevoked: true }, { maxTopHolderPercent: 90 }, { minUniqueBuyers: 1 }, { maxDevBuyPercent: 50 }]) {
      assert.equal(keep(f, noSignals), false, JSON.stringify(f));
    }
    assert.equal(keep({ maxTopHolderPercent: 90 }, row(1, { signals: signals({ topHolderPercent: null }) })), false);
    assert.equal(keep({ authoritiesRevoked: true }, row(1, { signals: signals({ authoritiesRevoked: null }) })), false);
  });

  it("lien X, autorités, holders, acheteurs, achat du créateur et vague de noms", () => {
    assert.equal(keep({ twitterLink: true }, row(1, { signals: signals({ hasTwitterLink: true }) })), true);
    assert.equal(keep({ twitterLink: true }, row(1, { signals: signals({ hasTwitterLink: false }) })), false);
    assert.equal(keep({ twitterLink: false }, row(1, { signals: signals({ hasTwitterLink: false }) })), true);
    assert.equal(keep({ authoritiesRevoked: false }, row(1, { signals: signals({ authoritiesRevoked: true }) })), false);
    assert.equal(keep({ minTopHolderPercent: 60 }, row(1, { signals: signals({ topHolderPercent: 59 }) })), false);
    assert.equal(keep({ maxTopHolderPercent: 60 }, row(1, { signals: signals({ topHolderPercent: 60 }) })), true);
    assert.equal(keep({ minUniqueBuyers: 10 }, row(1, { signals: signals({ uniqueBuyers: 10 }) })), true);
    assert.equal(keep({ minUniqueBuyers: 11 }, row(1, { signals: signals({ uniqueBuyers: 10 }) })), false);
    assert.equal(keep({ maxDevBuyPercent: 4 }, row(1, { signals: signals({ devBuyPercent: 5 }) })), false);
    assert.equal(keep({ waveRank: 1 }, row(1, { waveRank: 1 })), true);
    assert.equal(keep({ waveRank: 1 }, row(1, { waveRank: 2 })), false);
    assert.equal(keep({ waveRank: 1 }, row(1)), false);
  });

  it("plusieurs conditions se cumulent (ET)", () => {
    const f = { minScore: 80, twitterLink: true, minEntrySol: 100 };
    const ok = row(1, { score: 85, signals: signals({ hasTwitterLink: true }) });
    assert.equal(keep(f, ok), true);
    assert.equal(keep(f, { ...ok, score: 79 }), false);
    assert.equal(keep(f, { ...ok, entryMarketCapSol: 50 }), false);
    assert.equal(keep(f, { ...ok, signals: signals({ hasTwitterLink: false }) }), false);
  });
});

describe("hypothèses définies par l'utilisateur : équivalence avec la batterie d'origine", () => {
  // Population variée : scores, tailles d'entrée, liens X, rangs de vague, historiques de prix aléatoires.
  const rng = mulberry32(5);
  const population: OutcomeRow[] = Array.from({ length: 900 }, (_, i) => {
    const entry = 40 + rng() * 400;
    const steps = [1, 0.8 + rng() * 0.6, 0.5 + rng() * 1.6, 0.4 + rng() * 2.4];
    return row(i, {
      score: Math.floor(rng() * 100),
      entryMarketCapSol: entry,
      signals: signals({ hasTwitterLink: rng() < 0.4, topHolderPercent: 20 + rng() * 75 }),
      ...(rng() < 0.15 ? { waveRank: 1 as const } : {}),
      priceHistory: steps.map((m, k) => ({ t: k * 20_000, marketCapSol: entry * m })),
    });
  });
  const opts = { iterations: 300, seed: 9, independentStreams: true, solUsd: 123 };

  const cases: Array<[string, unknown]> = [
    ["entry150-x", { filter: { minEntrySol: 150, twitterLink: true }, exit: { type: "takeProfit", multiple: 1.25 } }],
    ["usd20k-x-x2", { filter: { minEntryUsd: 20000, twitterLink: true }, exit: { type: "takeProfit", multiple: 2 } }],
    ["wave-first", { filter: { waveRank: 1 }, exit: { type: "takeProfit", multiple: 1.25 } }],
    ["score90", { filter: { minScore: 90 }, exit: { type: "takeProfit", multiple: 1.25 } }],
    ["cross-30000-40000", { exit: { type: "crossing", fromUsd: 30000, toUsd: 40000 } }],
  ];

  for (const [id, spec] of cases) {
    it(`l'hypothèse « ${id} » écrite dans un fichier donne exactement les mêmes chiffres que la batterie d'origine`, () => {
      const builtIn = selectBuiltIn([id]);
      const custom = parseHypotheses(JSON.stringify([{ id, ...(spec as object) }]));
      const a = runBattery(population, { ...opts, hypotheses: builtIn }).results[0];
      const b = runBattery(population, { ...opts, hypotheses: custom }).results[0];
      assert.equal(a.n > 20, true, `échantillon trop petit pour être un vrai test (n = ${a.n})`);
      assert.deepEqual({ ...b, label: "" }, { ...a, label: "" });
    });
  }
});

describe("sélection dans la batterie d'origine et catalogue", () => {
  it("garde l'ordre demandé, sans doublon", () => {
    assert.deepEqual(selectBuiltIn(["score90", "entry100", "score90"]).map((h) => h.id), ["score90", "entry100"]);
  });

  it("refuse un identifiant inconnu et une liste vide", () => {
    assert.throws(() => selectBuiltIn(["score90", "nope"]), /hypothèse inconnue « nope »/);
    assert.throws(() => selectBuiltIn([]), /au moins un identifiant/);
  });

  it("le catalogue (--list) mentionne toutes les hypothèses, toutes les règles et toutes les clés acceptées", () => {
    const text = describeCatalogue();
    for (const h of HYPOTHESES) assert.ok(text.includes(h.id), h.id);
    for (const r of EXIT_GRID) assert.ok(text.includes(r.id), r.id);
    for (const k of FILTER_KEYS) assert.ok(text.includes(k), k);
    for (const t of ["takeProfit", "trailingStop", "fixedTime", "bracket", "crossing"]) assert.ok(text.includes(t), t);
  });
});

describe("batterie : correction choisie et flux aléatoires indépendants", () => {
  const rng = mulberry32(21);
  const population = Array.from({ length: 300 }, (_, i) =>
    row(i, { score: Math.floor(rng() * 100), entryMarketCapSol: 80 + rng() * 120 }, 0.7 + rng() * 0.5)
  );
  const hs = selectBuiltIn(["score90", "entry100"]);
  const base = { iterations: 400, seed: 3, hypotheses: hs, minSampleSize: 5 };

  it("par défaut, la correction compte les hypothèses lancées ; on peut en compter davantage", () => {
    const a = runBattery(population, base);
    const b = runBattery(population, { ...base, correctionCount: 14 });
    assert.equal(a.correctionCount, 2);
    assert.equal(b.correctionCount, 14);
    assert.equal(b.hypothesesTested, 2);
    for (let i = 0; i < 2; i++) {
      assert.equal(b.results[i].pProfitableAdjusted, bonferroni(b.results[i].pProfitable, 14));
      assert.ok(b.results[i].pProfitableAdjusted >= a.results[i].pProfitableAdjusted);
      assert.equal(b.results[i].pProfitable, a.results[i].pProfitable, "le p brut ne dépend pas de la correction");
    }
  });

  it("refuse un nombre de tests inférieur aux hypothèses lancées, non entier, ou une liste vide", () => {
    assert.throws(() => runBattery(population, { ...base, correctionCount: 1 }), RangeError);
    assert.throws(() => runBattery(population, { ...base, correctionCount: 2.5 }), RangeError);
    assert.throws(() => runBattery(population, { ...base, hypotheses: [] }), RangeError);
  });

  it("flux indépendants : les chiffres d'une hypothèse ne dépendent pas des autres ni de leur ordre", () => {
    const o = { ...base, independentStreams: true };
    const both = runBattery(population, o).results;
    const alone = runBattery(population, { ...o, hypotheses: [hs[1]] }).results[0];
    const swapped = runBattery(population, { ...o, hypotheses: [hs[1], hs[0]] }).results;
    assert.deepEqual(alone.placebo, both[1].placebo);
    assert.equal(alone.ciLow, both[1].ciLow);
    assert.deepEqual(swapped[0].placebo, both[1].placebo);
    assert.deepEqual(swapped[1].placebo, both[0].placebo);
  });

  it("flux partagé (batterie d'origine) : le résultat d'une hypothèse dépend de celles qui la précèdent", () => {
    const both = runBattery(population, base).results;
    const alone = runBattery(population, { ...base, hypotheses: [hs[1]] }).results[0];
    assert.notEqual(alone.ciLow, both[1].ciLow);
  });

  it("la graine propre à une hypothèse dépend de la graine globale et de l'identifiant", () => {
    assert.equal(streamSeed(42, "score90"), streamSeed(42, "score90"));
    assert.notEqual(streamSeed(42, "score90"), streamSeed(43, "score90"));
    assert.notEqual(streamSeed(42, "score90"), streamSeed(42, "entry100"));
  });
});
