import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { HeliusClient } from "../src/enrichment/heliusClient.js";
import {
  IPFS_GATEWAYS,
  extractIpfsCid,
  extractTweetTextFromHtml,
  fetchTokenSocials,
  fetchTweetText,
  looksLikeRealTwitterLink,
} from "../src/enrichment/metadata.js";
import { PumpListener } from "../src/sources/pumpListener.js";
import { makeNewTokenEvent, makeTrade } from "./helpers.js";

const json = (body: unknown, ok = true) => ({ ok, json: async () => body, text: async () => JSON.stringify(body) }) as Response;

function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const e = mock.method(console, "error", () => {});
  return fn().finally(() => e.mock.restore());
}

describe("HeliusClient", () => {
  it("calcule la concentration des 10 plus gros holders sur l'offre totale", async () => {
    const accounts = [300, 200, 100, 50, 50, 50, 50, 50, 50, 50, 1000].map((n) => ({ amount: String(n) })); // le 11e est ignoré
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const { method } = JSON.parse(init.body as string);
      if (method === "getTokenLargestAccounts") return json({ result: { value: accounts } });
      return json({ result: { value: { amount: "1000" } } }); // getTokenSupply
    }) as unknown as typeof fetch;

    const client = new HeliusClient({ apiKey: "k", fetchImpl, minDelayMs: 0 });
    const r = await client.getTopHolderConcentration("mint");
    assert.equal(r?.topHolderPercent, 95); // (300+200+100+7×50) / 1000 — le 11e compte (1000) est ignoré
    assert.equal(r?.holderCount, 11);
  });

  it("renvoie null si l'offre est nulle ou si l'appel échoue", async () => {
    const zero = (async () => json({ result: { value: { amount: "0" } } })) as unknown as typeof fetch;
    assert.equal(await new HeliusClient({ apiKey: "k", fetchImpl: zero, minDelayMs: 0 }).getTopHolderConcentration("m"), null);

    const failing = (async () => json({ error: { message: "rate limited" } })) as unknown as typeof fetch;
    await quiet(async () =>
      assert.equal(await new HeliusClient({ apiKey: "k", fetchImpl: failing, minDelayMs: 0 }).getMintAuthorities("m"), null)
    );
  });

  it("lit l'état des autorités (null = révoquée)", async () => {
    const mk = (mintAuthority: string | null, freezeAuthority: string | null) =>
      (async () => json({ result: { value: { data: { parsed: { info: { mintAuthority, freezeAuthority } } } } } })) as unknown as typeof fetch;

    const both = await new HeliusClient({ apiKey: "k", fetchImpl: mk(null, null), minDelayMs: 0 }).getMintAuthorities("m");
    assert.deepEqual(both, { mintAuthorityRevoked: true, freezeAuthorityRevoked: true });
    const active = await new HeliusClient({ apiKey: "k", fetchImpl: mk("someone", null), minDelayMs: 0 }).getMintAuthorities("m");
    assert.deepEqual(active, { mintAuthorityRevoked: false, freezeAuthorityRevoked: true });
  });

  it("une erreur n'empêche pas les appels suivants (file d'attente)", async () => {
    let n = 0;
    const flaky = (async () => {
      n++;
      if (n === 1) throw new Error("réseau");
      return json({ result: { value: { data: { parsed: { info: { mintAuthority: null, freezeAuthority: null } } } } } });
    }) as unknown as typeof fetch;
    const client = new HeliusClient({ apiKey: "k", fetchImpl: flaky, minDelayMs: 0 });
    await quiet(async () => {
      assert.equal(await client.getMintAuthorities("a"), null);
      assert.notEqual(await client.getMintAuthorities("b"), null);
    });
  });
});

describe("métadonnées du token", () => {
  it("extrait le CID IPFS d'une URI", () => {
    assert.equal(extractIpfsCid("https://ipfs.io/ipfs/QmAbc123"), "QmAbc123");
    assert.equal(extractIpfsCid("https://arweave.net/xyz"), null);
  });

  it("essaie plusieurs passerelles et prend la première qui répond", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return url.startsWith("https://dweb.link") ? json({ twitter: "https://x.com/foo", website: 42 }) : json({}, false);
    }) as unknown as typeof fetch;

    const socials = await fetchTokenSocials("https://ipfs.io/ipfs/QmAbc", { fetchImpl, retryDelayMs: 0 });
    assert.deepEqual(socials, { twitter: "https://x.com/foo", telegram: undefined, website: undefined });
    assert.equal(asked.length, IPFS_GATEWAYS.length);
    assert.ok(asked.every((u) => u.endsWith("QmAbc")));
  });

  it("réessaie une fois quand toutes les passerelles échouent, puis abandonne", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return json({}, false);
    }) as unknown as typeof fetch;
    await quiet(async () => {
      assert.equal(await fetchTokenSocials("https://ipfs.io/ipfs/QmAbc", { fetchImpl, retryDelayMs: 0 }), null);
    });
    assert.equal(calls, 2 * IPFS_GATEWAYS.length);
  });

  it("utilise l'URI telle quelle quand ce n'est pas de l'IPFS, et renvoie null pour une URI vide", async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return json({ telegram: "https://t.me/x" });
    }) as unknown as typeof fetch;
    const socials = await fetchTokenSocials("https://arweave.net/abc", { fetchImpl, retryDelayMs: 0 });
    assert.equal(socials?.telegram, "https://t.me/x");
    assert.deepEqual(asked, ["https://arweave.net/abc"]);
    assert.equal(await fetchTokenSocials("", { fetchImpl }), null);
  });

  it("reconnaît un vrai lien X et rejette les placeholders", () => {
    assert.equal(looksLikeRealTwitterLink("https://x.com/some_user"), true);
    assert.equal(looksLikeRealTwitterLink("https://twitter.com/some_user/status/1"), true);
    assert.equal(looksLikeRealTwitterLink("https://x.com/"), false);
    assert.equal(looksLikeRealTwitterLink("https://example.com/x.com"), false);
    assert.equal(looksLikeRealTwitterLink(""), false);
    assert.equal(looksLikeRealTwitterLink(undefined), false);
  });

  it("extrait le texte d'un tweet depuis le HTML oEmbed", () => {
    const html = '<blockquote><p lang="en">Hello &amp; <a href="x">pic.twitter.com/abc</a> &quot;world&quot;</p></blockquote>';
    assert.equal(extractTweetTextFromHtml(html), 'Hello &  "world"');
    assert.equal(extractTweetTextFromHtml("<div></div>"), null);
    assert.equal(extractTweetTextFromHtml("<p></p>"), null);
  });

  it("n'appelle pas oEmbed pour un simple lien de profil", async () => {
    const fetchImpl = (async () => assert.fail("ne doit pas appeler le réseau")) as unknown as typeof fetch;
    assert.equal(await fetchTweetText("https://x.com/user", { fetchImpl }), null);
  });

  it("récupère le texte d'un tweet précis", async () => {
    const fetchImpl = (async () => json({ html: "<blockquote><p>gm</p></blockquote>" })) as unknown as typeof fetch;
    assert.equal(await fetchTweetText("https://x.com/user/status/123", { fetchImpl }), "gm");
  });
});

describe("PumpListener — aiguillage des messages", () => {
  const listener = () => new PumpListener({ pumpWsUrl: "ws://localhost:0", pumpApiKey: "" });

  it("émet newToken pour une création et trade pour un achat ou une vente", () => {
    const l = listener();
    const events: string[] = [];
    l.on("newToken", (e) => events.push(`new:${e.mint}`));
    l.on("trade", (e) => events.push(`${e.txType}:${e.mint}`));

    l.handleMessage(makeNewTokenEvent({ mint: "A" }));
    l.handleMessage(makeTrade({ mint: "A", txType: "buy" }));
    l.handleMessage(makeTrade({ mint: "A", txType: "sell" }));
    assert.deepEqual(events, ["new:A", "buy:A", "sell:A"]);
  });

  it("ignore les accusés de réception, les créations de pool et les messages vides", () => {
    const l = listener();
    const log = mock.method(console, "log", () => {});
    let emitted = 0;
    l.on("newToken", () => emitted++);
    l.on("trade", () => emitted++);
    l.handleMessage({ message: "Successfully subscribed to keys." });
    l.handleMessage({ message: "Unsubscribed." });
    l.handleMessage({ txType: "create_pool" });
    l.handleMessage(null);
    l.handleMessage(undefined);
    log.mock.restore();
    assert.equal(emitted, 0);
  });

  it("ne journalise que 10 messages inattendus", () => {
    const l = listener();
    const log = mock.method(console, "log", () => {});
    for (let i = 0; i < 25; i++) l.handleMessage({ inattendu: i });
    const count = log.mock.callCount();
    log.mock.restore();
    assert.equal(count, 10);
  });

  it("compte les tokens suivis sans doublon", () => {
    const l = listener();
    l.trackMint("A");
    l.trackMint("A");
    l.trackMint("B");
    assert.equal(l.trackedCount, 2);
    l.untrackMint("A");
    l.untrackMint("inconnu");
    assert.equal(l.trackedCount, 1);
  });
});
