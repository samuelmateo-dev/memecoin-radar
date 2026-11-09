import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mulberry32 } from "../src/analysis/stats.js";

// Ligne de commande du banc d'essai, lancée comme un vrai processus : choix des sections, des
// hypothèses, fichier de l'utilisateur, et messages d'erreur.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let dir: string;
let outcomes: string;
let trades: string;

function run(...args: string[]) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/backtest.ts", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const FAST = ["--iterations", "200"];

before(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "radar-cli-"));
  const rng = mulberry32(8);
  const lines = Array.from({ length: 120 }, (_, i) => {
    const entry = 60 + rng() * 300;
    return JSON.stringify({
      mint: `mint-${i}`,
      name: `Token ${i}`,
      symbol: `T${i}`,
      score: Math.floor(rng() * 100),
      entryMarketCapSol: entry,
      peakMarketCapSol: entry * 2,
      multiple: 1 + rng(),
      alertedAt: 1_700_000_000_000 + i * 1000,
      alerted: true,
      signals: { uniqueBuyers: 8, buySellRatio: 2, topHolderPercent: 30 + rng() * 60, hasTwitterLink: rng() < 0.5, authoritiesRevoked: true, devBuyPercent: 4 },
      priceHistory: [1, 0.7 + rng() * 0.9, 0.5 + rng() * 1.5, 0.4 + rng() * 2].map((m, k) => ({ t: k * 20_000, marketCapSol: entry * m })),
    });
  });
  outcomes = path.join(dir, "outcomes.jsonl");
  writeFileSync(outcomes, lines.join("\n") + "\n");
  trades = path.join(dir, "paper-trades.jsonl");
  writeFileSync(
    trades,
    [
      { type: "buy", mint: "mint-1", name: "Token 1", at: 1_700_000_000_000, solAmount: 0.1 },
      { type: "sell", mint: "mint-1", name: "Token 1", at: 1_700_000_060_000, multiple: 1.1, reason: "take-profit", pnlSol: 0.01 },
    ]
      .map((o) => JSON.stringify(o))
      .join("\n") + "\n"
  );
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("banc d'essai en ligne de commande", () => {
  it("--list affiche hypothèses, règles de sortie et format du fichier, sans lire de données", () => {
    const r = run("--list", "--input", "/fichier/qui/n/existe/pas");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /score90 +Score ≥ 90/);
    assert.match(r.out, /fixed-0\.5/);
    assert.match(r.out, /takeProfit : multiple/);
  });

  it("sans option de choix : les trois sections, numérotées, et la batterie d'origine (14 tests)", () => {
    const r = run("--input", outcomes, ...FAST);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\n1\. Le score classe-t-il/);
    assert.match(r.out, /\n2\. Existe-t-il une règle de sortie rentable/);
    assert.match(r.out, /\n3\. Batterie d'hypothèses/);
    assert.match(r.out, /corrigée pour 14 hypothèses testées/);
    assert.doesNotMatch(r.out, /Hypothèses :/); // la ligne de mode n'apparaît que si on a choisi
    assert.match(r.out, /Ces 14 tests ne sont qu'une partie/);
  });

  it("--sections choisit les parties du rapport et renumérote", () => {
    const r = run("--input", outcomes, "--sections", "battery", ...FAST);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\n1\. Batterie d'hypothèses/);
    assert.doesNotMatch(r.out, /Le score classe-t-il/);
    assert.doesNotMatch(r.out, /règle de sortie rentable/);
  });

  it("--sections paper avec --trades : bilan des trades papier", () => {
    const r = run("--input", outcomes, "--trades", trades, "--sections", "paper", ...FAST);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /\n1\. Bilan de la simulation de trading/);
    assert.doesNotMatch(r.out, /Batterie/);
  });

  it("--json : tout par défaut ; seulement les sections choisies avec --sections", () => {
    const all = JSON.parse(run("--input", outcomes, "--json", ...FAST).out);
    for (const k of ["scoreCalibration", "holderCalibration", "exitGrid", "battery", "paperTrades"]) assert.ok(k in all, k);
    assert.equal(all.battery.correctionCount, 14);
    assert.equal(all.battery.independentStreams, false);

    const some = JSON.parse(run("--input", outcomes, "--json", "--sections", "exits,battery", ...FAST).out);
    assert.ok("exitGrid" in some && "battery" in some);
    assert.ok(!("scoreCalibration" in some) && !("paperTrades" in some));

    const onlyBattery = JSON.parse(run("--input", outcomes, "--json", "--sections", "battery", ...FAST).out);
    assert.ok("battery" in onlyBattery);
    for (const k of ["scoreCalibration", "holderCalibration", "exitGrid", "paperTrades"]) assert.ok(!(k in onlyBattery), k);

    const noBattery = JSON.parse(run("--input", outcomes, "--json", "--sections", "score", ...FAST).out);
    assert.ok("scoreCalibration" in noBattery && !("battery" in noBattery) && !("exitGrid" in noBattery));
  });

  it("--only lance un sous-ensemble ; la correction compte les tests lancés, ou ceux qu'on déclare", () => {
    const sub = run("--input", outcomes, "--sections", "battery", "--only", "score90,entry100", ...FAST);
    assert.equal(sub.code, 0, sub.err);
    assert.match(sub.out, /Hypothèses : 2 sur 14 hypothèses de la batterie d'origine \(--only\) · correction de Bonferroni pour 2 test/);
    assert.match(sub.out, /corrigée pour 2 hypothèses testées/);
    assert.match(sub.out, /Choisir après coup celles qui ont l'air bonnes fausse la correction/);

    const counted = JSON.parse(run("--input", outcomes, "--json", "--only", "score90,entry100", "--tests-counted", "14", ...FAST).out);
    assert.equal(counted.battery.hypothesesTested, 2);
    assert.equal(counted.battery.correctionCount, 14);
    assert.equal(counted.battery.independentStreams, true);
    assert.deepEqual(counted.battery.results.map((x: { id: string }) => x.id), ["score90", "entry100"]);
  });

  it("--hypotheses lance les hypothèses du fichier, avec leur libellé et l'avertissement sur les verdicts", () => {
    const file = path.join(dir, "mes-hypotheses.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "a", label: "Mon idée à moi", filter: { minScore: 60 }, exit: { type: "takeProfit", multiple: 1.3 } },
        { exit: { type: "trailingStop", dropPercent: 20 } },
      ])
    );
    const r = run("--input", outcomes, "--sections", "battery", "--hypotheses", file, ...FAST);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Mon idée à moi/);
    assert.match(r.out, /Stop suiveur −20 %, tous les candidats/);
    assert.match(r.out, /2 hypothèse\(s\) définie\(s\) dans/);
    assert.match(r.out, /Ces hypothèses sont les tiennes : le verdict n'a de valeur que si tu les as fixées AVANT/);
    assert.doesNotMatch(r.out, /Score ≥ 90, objectif/); // la batterie d'origine n'est pas lancée
  });

  it("refuse proprement les demandes incohérentes (code 1, message clair, rien d'exécuté)", () => {
    const file = path.join(dir, "faute.json");
    writeFileSync(file, JSON.stringify([{ filter: { minScor: 80 }, exit: { type: "takeProfit", multiple: 1.5 } }]));
    const cases: Array<[string[], RegExp]> = [
      [["--hypotheses", file], /Erreur : hypotheses\[0\]\.filter\.minScor : clé inconnue/],
      [["--hypotheses", path.join(dir, "absent.json")], /Fichier introuvable/],
      [["--only", "nope"], /hypothèse inconnue « nope »/],
      [["--only", "score90", "--hypotheses", file], /incompatibles/],
      [["--sections", "bogus"], /« bogus » inconnu/],
      [["--sections", "paper"], /demande --trades/],
      [["--only", "score90,entry100", "--tests-counted", "1"], /au moins 2/],
      [["--tests-counted", "abc"], /--tests-counted invalide/],
    ];
    for (const [args, expected] of cases) {
      const r = run("--input", outcomes, ...args, ...FAST);
      assert.equal(r.code, 1, args.join(" "));
      assert.match(r.err, expected, args.join(" "));
      assert.equal(r.out, "", `rien ne doit être affiché avant l'erreur (${args.join(" ")})`);
    }
  });
});
