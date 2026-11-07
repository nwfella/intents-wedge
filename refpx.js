/**
 * refpx — US-venue reference prices for the RFQ comparison strip.
 *
 * Every venue here is a US-regulated exchange with a public, keyless price
 * endpoint. Whether a *browser* may read it is a separate question, decided by
 * the Access-Control-Allow-Origin header:
 *
 *   kind: "direct"  — sends ACAO, works from a static page
 *   kind: "proxy"   — no ACAO, needs the Cloudflare Worker (CONFIG.proxyUrl)
 *
 * Measured 2026-11-07, three to four samples per venue because a single sample
 * is not reliable (Coinbase and Gemini showed no CORS header on first contact
 * and "*" / reflected origin on every subsequent request):
 *
 *   Coinbase    ACAO: *                          direct
 *   Kraken      ACAO: reflected origin           direct
 *   Gemini      ACAO: reflected origin           direct
 *   Binance.US  ACAO: *                          direct
 *   Bitstamp    ACAO: * (1 in 4 samples absent)  direct, tolerated flake
 *   Crypto.com  ACAO: reflected origin           direct
 *   bitFlyer    no ACAO on any sample            proxy only
 *   Bullish     403 to non-browser clients       omitted
 *
 * A venue that fails is rendered as unavailable rather than silently dropped —
 * the user asked to compare against these venues, so the absence is information.
 */
window.REF_PX = (function () {
  "use strict";

  const TTL = 60000;
  const CACHE = new Map(); // key -> {usd, ts}
  const TIMEOUT = 6000;

  let proxyUrl = "";

  const VENUES = [
    { id: "coinbase",  name: "Coinbase",   kind: "direct" },
    { id: "kraken",    name: "Kraken",     kind: "direct" },
    { id: "gemini",    name: "Gemini",     kind: "direct" },
    { id: "binanceus", name: "Binance.US", kind: "direct" },
    { id: "bitstamp",  name: "Bitstamp",   kind: "direct" },
    { id: "cryptocom", name: "Crypto.com", kind: "direct" },
    { id: "bitflyer",  name: "bitFlyer US", kind: "proxy" }
  ];

  /* ── helpers ─────────────────────────────────────────────── */
  async function jget(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } });
      if (!r.ok) return null;
      return await r.json();
    } catch (_) {
      return null;
    } finally {
      clearTimeout(t);
    }
  }
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
  const mid = (b, a) => { const bb = num(b), aa = num(a); return bb && aa ? (bb + aa) / 2 : (aa || bb || null); };

  async function cached(key, fn) {
    const hit = CACHE.get(key);
    if (hit && Date.now() - hit.ts < TTL) return hit.usd;
    const usd = await fn();
    CACHE.set(key, { usd, ts: Date.now() });
    return usd;
  }

  // USDT trades a few bps off USD. Converting keeps the comparison honest
  // instead of pricing a USDT pair as though it were USD.
  async function usdtUsd() {
    return cached("fx:usdt", async () => {
      const d = await jget("https://api.binance.us/api/v3/ticker/price?symbol=USDTUSD");
      return d ? num(d.price) : null;
    });
  }

  /* ── venue adapters ──────────────────────────────────────── */
  async function coinbase(sym) {
    const d = await jget(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`);
    return d?.data ? num(d.data.amount) : null;
  }

  async function kraken(sym) {
    const base = sym === "BTC" ? "XBT" : sym;
    for (const quote of ["USD", "USDT"]) {
      const d = await jget(`https://api.kraken.com/0/public/Ticker?pair=${base}${quote}`);
      if (!d || (d.error && d.error.length)) continue;
      const res = Object.values(d.result || {})[0];
      if (!res) continue;
      const px = mid(res.b?.[0], res.a?.[0]) || num(res.c?.[0]);
      if (!px) continue;
      if (quote === "USD") return px;
      const fx = await usdtUsd();
      return fx ? px * fx : null;
    }
    return null;
  }

  async function gemini(sym) {
    const d = await jget(`https://api.gemini.com/v1/pubticker/${sym.toLowerCase()}usd`);
    if (!d || d.result === "error") return null;
    return mid(d.bid, d.ask) || num(d.last);
  }

  async function binanceus(sym) {
    for (const quote of ["USD", "USDT"]) {
      const d = await jget(`https://api.binance.us/api/v3/ticker/price?symbol=${sym}${quote}`);
      const px = d ? num(d.price) : null;
      if (!px) continue;
      if (quote === "USD") return px;
      const fx = await usdtUsd();
      return fx ? px * fx : null;
    }
    return null;
  }

  async function bitstamp(sym) {
    const d = await jget(`https://www.bitstamp.net/api/v2/ticker/${sym.toLowerCase()}usd/`);
    if (!d) return null;
    return mid(d.bid, d.ask) || num(d.last);
  }

  async function cryptocom(sym) {
    const d = await jget(`https://api.crypto.com/exchange/v1/public/get-tickers?instrument_name=${sym}_USD`);
    const row = d?.result?.data?.[0];
    if (!row) return null;
    return mid(row.b, row.k) || num(row.a);
  }

  async function viaProxy(venue, sym) {
    if (!proxyUrl) return null;
    const d = await jget(`${proxyUrl}/ref?venue=${encodeURIComponent(venue)}&symbol=${encodeURIComponent(sym)}`);
    return d ? num(d.usd) : null;
  }

  const DIRECT = { coinbase, kraken, gemini, binanceus, bitstamp, cryptocom };

  /* ── public ──────────────────────────────────────────────── */
  async function priceFor(venue, sym) {
    if (venue.kind === "proxy") return viaProxy(venue.id, sym);
    const fn = DIRECT[venue.id];
    if (!fn) return null;
    return cached(`${venue.id}:${sym}`, () => fn(sym));
  }

  function setProxy(url) { proxyUrl = url || ""; }

  /**
   * Compare an executed quote against venue mid prices.
   *   refRate  — units of `dest` per unit of `origin` at that venue's mid
   *   deltaBps — (ourRate / refRate - 1) * 10000
   *              negative → user receives less than that venue's mid (a cost)
   *              positive → user receives more than mid
   */
  async function compare(originSym, destSym, ourRate) {
    const rows = await Promise.all(VENUES.map(async (v) => {
      const [pa, pb] = await Promise.all([priceFor(v, originSym), priceFor(v, destSym)]);
      if (!pa || !pb) {
        return { id: v.id, name: v.name, ok: false,
                 reason: v.kind === "proxy" && !proxyUrl ? "needs proxy" : "not listed" };
      }
      return { id: v.id, name: v.name, ok: true, originUsd: pa, destUsd: pb,
               refRate: pa / pb, deltaBps: (ourRate / (pa / pb) - 1) * 10000 };
    }));

    const live = rows.filter(r => r.ok).sort((a, b) => b.deltaBps - a.deltaBps);
    return { rows, best: live[0] || null, available: live.length };
  }

  return { compare, setProxy, VENUES };
})();
