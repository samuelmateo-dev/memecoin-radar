export interface TokenSocials {
  twitter?: string;
  telegram?: string;
  website?: string;
}

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Délai avant la seconde tentative (propagation IPFS parfois lente). */
  retryDelayMs?: number;
}

// Passerelles IPFS publiques : le même contenu (même CID) y est mis en miroir, mais chacune
// a son propre délai de propagation. En tenter plusieurs en parallèle limite l'échec
// « pas encore propagé sur CETTE passerelle précise ».
export const IPFS_GATEWAYS = [
  "https://ipfs.io/ipfs/",
  "https://cloudflare-ipfs.com/ipfs/",
  "https://gateway.pinata.cloud/ipfs/",
  "https://dweb.link/ipfs/",
];

// Sans User-Agent de navigateur, certaines passerelles (ipfs.io notamment) refusent la
// requête comme trafic de bot.
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export function extractIpfsCid(uri: string): string | null {
  const match = uri.match(/\/ipfs\/([A-Za-z0-9]+)/);
  return match ? match[1] : null;
}

async function fetchJsonOnce(url: string, timeoutMs: number, fetchImpl: typeof fetch): Promise<any | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { "User-Agent": BROWSER_UA, Accept: "application/json,*/*" },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Tente toutes les URLs en parallèle et retourne le premier JSON obtenu (null si aucune ne répond).
function fetchFirstSuccess(urls: string[], timeoutMs: number, fetchImpl: typeof fetch): Promise<any | null> {
  return new Promise((resolve) => {
    let remaining = urls.length;
    let done = false;
    for (const url of urls) {
      fetchJsonOnce(url, timeoutMs, fetchImpl).then((json) => {
        remaining--;
        if (!done && json) {
          done = true;
          resolve(json);
        } else if (remaining === 0 && !done) {
          resolve(null);
        }
      });
    }
  });
}

function toSocials(json: any): TokenSocials {
  return {
    twitter: typeof json.twitter === "string" ? json.twitter : undefined,
    telegram: typeof json.telegram === "string" ? json.telegram : undefined,
    website: typeof json.website === "string" ? json.website : undefined,
  };
}

// Le champ `uri` d'un événement Pump.fun pointe vers un JSON (IPFS/Arweave) contenant les
// métadonnées du token, dont les liens sociaux ajoutés par le créateur. Gratuit : une simple
// requête HTTP vers un fichier déjà connu, sans passer par l'API X payante.
export async function fetchTokenSocials(uri: string, options: FetchOptions = {}): Promise<TokenSocials | null> {
  if (!uri) return null;
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5000;
  const retryDelayMs = options.retryDelayMs ?? 3000;

  const cid = extractIpfsCid(uri);
  const urlsToTry = cid ? IPFS_GATEWAYS.map((gw) => gw + cid) : [uri];

  let json = await fetchFirstSuccess(urlsToTry, timeoutMs, fetchImpl);
  if (!json) {
    // Toutes les passerelles ont échoué : une seconde tentative après un court délai, au cas
    // où ce soit purement une question de propagation.
    await new Promise((r) => setTimeout(r, retryDelayMs));
    json = await fetchFirstSuccess(urlsToTry, timeoutMs, fetchImpl);
  }
  if (!json) {
    console.error(`[metadata] Échec sur toutes les passerelles (2 tentatives) pour ${uri}`);
    return null;
  }
  return toSocials(json);
}

// Vérifie que le lien ressemble à un vrai profil/tweet X, pas à un placeholder vide.
export function looksLikeRealTwitterLink(url?: string): boolean {
  if (!url) return false;
  return /(twitter\.com|x\.com)\/[A-Za-z0-9_]+/.test(url);
}

// Texte brut d'un tweet précis (pas d'un simple profil) via l'endpoint oEmbed public d'X :
// gratuit, sans clé. On n'essaie pas de juger si le tweet « va faire le buzz » (aucune base
// fiable) : le texte est juste affiché dans l'alerte pour que l'utilisateur juge lui-même.
export async function fetchTweetText(twitterUrl: string, options: FetchOptions = {}): Promise<string | null> {
  if (!/\/status\/\d+/.test(twitterUrl)) return null;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(twitterUrl)}&omit_script=true`;
    const res = await fetchImpl(oembedUrl, { signal: controller.signal });
    if (!res.ok) return null;
    const json: any = await res.json();
    if (typeof json.html !== "string") return null;
    return extractTweetTextFromHtml(json.html);
  } catch (err) {
    console.error(`[metadata] Impossible de récupérer le texte du tweet ${twitterUrl}:`, (err as Error).message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Extraction « au mieux » du texte depuis le HTML d'oEmbed (pas un vrai parseur HTML :
// suffisant pour la structure stable de cet endpoint).
export function extractTweetTextFromHtml(html: string): string | null {
  const match = html.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  if (!match) return null;
  const raw = match[1]
    .replace(/<a[^>]*>.*?<\/a>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
  return raw.length > 0 ? raw.slice(0, 280) : null;
}
