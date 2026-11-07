#!/usr/bin/env node
/**
 * Headless UI gate for both routes. Launches its own Chrome with a throwaway
 * profile (never touches the user's browser) and drives it over CDP.
 *
 * The load-bearing assertion is on route B: a $10 ticket must produce a quote.
 * If a client-side minimum ever creeps back into the engine, that goes red.
 *
 *   node scripts/uicheck.js
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PORT = 9224;
const BASE = process.env.BASE_URL || "http://127.0.0.1:8931";
const OUT = path.join(__dirname, "..", "screens");
const PROFILE = path.join(os.tmpdir(), "wedge-uicheck-" + Date.now());
const ADDR = "0x94f080a1BF54d73d565AF55afDC622bABD62CE77";

let pass = 0, fail = 0;
const ok = m => { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${m}`); };
const bad = m => { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
const check = (c, m) => c ? ok(m) : bad(m);
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const chrome = spawn(CHROME, [
    "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
    "--no-first-run", "--no-default-browser-check", "--disable-gpu",
    "--hide-scrollbars", "--window-size=1280,900", "about:blank",
  ], { stdio: "ignore" });

  let ver = null;
  for (let i = 0; i < 40; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
    catch { await sleep(250); }
  }
  if (!ver) { bad("chrome did not expose CDP"); chrome.kill(); process.exit(1); }

  const target = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise(res => {
    const mid = ++id; pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const goto = async (url) => { await send("Page.navigate", { url }); await sleep(1400); };
  const shot = async (name) => {
    const r = await send("Page.captureScreenshot", { format: "png" });
    const f = path.join(OUT, name);
    fs.writeFileSync(f, Buffer.from(r.result.data, "base64"));
    return f;
  };
  const waitQuote = async (ms = 20000) => {
    for (let i = 0; i < ms / 500; i++) {
      await sleep(500);
      if (await evaluate("document.getElementById('quote').classList.contains('on')")) return true;
      if (await evaluate("!document.getElementById('err').classList.contains('hidden')")) return false;
    }
    return false;
  };

  await send("Page.enable");
  await send("Runtime.enable");

  /* ─────────── route A: capped corridor ─────────── */
  console.log("\n── route A · boot ────────────────────────────────");
  await goto(`${BASE}/index.html`);
  await sleep(2400);
  check((await evaluate("document.title")).includes("BNB"), "title set");
  check(await evaluate("document.querySelectorAll('#destChain option').length") === 4,
        `4 destinations offered (no Solana — that corridor is capped)`);
  check(await evaluate("!document.getElementById('origin')"), "origin is fixed, not a selector");
  check(await evaluate("!!document.getElementById('originFixed')"), "fixed origin is labelled");

  console.log("\n── route A · no hardcoded minimum ────────────────");
  await evaluate(`
    document.getElementById('amount').value='50';
    document.getElementById('recipient').value='${ADDR}';
    document.getElementById('refund').value='${ADDR}';
    document.getElementById('go').click();
  `);
  await sleep(4500);
  const capMsg = await evaluate("document.getElementById('err').textContent || ''");
  check(/capped/i.test(capMsg) && /minimum/i.test(capMsg),
        "a $50 ticket is submitted, then explained (not blocked client-side)");
  check(/base|arb|eth|pol|corridor/i.test(capMsg), "the error points at an uncapped alternative");

  console.log("\n── route A · live quote ──────────────────────────");
  await evaluate(`
    document.getElementById('amount').value='5000';
    document.getElementById('go').click();
  `);
  const aShown = await waitQuote(30000);
  check(aShown, "quote rendered for $5,000");
  if (aShown) {
    const out = await evaluate("document.getElementById('outAmt').textContent");
    const dep = await evaluate("document.getElementById('depAddr').textContent");
    const expiry = await evaluate("document.getElementById('expiry').textContent");
    check(/USDC/.test(out) && parseFloat(out.replace(/,/g, "")) > 4900, `receive amount: ${out}`);
    check(/^0x[a-fA-F0-9]{40}$/.test(dep), `deposit address: ${dep.slice(0, 10)}…`);
    check(/\d/.test(expiry), `expiry shown: ${expiry}`);
  }
  const aShot = await shot("route-a.png");

  /* ─────────── route B: any size ─────────── */
  console.log("\n── route B · boot ────────────────────────────────");
  await goto(`${BASE}/l2.html`);
  await sleep(2400);
  check(await evaluate("!!document.getElementById('origin')"), "origin selector present");
  check(await evaluate("document.querySelectorAll('#origin option').length") === 5, "5 origin chains");
  check(await evaluate("document.querySelectorAll('#destChain option').length") === 4,
        "destination list excludes the selected origin");

  console.log("\n── route B · origin/dest stay in sync ────────────");
  await evaluate(`(() => {
    const o=document.getElementById('origin'); o.value='base'; o.dispatchEvent(new Event('change'));
  })()`);
  await sleep(400);
  const dests = await evaluate("Array.from(document.querySelectorAll('#destChain option')).map(o=>o.value).join(',')");
  check(!dests.split(",").includes("base"), `destinations rebuilt without origin: ${dests}`);
  await evaluate(`(() => {
    const o=document.getElementById('origin'); o.value='eth'; o.dispatchEvent(new Event('change'));
  })()`);
  await sleep(400);

  console.log("\n── route B · a $10 ticket must quote ─────────────");
  await evaluate(`
    document.getElementById('amount').value='10';
    document.getElementById('recipient').value='${ADDR}';
    document.getElementById('refund').value='${ADDR}';
    document.getElementById('go').click();
  `);
  const bShown = await waitQuote(30000);
  const bErr = await evaluate("document.getElementById('err').textContent || ''");
  check(bShown, bShown ? "quote rendered for $10 — no minimum on this corridor" : `$10 rejected: ${bErr}`);
  if (bShown) {
    const out = await evaluate("document.getElementById('outAmt').textContent");
    const cost = await evaluate("document.getElementById('costPct').textContent");
    check(parseFloat(String(out).replace(/,/g, "")) > 9.5, `receive amount for $10: ${out}`);
    check(/^\d+\.\d+%$/.test(cost), `cost scales on small tickets: ${cost}`);
  }
  const bShot = await shot("route-b.png");

  /* ─────────── bridge: any token → any chain ─────────── */
  console.log("\n── bridge · token matrix ─────────────────────────");
  await goto(`${BASE}/bridge.html`);
  await sleep(2600);
  check(await evaluate("!!document.getElementById('fromToken')"), "token picker present");
  const nFrom = await evaluate("document.querySelectorAll('#fromToken option').length");
  check(nFrom > 150, `full asset list loaded (${nFrom} tokens)`);
  const nGroups = await evaluate("document.querySelectorAll('#fromToken optgroup').length");
  check(nGroups > 20, `${nGroups} chains grouped in the picker`);
  check((await evaluate("document.getElementById('toToken').selectedOptions[0].parentElement.label")) === "Zcash",
        "defaults to a native Zcash destination");

  console.log("\n── bridge · USDC/Base → native ZEC ───────────────");
  await evaluate(`(() => {
    document.getElementById('amount').value='100';
    document.getElementById('recipient').value='t1LvAcGd715CLtmKVkprNQKNj6x55ULXuDL';
    document.getElementById('refund').value='${ADDR}';
    document.getElementById('go').click();
  })()`);
  const zShown = await waitQuote(30000);
  const zErr = await evaluate("document.getElementById('err').textContent || ''");
  check(zShown, zShown ? "quotes a non-stablecoin destination across chains" : `ZEC quote failed: ${zErr}`);
  if (zShown) {
    const zOut = await evaluate("document.getElementById('outAmt').textContent");
    const zDep = await evaluate("document.getElementById('depAddr').textContent");
    check(/ZEC/.test(zOut), `receives ${zOut}`);
    check(/^0x[a-fA-F0-9]{40}$/.test(zDep), "deposit address issued on the origin chain");
  }
  console.log("\n── bridge · RFQ comparison strip ─────────────────");
  let refOk = false;
  for (let i = 0; i < 24; i++) {
    await sleep(500);
    refOk = await evaluate("(() => { const r = document.getElementById('ref'); return !!r && !r.classList.contains('hidden') && r.querySelectorAll('.chip:not(.off)').length > 0; })()");
    if (refOk) break;
  }
  const chipTxt = await evaluate("Array.from(document.querySelectorAll('#ref .chip')).map(c => c.textContent.trim()).join(' | ')");
  check(refOk, refOk ? `US venue prices rendered: ${chipTxt}` : "no venue comparison appeared");
  const headTxt = (await evaluate("(document.querySelector('#ref .refhead') || {}).textContent || ''")).trim();
  check(/bps/i.test(headTxt), `headline states the gap to mid: "${headTxt}"`);
  const bestChip = await evaluate("document.querySelectorAll('#ref .chip.best').length");
  check(bestChip === 1, `exactly one venue highlighted as best (${bestChip})`);
  const bridgeShot = await shot("bridge-zec.png");

  console.log("\n── bridge · address validation per chain ─────────");
  await evaluate(`(() => {
    document.getElementById('recipient').value='0xdeadbeef';
    document.getElementById('go').click();
  })()`);
  await sleep(700);
  const badZ = await evaluate("document.getElementById('err').textContent || ''");
  check(/Zcash/i.test(badZ), `EVM address rejected for a ZEC destination: "${badZ.slice(0, 70)}"`);

  console.log("\n── bridge · capped origin is flagged up front ────");
  await evaluate(`(() => {
    const s=document.getElementById('fromToken');
    const o=[...s.options].find(x => x.parentElement.label === 'BNB Chain' && x.textContent.startsWith('USDT'));
    s.value=o.value; s.dispatchEvent(new Event('change'));
  })()`);
  await sleep(500);
  const capNote = await evaluate("document.getElementById('refundNote').textContent");
  check(/capped/i.test(capNote), "BSC origin warns about the cap before the user submits");

  console.log("\n── mobile ────────────────────────────────────────");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  const overflow = await evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
  check(overflow <= 0, `no horizontal overflow at 390px (${overflow}px)`);
  const bMobile = await shot("route-b-mobile.png");
  await send("Emulation.clearDeviceMetricsOverride");

  console.log("\n── dashboard ─────────────────────────────────────");
  await goto(`${BASE}/dashboard.html`);
  await sleep(900);
  check(await evaluate("!!document.getElementById('byRoute')"), "per-route breakdown panel present");
  check(await evaluate("!!document.getElementById('empty')"), "empty state present");
  const dashShot = await shot("dashboard.png");

  console.log("\n── screens ───────────────────────────────────────");
  [aShot, bShot, bMobile, dashShot].forEach(f => console.log("  " + f));

  ws.close(); chrome.kill(); await sleep(400);
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}

  console.log(`\n── result ────────────────────────────────────────`);
  console.log(`  ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { bad(`uicheck crashed: ${e.message}`); process.exit(1); });
