// Événement émis par PumpPortal quand un nouveau token est créé sur Pump.fun
export interface PumpNewTokenEvent {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: "create";
  name: string;
  symbol: string;
  uri: string;
  initialBuy: number;
  solAmount: number;
  bondingCurveKey: string;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
}

// Événement émis pour chaque achat/vente sur un mint qu'on suit activement
export interface PumpTradeEvent {
  signature: string;
  mint: string;
  traderPublicKey: string;
  txType: "buy" | "sell";
  tokenAmount: number;
  solAmount: number;
  vTokensInBondingCurve: number;
  vSolInBondingCurve: number;
  marketCapSol: number;
}

// État accumulé pour un token en cours d'observation
export interface CandidateStats {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  createdAt: number;
  initialBuySol: number;
  startMarketCapSol: number;
  metadataUri: string;
  trades: PumpTradeEvent[];
  evaluated: boolean;
}

export interface ScoreSignals {
  uniqueBuyers: number;
  buySellRatio: number;
  topHolderPercent: number | null;
  hasTwitterLink: boolean;
  authoritiesRevoked: boolean | null;
  devBuyPercent: number;
}

export interface ScoreBreakdown {
  mint: string;
  totalScore: number;
  reasons: string[];
  twitterLink?: string;
  tweetText?: string;
  passed: boolean;
  signals: ScoreSignals;
}

export interface PricePoint {
  t: number;
  marketCapSol: number;
}

// Résultat mesuré après coup pour un candidat noté (alerté ou non) : pic atteint et
// multiplicateur théorique, pour comparer objectivement au score donné.
export interface AlertOutcome {
  mint: string;
  name: string;
  symbol: string;
  alertedAt: number;
  score: number;
  entryMarketCapSol: number;
  peakMarketCapSol: number;
  peakAt: number;
  trackingEndedAt: number;
  multiple: number;
  alerted: boolean;
  signals: ScoreSignals;
  priceHistory: PricePoint[];
  // Présent uniquement si ce suivi vient de la détection de vague de noms similaires
  // (1 = premier apparu, 2 = deuxième), indépendante du score et du stage 1.
  waveRank?: 1 | 2;
}

// Ligne du fichier d'historique (outcomes.jsonl) telle qu'on la relit pour l'analyse.
// Les premières lignes enregistrées n'avaient pas encore tous les champs : les champs
// ajoutés plus tard sont donc optionnels.
export type OutcomeRow = Pick<
  AlertOutcome,
  "mint" | "name" | "score" | "entryMarketCapSol" | "peakMarketCapSol" | "multiple" | "alertedAt"
> &
  Partial<Pick<AlertOutcome, "symbol" | "alerted" | "signals" | "priceHistory" | "waveRank" | "peakAt" | "trackingEndedAt">>;
