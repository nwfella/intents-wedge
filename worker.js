/**
 * intents-wedge — optional Cloudflare Worker
 *
 * Only needed if you get an API key from https://partners.near-intents.org.
 * An API key must never ship in client HTML, so it lives here as a secret and
 * the frontend points CONFIG.proxyUrl at this Worker instead of calling 1Click directly.
 *
 * It also re-writes appFees server-side, so a user cannot edit your fee out of the
 * quote by tampering with the page's JavaScript.
 *
 * Deploy:
 *   npm i -g wrangler
 *   wrangler init intents-wedge-proxy        # or drop this file in an existing worker
 *   wrangler secret put ONECLICK_API_KEY     # paste the key from the Partner Portal
 *   wrangler secret put FEE_RECIPIENT        # your .near or 0x… address
 *   wrangler secret put ALLOWED_ORIGIN       # e.g. https://yourname.github.io
 *   wrangler deploy
 */

const UPSTREAM = "https://1click.chaindefuser.com";

const CORS = (origin) => ({
  "Access-Control-Allow-Origin": origin,
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = env.ALLOWED_ORIGIN || "*";
    const cors = CORS(allowed === "*" ? "*" : allowed);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    // Reject foreign origins when a specific one is configured.
    if (allowed !== "*" && origin && origin !== allowed) {
      return json({ message: "Origin not allowed" }, 403, cors);
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/quote" && request.method === "POST") {
        const body = await request.json();

        // Server-side fee enforcement — ignore whatever the client asked for.
        const feeBps = Number(env.FEE_BPS || 20);
        if (feeBps > 0 && env.FEE_RECIPIENT) {
          body.appFees = [{ recipient: env.FEE_RECIPIENT, fee: feeBps }];
        }

        const r = await fetch(`${UPSTREAM}/v0/quote`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(env.ONECLICK_API_KEY ? { "X-API-Key": env.ONECLICK_API_KEY } : {}),
          },
          body: JSON.stringify(body),
        });
        return new Response(await r.text(), {
          status: r.status,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/status" && request.method === "GET") {
        const q = new URLSearchParams();
        for (const k of ["depositAddress", "depositMemo"]) {
          const v = url.searchParams.get(k);
          if (v) q.set(k, v);
        }
        const r = await fetch(`${UPSTREAM}/v0/status?${q}`, {
          headers: env.ONECLICK_API_KEY ? { "X-API-Key": env.ONECLICK_API_KEY } : {},
        });
        return new Response(await r.text(), {
          status: r.status,
          headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      if (url.pathname === "/tokens" && request.method === "GET") {
        const r = await fetch(`${UPSTREAM}/v0/tokens`);
        return new Response(await r.text(), {
          status: r.status,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=300" },
        });
      }

      if (url.pathname === "/ref" && request.method === "GET") {
        const venue = (url.searchParams.get("venue") || "").toLowerCase();
        const sym = (url.searchParams.get("symbol") || "").toUpperCase();
        if (!/^[A-Z0-9]{2,10}$/.test(sym)) return json({ usd: null }, 400, cors);
        const usd = await refPrice(venue, sym);
        return new Response(JSON.stringify({ venue, symbol: sym, usd }), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
        });
      }

      return json({ message: "Not found" }, 404, cors);
    } catch (e) {
      return json({ message: e.message || "Proxy error" }, 502, cors);
    }
  },
};

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };

/**
 * The venues the browser cannot reach itself: Coinbase, Gemini and Bitstamp all
 * serve public prices without an Access-Control-Allow-Origin header.
 */
async function refPrice(venue, sym) {
  const lower = sym.toLowerCase();
  try {
    if (venue === "coinbase") {
      const r = await fetch(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`);
      if (!r.ok) return null;
      return num((await r.json())?.data?.amount);
    }
    if (venue === "gemini") {
      const r = await fetch(`https://api.gemini.com/v1/pubticker/${lower}usd`);
      if (!r.ok) return null;
      const j = await r.json();
      const b = num(j.bid), a = num(j.ask);
      return b && a ? (b + a) / 2 : (num(j.last) || null);
    }
    if (venue === "bitflyer") {
      const r = await fetch(`https://api.bitflyer.com/v1/ticker?product_code=${sym}_USD`);
      if (!r.ok) return null;
      return num((await r.json()).ltp);
    }
    if (venue === "bitstamp") {
      const r = await fetch(`https://www.bitstamp.net/api/v2/ticker/${lower}usd/`);
      if (!r.ok) return null;
      const j = await r.json();
      const b = num(j.bid), a = num(j.ask);
      return b && a ? (b + a) / 2 : (num(j.last) || null);
    }
  } catch (_) { /* unlisted or unreachable */ }
  return null;
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
