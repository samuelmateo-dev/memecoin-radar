// Détecte les vagues de tokens au nom quasi identique (copycats d'un nom qui décolle) au
// moment où elles se produisent, indépendamment du filtre stage 1 : la plupart de ces copies
// sont du spam sans acheteurs et ne le passeraient jamais. Quand le seuil est atteint, on
// force le suivi des 1er et 2e tokens de la vague.

export interface WaveEntry {
  mint: string;
  name: string;
  entryMarketCapSol: number;
  alreadyTracked: boolean;
}

interface WaveBucket {
  entries: WaveEntry[];
  firstSeenAt: number;
}

export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export class WaveDetector {
  private readonly buckets = new Map<string, WaveBucket>();

  constructor(
    private readonly options: { windowMs?: number; threshold?: number; now?: () => number } = {}
  ) {}

  private get windowMs(): number {
    return this.options.windowMs ?? 10 * 60 * 1000;
  }
  private get threshold(): number {
    return this.options.threshold ?? 4;
  }
  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /**
   * Enregistre un token. Retourne les tokens à suivre de force (au plus 2) uniquement au moment
   * exact où le seuil est atteint, pas à chaque occurrence suivante.
   */
  record(params: { mint: string; name: string; entryMarketCapSol: number }): WaveEntry[] {
    const key = normalizeName(params.name);
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.firstSeenAt > this.windowMs) {
      bucket = { entries: [], firstSeenAt: now };
      this.buckets.set(key, bucket);
    }
    bucket.entries.push({ ...params, alreadyTracked: false });

    if (bucket.entries.length !== this.threshold) return [];

    const toForceTrack = bucket.entries.slice(0, 2).filter((e) => !e.alreadyTracked);
    for (const entry of toForceTrack) entry.alreadyTracked = true;
    return toForceTrack;
  }

  /** À appeler périodiquement pour éviter une fuite mémoire sur les noms jamais revus. */
  cleanup(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.firstSeenAt > this.windowMs) this.buckets.delete(key);
    }
  }

  get bucketCount(): number {
    return this.buckets.size;
  }
}
