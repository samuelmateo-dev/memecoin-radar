import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Scorer, passesStage1, scoreInputs, uniqueBuyersOf, type ScoreInputs } from "../src/scoring/scoring.js";
import { loadConfig } from "../src/config.js";
import { buyersTrades, makeCandidate, makeTrade } from "./helpers.js";

const opts = { maxDevInitialBuyPercent: 15 };

// Base neutre : aucun critère ne rapporte de point (sauf les 4 points plancher des acheteurs).
const NEUTRAL: ScoreInputs = {
  uniqueBuyers: 0,
  buySellRatio: 0,
  topHolderPercent: null,
  socials: "unavailable",
  authoritiesRevoked: null,
  devBuyPercent: 100,
};
const score = (patch: Partial<ScoreInputs>) => scoreInputs({ ...NEUTRAL, ...patch }, opts).totalScore;

describe("scoreInputs — barème", () => {
  it("donne 100/100 quand tous les critères sont au maximum", () => {
    const { totalScore } = scoreInputs(
      {
        uniqueBuyers: 25,
        buySellRatio: 2,
        topHolderPercent: 60,
        socials: "x",
        authoritiesRevoked: true,
        devBuyPercent: 5,
      },
      opts
    );
    assert.equal(totalScore, 100);
  });

  it("donne le plancher de 4 points sans aucun signal", () => {
    assert.equal(score({}), 4);
  });

  it("acheteurs uniques : paliers 10 et 20", () => {
    assert.equal(score({ uniqueBuyers: 9 }), 4);
    assert.equal(score({ uniqueBuyers: 10 }), 12);
    assert.equal(score({ uniqueBuyers: 19 }), 12);
    assert.equal(score({ uniqueBuyers: 20 }), 20);
  });

  it("ratio achat/vente : la zone 1,5-3 est la mieux notée, au-delà c'est du sniping probable", () => {
    assert.equal(score({ buySellRatio: 1.49 }), 4);
    assert.equal(score({ buySellRatio: 1.5 }), 14);
    assert.equal(score({ buySellRatio: 2.99 }), 14);
    assert.equal(score({ buySellRatio: 3 }), 9);
    assert.equal(score({ buySellRatio: 40 }), 9);
  });

  it("concentration des holders : falaises à 80 % et 95 %", () => {
    assert.equal(score({ topHolderPercent: 79.99 }), 29);
    assert.equal(score({ topHolderPercent: 80 }), 19);
    assert.equal(score({ topHolderPercent: 94.99 }), 19);
    assert.equal(score({ topHolderPercent: 95 }), 4);
    assert.equal(score({ topHolderPercent: null }), 4);
  });

  it("liens sociaux : X = 15, Telegram/site seul = 5, rien = 0", () => {
    assert.equal(score({ socials: "x" }), 19);
    assert.equal(score({ socials: "partial" }), 9);
    assert.equal(score({ socials: "none" }), 4);
    assert.equal(score({ socials: "unavailable" }), 4);
  });

  it("autorités : 20 points seulement si mint ET freeze sont révoquées", () => {
    assert.equal(score({ authoritiesRevoked: true }), 24);
    assert.equal(score({ authoritiesRevoked: false }), 4);
    assert.equal(score({ authoritiesRevoked: null }), 4);
  });

  it("achat initial du créateur : seuil à 15 %", () => {
    assert.equal(score({ devBuyPercent: 14.99 }), 14);
    assert.equal(score({ devBuyPercent: 15 }), 4);
  });

  it("explique les signaux négatifs dans les raisons", () => {
    const { reasons } = scoreInputs(
      { ...NEUTRAL, topHolderPercent: 99, authoritiesRevoked: false, socials: "none" },
      opts
    );
    assert.ok(reasons.some((r) => r.includes("extrêmement concentré")));
    assert.ok(reasons.some((r) => r.includes("authority encore active")));
    assert.ok(reasons.some((r) => r.includes("aucun lien social")));
    assert.ok(reasons.some((r) => r.includes("achat initial du créateur élevé")));
  });
});

describe("passesStage1", () => {
  const { stage1 } = loadConfig({});

  it("rejette un token avec moins de 5 acheteurs uniques", () => {
    const c = makeCandidate({ trades: buyersTrades(4, 90) });
    assert.equal(passesStage1(c, stage1), false);
  });

  it("compte les acheteurs distincts, pas les achats", () => {
    const trades = Array.from({ length: 10 }, () => makeTrade({ traderPublicKey: "same", marketCapSol: 90 }));
    const c = makeCandidate({ trades });
    assert.equal(uniqueBuyersOf(c), 1);
    assert.equal(passesStage1(c, stage1), false);
  });

  it("rejette un token dont le market cap n'a pas progressé de ×1,5", () => {
    const c = makeCandidate({ startMarketCapSol: 30, trades: buyersTrades(8, 44) });
    assert.equal(passesStage1(c, stage1), false);
  });

  it("accepte à partir de 5 acheteurs et ×1,5", () => {
    const c = makeCandidate({ startMarketCapSol: 30, trades: buyersTrades(5, 45) });
    assert.equal(passesStage1(c, stage1), true);
  });
});

describe("Scorer — collecte des signaux", () => {
  const config = loadConfig({});
  const candidate = makeCandidate({
    initialBuySol: 1,
    startMarketCapSol: 30,
    trades: [...buyersTrades(25, 90), makeTrade({ txType: "sell", traderPublicKey: "seller", marketCapSol: 90 })],
  });

  it("assemble le score à partir des services d'enrichissement", async () => {
    const calls: string[] = [];
    const scorer = new Scorer(
      {
        helius: {
          getTopHolderConcentration: async () => ({ topHolderPercent: 70, holderCount: 10 }),
          getMintAuthorities: async () => ({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true }),
        },
        fetchSocials: async () => ({ twitter: "https://x.com/some_account/status/123" }),
        fetchTweetText: async (url) => {
          calls.push(url);
          return "hello";
        },
      },
      config
    );

    const result = await scorer.score(candidate);
    // acheteurs 20 + ratio (25/1 ≥ 3 → 5) + holders 25 + X 15 + autorités 20 + créateur (3,3 % → 10)
    assert.equal(result.totalScore, 95);
    assert.equal(result.passed, true);
    assert.equal(result.signals.hasTwitterLink, true);
    assert.equal(result.signals.uniqueBuyers, 25);
    assert.equal(result.tweetText, "hello");
    assert.deepEqual(calls, ["https://x.com/some_account/status/123"]);
  });

  it("continue de fonctionner quand les services externes échouent", async () => {
    const scorer = new Scorer(
      {
        helius: { getTopHolderConcentration: async () => null, getMintAuthorities: async () => null },
        fetchSocials: async () => null,
        fetchTweetText: async () => assert.fail("ne doit pas être appelé sans lien X"),
      },
      config
    );

    const result = await scorer.score(candidate);
    assert.equal(result.signals.topHolderPercent, null);
    assert.equal(result.signals.authoritiesRevoked, null);
    assert.equal(result.signals.hasTwitterLink, false);
    // acheteurs 20 + ratio 5 + créateur 10 = 35 : sous le seuil d'alerte
    assert.equal(result.totalScore, 35);
    assert.equal(result.passed, false);
  });

  it("applique le seuil d'alerte configuré", async () => {
    const strict = loadConfig({ MIN_SCORE_TO_ALERT: "96" });
    const scorer = new Scorer(
      {
        helius: {
          getTopHolderConcentration: async () => ({ topHolderPercent: 70, holderCount: 10 }),
          getMintAuthorities: async () => ({ mintAuthorityRevoked: true, freezeAuthorityRevoked: true }),
        },
        fetchSocials: async () => ({ twitter: "https://x.com/some_account" }),
        fetchTweetText: async () => null,
      },
      strict
    );
    assert.equal((await scorer.score(candidate)).passed, false); // 95 < 96
  });
});
