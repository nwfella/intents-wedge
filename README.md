# intents-wedge

Two swap frontends that earn a fee on every swap they route through NEAR Intents.
Zero dependencies, static HTML, no build step, no backend.

| Page | Route | Audience | Minimum |
|---|---|---|---|
| `index.html` | BNB Chain → Base / Arbitrum / Ethereum / Polygon | whale / treasury | **capped, ~$1–2k** |
| `l2.html` | Ethereum ⇄ Base ⇄ Arbitrum ⇄ Optimism ⇄ Polygon | retail | **none** |
| `bridge.html` | **any token → any token**, 39 chains / 216 assets | lowest-friction | depends on origin |

```
index.html      route A — CAPPED corridor (BSC), fixed origin
l2.html         route B — UNCAPPED EVM corridor, selectable origin
wedge-core.js   the engine; both pages are just a WEDGE_CONFIG
wedge.css       shared styles
dashboard.html  operator view — completed swaps, per-route A/B breakdown
worker.js       optional Cloudflare Worker: hides the API key, enforces the fee
scripts/verify.js   live provider-contract gate      (31 assertions)
scripts/uicheck.js  headless two-route flow gate     (20 assertions)
```

## The minimum is per-route, not global

This is the single most important fact about the product, and it is why there are two pages.

Measured 2026-11-06 (`scripts/verify.js` re-checks it both ways):

| Corridor | $10 | $50 | $100 | $1,000 | $2,000 |
|---|---|---|---|---|---|
| eth → base / arb / op / pol | ✅ | ✅ | ✅ | ✅ | ✅ |
| base → arb / eth / op / pol | ✅ | ✅ | ✅ | ✅ | ✅ |
| arb → base / eth / op / pol | ✅ | ✅ | ✅ | ✅ | ✅ |
| **bsc** → base / arb / eth / pol | ❌ | ❌ | ❌ | ❌ | ✅ |
| **sol** → anywhere | ❌ | ❌ | ❌ | ❌ | ❌ |

Anything touching BNB Chain or Solana is capped. The EVM corridors accept **$10**.

Two consequences:

1. **The engine has no client-side minimum.** A hard-coded floor turns a transient routing
   limit into a permanent product limit. The UI submits whatever the user typed and, if the
   corridor is capped, surfaces the provider's own message with a pointer to an open route.
2. **"Exit BNB Chain" cannot serve small tickets, and that is not fixable in code.** If the
   audience you want is retail, `l2.html` is the page that serves them.

The cap is described by the provider as *temporary* and it moves with liquidity, so treat the
table above as a snapshot, not a constant. The gate is what keeps this honest.

## Universal bridge (`bridge.html`)

`mode: "bridge"` swaps the two fixed selects for two grouped token pickers over the provider's
entire asset list — 216 tokens on 39 chains, including non-EVM destinations like native Zcash,
Bitcoin, Monero-adjacent chains and Tron.

### What actually works, measured

Your stated route, tested 2026-11-06:

| Route | Result |
|---|---|
| **USDT on BSC → ZEC native** | ✅ from ~$1,500 (BSC origin is capped) |
| **USDC on Base → ZEC native** | ✅ from $10, no minimum |
| USDT on Base / Arbitrum | ❌ **USDT does not exist on those chains** in the provider's list — use USDC |

USDT lives on: aptos, avax, bsc, eth, gnosis, miden, near, op, pol, scroll, sol, ton, tron.
ZEC lives on: aptos, near, sol, starknet, **zec (native)**.

The picker is built from `/v0/tokens` at runtime, so a token that does not exist on a chain
simply isn't offered — that class of error cannot happen in the UI.

### Capped origins

The cap follows the **origin chain**, not the pair:

| Origin | Sub-$1k? |
|---|---|
| bsc, tron | ❌ capped ~$1–2k |
| eth, base, arb, op, pol, avax, scroll, monad, xlayer, hypercore | ✅ any size |

The bridge flags a capped origin in the refund-address note before the user submits, rather
than letting them discover it on a failed quote.

### Exotic pairs carry real spread — say so

ZEC legs cost more than stablecoin legs, and small tickets cost more than large ones:

| Route | Size | All-in |
|---|---|---|
| USDC/Base → ZEC | $50 | ~0.85–1.2% |
| USDC/Base → ZEC | $500 | ~0.47% |
| USDC/Base → ZEC | $3,000 | ~0.44% |

Of that, 20 bps is the fee and the rest is solver spread on the pair. The UI now shows
"Service fee" and "Total cost" as separate rows, and labels the gap as routing spread, so a
user comparing against a CEX sees the real number rather than your 0.20%.

### "Trustless" — the accurate word is non-custodial

The page says non-custodial, and that is what it is: no custodian holds the funds, and the
quote-specific deposit address is not yours. It is **not** trustless in the cryptographic
sense — solvers post inventory they must honour, and quotes are signed by the provider. If
you need trustless, that is a different architecture (atomic swaps or a light client), and
this rail is not it. Don't put "trustless" in the marketing copy.

## Verified live behaviour

| Fact | Value |
|---|---|
| Fee mechanism | `appFees`; `fee: 20` → **10 bps to you, 10 bps to 1Click** |
| All-in cost, $5,000 BSC→Base | **0.209%** |
| All-in cost, $10 ETH→Base | **0.225%** — the fee scales, it does not floor |
| Keyless surcharge | **not applied** on stablecoin routes — no API key needed to launch |
| CORS | `Access-Control-Allow-Origin: *` — static hosting works |
| Assets | 216 supported |
| Decimals | USDC on BSC = **18**, on Base/Arbitrum/Ethereum = **6** |
| Status | `GET /v0/status?depositAddress=…`, **no auth**, echoes the original quote |

Decimals are resolved from `/v0/tokens` and converted with `BigInt`. A hardcoded `1e6` would
send 10¹²× the intended amount on BSC.

## Run

```bash
python -m http.server 8931
# http://127.0.0.1:8931/        route A
# http://127.0.0.1:8931/l2.html route B
node scripts/verify.js     # live API contract
node scripts/uicheck.js    # both routes, headless (server must be running)
```

## Deploy

Static — GitHub Pages.

```bash
gh repo create intents-wedge --public --source=. --push
gh api repos/nwfella/intents-wedge/pages -X POST \
  -f "source[branch]=main" -f "source[path]=/"
```

The fee recipient address is public in both pages. It is a public address either way, but it
does link the product to the operator.

## The A/B

Two hypotheses, one engine, one fee:

- **A — "Exit BNB Chain"**: high-intent whale/treasury query, but the corridor is capped and
  there is no free flow to intercept.
- **B — "Any-Chain USDC"**: any-size retail/L2 traffic, uncapped, but it competes on a
  commodity route where every wallet gives the same swap away for 0 bps.

Separate referral ids (`hermes-wedge-bsc`, `hermes-wedge-l2`) make the two measurable in the
explorer; `dashboard.html` breaks volume and fees out per route. Read the comparison on
**average ticket** and **swap count**, not gross volume — route A will win volume on one trade.

## Retargeting

Everything is one object at the top of each page:

```js
window.WEDGE_CONFIG = {
  id: "bsc-out",
  referral: "hermes-wedge-bsc",
  feeBps: 20,                    // total charged; you keep ~half
  recipient: "0x…",              // EVM, implicit (64 hex), or named .near
  allowOriginSelect: false,      // true → origin becomes a selector
  origins: [{ blockchain: "bsc", label: "BNB Chain" }],
  destinations: [{ blockchain: "base", label: "Base" }],
  assets: ["USDC", "USDT"],
  minHint: "…"                   // copy only — never enforced
};
```

New route = new HTML file with a new `WEDGE_CONFIG` and a new `referral`. The engine never
changes, so the A/B cannot drift.

## Economics

At `feeBps: 20` your take is 10 bps of routed volume.

| Monthly volume | Your fees/mo |
|---|---|
| $100k | $100 |
| $500k | $500 |
| $1M | $1,000 |
| $5M | $5,000 |

Zero until there is traffic. The gas rebate this replaces paid the average NEAR contract
$5.93/month, so the bar is low — but the work is distribution, not code.

**Watch the small-ticket economics.** At $10 a swap, 10 bps is $0.01. A thousand of those is
$10 and will not cover the fees to receive them. Route B's value is engagement and repeat
usage that compounds into larger tickets — not the unit margin on a $10 swap.

## API key (optional)

Launch keyless. Add the key only when you want the authenticated schedule on volatile pairs.

```bash
wrangler secret put ONECLICK_API_KEY   # https://partners.near-intents.org
wrangler secret put FEE_RECIPIENT
wrangler secret put ALLOWED_ORIGIN
wrangler secret put FEE_BPS            # 20
wrangler deploy
```

Then set `proxyUrl` in `WEDGE_CONFIG`. The Worker also re-writes `appFees` server-side, so a
visitor cannot strip your fee from devtools.

## Compliance

Collecting a fee on a non-custodial swap sits in a US money-transmission grey area; the answer
turns on custody, audience and how the fee is taken. This is an engineering artifact, not legal
advice. Get a read before promoting it at volume, and reconcile accrued fees against the
[NEAR Intents explorer](https://explorer.near-intents.org/) rather than the dashboard estimate.
