import "dotenv/config";
import "./logger.js"; // horodate tous les console.log/warn/error à partir d'ici
import path from "node:path";
import { loadConfig } from "./config.js";
import { PumpListener } from "./sources/pumpListener.js";
import { HeliusClient } from "./enrichment/heliusClient.js";
import { fetchTokenSocials, fetchTweetText } from "./enrichment/metadata.js";
import { getSolUsdPrice } from "./enrichment/solPrice.js";
import { Scorer } from "./scoring/scoring.js";
import { TelegramNotifier } from "./notify/telegramNotifier.js";
import { OutcomeTracker } from "./tracking/outcomeTracker.js";
import { WaveDetector } from "./tracking/waveDetector.js";
import { PaperBroker } from "./execution/broker.js";
import { PositionManager } from "./execution/positionManager.js";
import { Radar } from "./radar.js";

const config = loadConfig();

for (const [name, value] of [
  ["HELIUS_API_KEY", config.heliusApiKey],
  ["TELEGRAM_BOT_TOKEN", config.telegramBotToken],
  ["TELEGRAM_CHAT_ID", config.telegramChatId],
] as const) {
  if (!value) console.warn(`[config] ${name} non défini — fonctionnalité correspondante désactivée.`);
}

const logDir = path.resolve("logs");

const radar = new Radar({
  config,
  source: new PumpListener(config),
  scorer: new Scorer(
    {
      helius: new HeliusClient({ apiKey: config.heliusApiKey }),
      fetchSocials: (uri) => fetchTokenSocials(uri),
      fetchTweetText: (url) => fetchTweetText(url),
    },
    config
  ),
  notifier: new TelegramNotifier({
    botToken: config.telegramBotToken,
    chatId: config.telegramChatId,
    getSolUsdPrice,
  }),
  tracker: new OutcomeTracker(path.join(logDir, "outcomes.jsonl")),
  positions: new PositionManager(new PaperBroker(), config.paper, path.join(logDir, "paper-trades.jsonl")),
  waves: new WaveDetector(),
  getSolUsdPrice,
});

console.log("🚀 Memecoin Radar démarré — connexion au flux Pump.fun...");
console.log("💡 Mode simulation : aucune transaction réelle n'est jamais envoyée.");
const stop = radar.start();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n[radar] ${signal} reçu — arrêt.`);
    stop();
    process.exit(0);
  });
}
