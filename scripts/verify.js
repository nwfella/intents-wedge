#!/usr/bin/env node
/**
 * Verification gate for the intents wedge.
 *
 * The most valuable assertion here is the per-route minimum map. Provider caps
 * are NOT class-wide and they move, so the gate pins both directions:
 *   - a corridor that accepts a $10 ticket still accepts one
 *   - the capped corridor still refuses one
 * If either flips, the product's positioning is wrong and this goes red.
 *
 *   node scripts/verify.js
 */
const fs = require("fs");
const path = require("path");

const API = "https://1click.chaindefuser.com";
const ROOT = path.join(__dirname, "..");
const RECIPIENT = "0x94f080a1BF54d73d565AF55afDC622bABD62CE77";

let pass = 0, fail = 0;
const ok = m => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${m}`); };
const bad = m => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const check = (c, m) => c ? ok(m) : bad(m);
const read = f => fs.readFileSync(path.join(ROOT, f), "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log("\n── files ─────────────────────────────────────────");
  for (const f of ["index.html", "l2.html", "wedge.css", "wedge-core.js", "dashboard.html", "worker.js", "README.md"]) {
    check(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
  }

  const coreHtml = read("index.html");
  const l2Html = read("l2.html");
  const core = read("wedge-core.js");
  const dash = read("dashboard.html");
  const worker = read("worker.js");

  console.log("\n── config ────────────────────────────────────────");
  check(coreHtml.includes(RECIPIENT), "route A pays out to the current fee recipient");
  check(l2Html.includes(RECIPIENT), "route B pays out to the current fee recipient");
  check(!coreHtml.includes("0x1782cea0d026430ad4b410697c2df05a104efa9b"), "old payout address fully removed");
  check(/referral:\s*"hermes-wedge-bsc"/.test(coreHtml) && /referral:\s*"hermes-wedge-l2"/.test(l2Html),
        "routes carry distinct referral ids (separable in the explorer)");
  check(!/minUsd/.test(core), "no hardcoded client-side minimum in the engine");
  check(/function friendly/.test(core) && /temporarily capped/i.test(core),
        "engine translates provider caps into a readable message");
  check(/body\.appFees\s*=\s*\[\{\s*recipient:\s*CFG\.recipient/.test(core), "appFees wired to CFG.recipient");
  check(/wedge_swaps_v1/.test(core) && /wedge_swaps_v1/.test(dash), "dashboard reads the engine's storage key");
  check(/body\.appFees\s*=\s*\[\{\s*recipient:\s*env\.FEE_RECIPIENT/.test(worker), "worker re-writes appFees server-side");

  console.log("\n── assets ────────────────────────────────────────");
  let tokens = [];
  try {
    tokens = await (await fetch(`${API}/v0/tokens`)).json();
    check(Array.isArray(tokens) && tokens.length > 100, `token list: ${tokens.length} assets`);
  } catch (e) { bad(`token list unreachable: ${e.message}`); }

  const asset = (sym, chain) => tokens.find(t => t.symbol === sym && t.blockchain === chain);

  const quote = async (sym, from, to, usd, fee) => {
    const o = asset(sym, from), d = asset(sym, to);
    if (!o || !d) return { status: 0, json: { message: "asset missing" }, cors: null };
    const body = {
      dry: false, swapType: "EXACT_INPUT", slippageTolerance: 100,
      originAsset: o.assetId, depositType: "ORIGIN_CHAIN",
      destinationAsset: d.assetId,
      amount: String(BigInt(Math.round(usd * 1e6)) * (10n ** BigInt(o.decimals - 6))),
      refundTo: RECIPIENT, refundType: "ORIGIN_CHAIN",
      recipient: RECIPIENT, recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      referral: "verify-gate", quoteWaitingTimeMs: 4000,
    };
    if (fee > 0) body.appFees = [{ recipient: RECIPIENT, fee }];
    const r = await fetch(`${API}/v0/quote`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json(), cors: r.headers.get("access-control-allow-origin") };
  };

  check(asset("USDC", "bsc")?.decimals === 18, "USDC on BSC resolves to 18 decimals (not 6)");
  check(asset("USDC", "base")?.decimals === 6, "USDC on Base resolves to 6 decimals");

  console.log("\n── route A: BNB Chain (capped corridor) ──────────");
  const a = await quote("USDC", "bsc", "base", 2000, 20);
  check(a.status === 201, `$2,000 BSC→Base accepted (HTTP ${a.status})`);
  const echoed = a.json.quoteRequest?.appFees || [];
  check(echoed.some(f => f.recipient.toLowerCase() === RECIPIENT.toLowerCase() && f.fee === 10),
        `fee split: ${echoed.map(f => f.fee + "bps").join(" + ") || "none"}`);
  check(!!a.json.quote?.depositAddress, `deposit address issued (${a.json.quote?.depositAddress})`);
  check(a.cors === "*", `CORS still open for static hosting (${a.cors})`);
  const costA = a.json.quote?.amountInUsd && a.json.quote?.amountOutUsd
    ? ((a.json.quote.amountInUsd - a.json.quote.amountOutUsd) / a.json.quote.amountInUsd) * 100 : null;
  check(costA !== null && costA > 0 && costA < 2, `all-in cost sane: ${costA?.toFixed(3)}%`);

  await sleep(1200);
  const aSmall = await quote("USDC", "bsc", "base", 50, 20);
  check(aSmall.status === 400 && /minimum|limit/i.test(JSON.stringify(aSmall.json)),
        `BSC corridor still refuses $50 (HTTP ${aSmall.status}: ${aSmall.json.message?.slice(0, 60)}…)`);

  console.log("\n── route B: EVM corridors (no minimum) ───────────");
  await sleep(1200);
  const bSmall = await quote("USDC", "eth", "base", 10, 20);
  check(bSmall.status === 201, `$10 ETH→Base accepted — no minimum on this corridor (HTTP ${bSmall.status})`);
  if (bSmall.status === 201) {
    const out = Number(bSmall.json.quote.amountOutFormatted);
    const inUsd = Number(bSmall.json.quote.amountInUsd);
    const outUsd = Number(bSmall.json.quote.amountOutUsd);
    check(out > 9.5, `small-ticket output sane: ${out} USDC from $10`);
    const c = ((inUsd - outUsd) / inUsd) * 100;
    check(c > 0 && c < 2, `small-ticket cost sane: ${c.toFixed(3)}% (fee scales, it does not floor)`);
  }
  await sleep(1200);
  const bAlt = await quote("USDC", "base", "arb", 25, 20);
  check(bAlt.status === 201, `$25 Base→Arbitrum accepted (HTTP ${bAlt.status})`);

  console.log("\n── bridge: arbitrary token pairs ─────────────────");
  check(fs.existsSync(path.join(ROOT, "bridge.html")), "bridge.html exists");
  check(/mode:\s*"bridge"/.test(read("bridge.html")), "bridge page runs the engine in bridge mode");
  check(read("bridge.html").includes(RECIPIENT), "bridge pays out to the current fee recipient");
  check(!asset("USDT", "base") && !asset("USDT", "arb"),
        "USDT genuinely absent on Base/Arbitrum — the picker cannot offer it");

  const ZADDR = "t1LvAcGd715CLtmKVkprNQKNj6x55ULXuDL"; // dummy, random-derived; quoting only
  const zec = asset("ZEC", "zec");
  check(!!zec && zec.decimals === 8, `native ZEC resolved (${zec?.assetId}, ${zec?.decimals}dp)`);

  const zQuote = async (sym, chain, usd) => {
    const o = asset(sym, chain);
    if (!o || !zec) return { status: 0, json: { message: "asset missing" } };
    const body = {
      dry: true, swapType: "EXACT_INPUT", slippageTolerance: 100,
      originAsset: o.assetId, depositType: "ORIGIN_CHAIN", destinationAsset: zec.assetId,
      amount: String(BigInt(Math.round(usd * 1e6)) * (10n ** BigInt(o.decimals - 6))),
      refundTo: (chain === "bsc" || chain === "base" || chain === "arb" || chain === "eth") ? RECIPIENT : RECIPIENT,
      refundType: "ORIGIN_CHAIN", recipient: ZADDR, recipientType: "DESTINATION_CHAIN",
      deadline: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      referral: "verify-gate", quoteWaitingTimeMs: 4000,
    };
    body.appFees = [{ recipient: RECIPIENT, fee: 20 }];
    const r = await fetch(`${API}/v0/quote`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() };
  };

  await sleep(1200);
  const zSmall = await zQuote("USDC", "base", 50);
  check(zSmall.status === 201, `USDC/Base → native ZEC at $50 accepted (HTTP ${zSmall.status})`);
  if (zSmall.status === 201) {
    const got = Number(zSmall.json.quote.amountOutFormatted);
    check(got > 0, `ZEC output: ${got} ZEC for $50`);
  }

  await sleep(1200);
  const zBsc = await zQuote("USDT", "bsc", 1500);
  check(zBsc.status === 201, `USDT/BSC → native ZEC at $1,500 accepted (HTTP ${zBsc.status})`);

  await sleep(1200);
  const zBscSmall = await zQuote("USDT", "bsc", 50);
  check(zBscSmall.status === 400, "USDT/BSC below the cap is refused — the cap follows the origin, not the pair");

  console.log("\n── fee actually costs the user ───────────────────");
  await sleep(1200);
  const aZero = await quote("USDC", "bsc", "base", 2000, 0);
  check(aZero.status === 201 && Number(aZero.json.quote.amountOut) > Number(a.json.quote.amountOut),
        "zero-fee quote returns strictly more out");

  console.log("\n── reference venues (RFQ strip) ──────────────────");
  const ua = { "User-Agent": "wedge-gate", Origin: "https://nwfella.github.io" };
  const hdr = async (u) => {
    const r = await fetch(u, { headers: ua });
    return { ok: r.ok, acao: r.headers.get("access-control-allow-origin"), json: await r.json().catch(() => null) };
  };

  const krakenPx = await hdr("https://api.kraken.com/0/public/Ticker?pair=ZECUSD");
  check(!!krakenPx.acao, `Kraken sends CORS (${krakenPx.acao}) — usable from a static page`);
  const kzec = krakenPx.json && Object.values(krakenPx.json.result || {})[0];
  check(!!kzec && Number(kzec.a?.[0]) > 0, `Kraken lists ZEC (ask ${kzec?.a?.[0]})`);

  const binPx = await hdr("https://api.binance.us/api/v3/ticker/price?symbol=ZECUSD");
  check(binPx.acao === "*", `Binance.US sends CORS (${binPx.acao})`);
  check(Number(binPx.json?.price) > 0, `Binance.US lists ZECUSD (${binPx.json?.price})`);

  const cbPx = await hdr("https://api.coinbase.com/v2/prices/ZEC-USD/spot");
  check(cbPx.ok && !!cbPx.acao, `Coinbase sends CORS (${cbPx.acao}) — reachable from a static page`);

  const gemPx = await hdr("https://api.gemini.com/v1/pubticker/zecusd");
  check(gemPx.ok && !!gemPx.acao, `Gemini sends CORS (${gemPx.acao}) and lists ZEC`);

  const bfPx = await hdr("https://api.bitflyer.com/v1/ticker?product_code=BTC_USD");
  check(bfPx.ok && !bfPx.acao, "bitFlyer returns a price but no CORS header — proxy-only, as designed");

  const [, kronly] = [0, krakenPx.json];
  if (kzec && binPx.json?.price) {
    const a = Number(kzec.a[0]), b = Number(binPx.json.price);
    const gapBps = Math.abs(a / b - 1) * 10000;
    check(gapBps < 500, `two US venues agree on ZEC within ${gapBps.toFixed(0)} bps (sanity)`);
  }

  console.log("\n── status ────────────────────────────────────────");
  const st = await fetch(`${API}/v0/status?depositAddress=${a.json.quote.depositAddress}`);
  const sj = await st.json();
  check(st.status === 200 && !!sj.status, `status endpoint reachable (${sj.status})`);

  console.log(`\n── result ────────────────────────────────────────`);
  console.log(`  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { bad(`gate crashed: ${e.message}`); console.log(`\n  ${pass} passed, ${fail} failed\n`); process.exit(1); });
