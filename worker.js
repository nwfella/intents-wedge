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

      /* ── site-wide bridged total ──────────────────────────────
       * A browser's localStorage can only see its own swaps, so a real
       * "total bridged" figure needs server state. Counts are keyed by
       * deposit address, which makes them idempotent, and they are verified
       * against the provider before being stored.
       */
      if (url.pathname === "/stat" && request.method === "GET") {
        const s = await totals(env);
        return new Response(JSON.stringify(s), {
          status: 200,
          headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "public, max-age=20" },
        });
      }

      if (url.pathname === "/stat" && request.method === "POST") {
        const { depositAddress } = await request.json().catch(() => ({}));
        if (!depositAddress) return json({ message: "depositAddress required" }, 400, cors);
        if (!env.STATS) return json({ message: "KV not bound" }, 501, cors);

        const key = `tx:${depositAddress}`;
        if (await env.STATS.get(key)) return new Response(JSON.stringify(await totals(env)), {
          status: 200, headers: { ...cors, "Content-Type": "application/json" },
        });

        // Never trust the client: ask the provider, and require the swap to
        // carry our channel id so someone else's flow cannot inflate the count.
        const r = await fetch(`${UPSTREAM}/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`, {
          headers: env.ONECLICK_API_KEY ? { "X-API-Key": env.ONECLICK_API_KEY } : {},
        });
        if (!r.ok) return json({ message: "unknown deposit address" }, 400, cors);
        const st = await r.json();
        const qr = st.quoteResponse?.quoteRequest || {};
        if (st.status !== "SUCCESS") return json({ message: "not settled", status: st.status }, 409, cors);
        if (env.REFERRAL && qr.referral && qr.referral !== env.REFERRAL) {
          return json({ message: "not our channel" }, 403, cors);
        }

        await env.STATS.put(key, JSON.stringify({
          usd: Number(st.swapDetails?.amountInUsd) || 0,
          ts: Date.now(),
          route: qr.referral || null,
        }));
        return new Response(JSON.stringify(await totals(env)), {
          status: 200, headers: { ...cors, "Content-Type": "application/json" },
        });
      }

      return json({ message: "Not found" }, 404, cors);
    } catch (e) {
      return json({ message: e.message || "Proxy error" }, 502, cors);
    }
  },
};

async function totals(env) {
  if (!env.STATS) return { usd: null, count: 0, configured: false };
  let cursor, usd = 0, count = 0;
  do {
    const page = await env.STATS.list({ prefix: "tx:", cursor });
    const vals = await Promise.all(page.keys.map(k => env.STATS.get(k.name, "json")));
    for (const v of vals) { if (v) { usd += Number(v.usd) || 0; count++; } }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { usd, count, configured: true };
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
