import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import type { CandidateStats, PumpNewTokenEvent, PumpTradeEvent } from "../src/types.js";

/** Dossier temporaire supprimé à la fin du fichier de test. */
export function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "radar-test-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function makeTrade(overrides: Partial<PumpTradeEvent> = {}): PumpTradeEvent {
  return {
    signature: "sig",
    mint: "MINT",
    traderPublicKey: "trader",
    txType: "buy",
    tokenAmount: 1000,
    solAmount: 1,
    vTokensInBondingCurve: 1_000_000,
    vSolInBondingCurve: 30,
    marketCapSol: 30,
    ...overrides,
  };
}

export function makeNewTokenEvent(overrides: Partial<PumpNewTokenEvent> = {}): PumpNewTokenEvent {
  return {
    signature: "sig",
    mint: "MINT",
    traderPublicKey: "creator",
    txType: "create",
    name: "Token",
    symbol: "TKN",
    uri: "https://ipfs.io/ipfs/QmTest",
    initialBuy: 1000,
    solAmount: 1,
    bondingCurveKey: "curve",
    vTokensInBondingCurve: 1_000_000,
    vSolInBondingCurve: 30,
    marketCapSol: 30,
    ...overrides,
  };
}

export function makeCandidate(overrides: Partial<CandidateStats> = {}): CandidateStats {
  return {
    mint: "MINT",
    name: "Token",
    symbol: "TKN",
    creator: "creator",
    createdAt: 0,
    initialBuySol: 1,
    startMarketCapSol: 30,
    metadataUri: "https://ipfs.io/ipfs/QmTest",
    trades: [],
    evaluated: false,
    ...overrides,
  };
}

/** `n` achats de `n` acheteurs distincts, avec un market cap qui monte jusqu'à `finalMarketCap`. */
export function buyersTrades(n: number, finalMarketCap: number, mint = "MINT"): PumpTradeEvent[] {
  return Array.from({ length: n }, (_, i) =>
    makeTrade({
      mint,
      traderPublicKey: `buyer-${i}`,
      txType: "buy",
      marketCapSol: 30 + ((finalMarketCap - 30) * (i + 1)) / n,
    })
  );
}
