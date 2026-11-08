import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { TelegramNotifier, escapeMd } from "../src/notify/telegramNotifier.js";
import { loadConfig } from "../src/config.js";
import type { AlertOutcome, ScoreBreakdown } from "../src/types.js";
import { makeCandidate } from "./helpers.js";

const score: ScoreBreakdown = {
  mint: "MINT",
  totalScore: 82,
  reasons: ["20 acheteurs uniques", "⚠️ top 10 holders = 99.0% (extrêmement concentré)"],
  twitterLink: "https://x.com/user/status/1",
  tweetText: "to_the_moon *now*",
  passed: true,
  signals: {
    uniqueBuyers: 20,
    buySellRatio: 2,
    topHolderPercent: 60,
    hasTwitterLink: true,
    authoritiesRevoked: true,
    devBuyPercent: 3,
  },
};

function recorder(status = 200) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) });
    return { ok: status === 200, text: async () => "erreur" } as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("TelegramNotifier", () => {
  it("échappe le Markdown dans les textes venant des créateurs de tokens", () => {
    assert.equal(escapeMd("a_b*c`d[e]"), "a\\_b\\*c\\`d\\[e\\]");
  });

  it("envoie l'alerte au bon chat avec les liens et le texte échappé", async () => {
    const { calls, fetchImpl } = recorder();
    const n = new TelegramNotifier({ botToken: "TOK", chatId: "42", getSolUsdPrice: async () => null, fetchImpl });
    await n.sendAlert(makeCandidate({ name: "Mon_Token", symbol: "MT" }), score);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.telegram.org/botTOK/sendMessage");
    assert.equal(calls[0].body.chat_id, "42");
    assert.equal(calls[0].body.parse_mode, "Markdown");
    const text: string = calls[0].body.text;
    assert.ok(text.includes("Mon\\_Token"));
    assert.ok(text.includes("82/100"));
    assert.ok(text.includes("https://pump.fun/MINT"));
    assert.ok(text.includes("to\\_the\\_moon \\*now\\*"));
  });

  it("se rabat sur la console quand Telegram n'est pas configuré", async () => {
    const { calls, fetchImpl } = recorder();
    const log = mock.method(console, "log", () => {});
    const n = new TelegramNotifier({ botToken: "", chatId: "", getSolUsdPrice: async () => null, fetchImpl });
    await n.sendAlert(makeCandidate(), score);
    const printed = String(log.mock.calls[0]?.arguments[0]);
    log.mock.restore();
    assert.equal(calls.length, 0);
    assert.ok(printed.startsWith("ALERTE:"));
  });

  it("n'échoue pas quand Telegram répond une erreur", async () => {
    const { fetchImpl } = recorder(500);
    const err = mock.method(console, "error", () => {});
    const n = new TelegramNotifier({ botToken: "TOK", chatId: "42", getSolUsdPrice: async () => null, fetchImpl });
    await n.sendConnectivityNotice("coupure");
    const reported = err.mock.callCount();
    err.mock.restore();
    assert.equal(reported, 1);
  });

  it("le rapport de résultat affiche des dollars si le prix du SOL est connu, sinon des SOL", async () => {
    const outcome: AlertOutcome = {
      mint: "MINT",
      name: "Tok",
      symbol: "T",
      alertedAt: 0,
      score: 82,
      entryMarketCapSol: 100,
      peakMarketCapSol: 250,
      peakAt: 1,
      trackingEndedAt: 15 * 60_000,
      multiple: 2.5,
      alerted: true,
      signals: score.signals,
      priceHistory: [],
    };

    const withPrice = recorder();
    await new TelegramNotifier({
      botToken: "T",
      chatId: "1",
      getSolUsdPrice: async () => 100,
      fetchImpl: withPrice.fetchImpl,
    }).sendOutcomeReport(outcome);
    const t1: string = withPrice.calls[0].body.text;
    assert.ok(t1.includes("$10,000") && t1.includes("$25,000"));
    assert.ok(t1.includes("x2.50") && t1.includes("15 min"));
    assert.ok(t1.startsWith("✅"));

    const withoutPrice = recorder();
    await new TelegramNotifier({
      botToken: "T",
      chatId: "1",
      getSolUsdPrice: async () => null,
      fetchImpl: withoutPrice.fetchImpl,
    }).sendOutcomeReport({ ...outcome, multiple: 1.05 });
    const t2: string = withoutPrice.calls[0].body.text;
    assert.ok(t2.includes("100.0 SOL") && t2.includes("250.0 SOL"));
    assert.ok(t2.startsWith("❌"));
  });
});

describe("loadConfig", () => {
  it("a des valeurs par défaut utilisables sans aucune variable", () => {
    const c = loadConfig({});
    assert.equal(c.observationWindowMs, 45_000);
    assert.equal(c.minScoreToAlert, 70);
    assert.equal(c.paper.takeProfitMultiple, 1.25);
    assert.equal(c.paper.stopLossMultiple, 0.5);
    assert.equal(c.paper.maxConcurrentPositions, 3);
    assert.equal(c.heliusApiKey, "");
  });

  it("lit les variables d'environnement et traite une valeur vide comme absente", () => {
    const c = loadConfig({ MIN_SCORE_TO_ALERT: "85", TRADE_AMOUNT_SOL: "0.25", HELIUS_API_KEY: "  cle  ", PUMP_API_KEY: "" });
    assert.equal(c.minScoreToAlert, 85);
    assert.equal(c.paper.tradeAmountSol, 0.25);
    assert.equal(c.heliusApiKey, "cle");
    assert.equal(c.pumpApiKey, "");
  });

  it("refuse une valeur numérique invalide au lieu de la propager silencieusement", () => {
    assert.throws(() => loadConfig({ MIN_SCORE_TO_ALERT: "beaucoup" }), /MIN_SCORE_TO_ALERT/);
    assert.throws(() => loadConfig({ OBSERVATION_WINDOW_MS: "Infinity" }), /OBSERVATION_WINDOW_MS/);
  });

  it("ne contient aucun réglage de trading réel (wallet, clé privée)", () => {
    const c = loadConfig({ WALLET_PRIVATE_KEY: "secret", WALLET_PUBLIC_KEY: "pub", DRY_RUN: "false" });
    assert.ok(!JSON.stringify(c).includes("secret"));
    assert.ok(!("walletPrivateKey" in c));
    assert.ok(!("dryRun" in c));
  });
});
