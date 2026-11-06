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

      return json({ message: "Not found" }, 404, cors);
    } catch (e) {
      return json({ message: e.message || "Proxy error" }, 502, cors);
    }
  },
};

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}
