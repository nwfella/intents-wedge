/**
 * wedge-core — one engine, three products.
 *
 *   mode: "fixed"    a niche route: fixed or selectable origin, curated destination set
 *   mode: "bridge"   any token → any token across all 39 chains the provider supports
 *
 * Deliberately has NO client-side minimum. Provider caps are per-route and
 * described as "temporary", so the UI submits whatever the user asks for and
 * surfaces the provider's own message when a corridor is capped.
 */
(function () {
  "use strict";

  const API = "https://1click.chaindefuser.com";

  const CHAIN_LABEL = {
    eth: "Ethereum", base: "Base", arb: "Arbitrum", op: "Optimism", pol: "Polygon",
    bsc: "BNB Chain", avax: "Avalanche", gnosis: "Gnosis", scroll: "Scroll",
    xlayer: "X Layer", monad: "Monad", plasma: "Plasma", bera: "Berachain",
    sol: "Solana", near: "NEAR", tron: "Tron", ton: "TON", stellar: "Stellar",
    sui: "Sui", aptos: "Aptos", movement: "Movement", starknet: "Starknet",
    btc: "Bitcoin", zec: "Zcash", ltc: "Litecoin", bch: "Bitcoin Cash",
    doge: "Dogecoin", dash: "Dash", xrp: "XRP Ledger", cardano: "Cardano",
    aleo: "Aleo", miden: "Miden", hypercore: "HyperCore", hood: "Robinhood",
    qtc: "QTC", prl: "Pearl", abs: "Abstract", fogo: "Fogo", adi: "ADI",
  };
  const CHAIN_ORDER = ["eth", "base", "arb", "bsc", "sol", "pol", "op", "near", "tron", "btc", "zec"];

  // Empirically measured 2026-11-06: these origins refuse sub-~$1–2k quotes.
  const CAPPED_ORIGINS = new Set(["bsc", "tron"]);

  const EVM = new Set(["eth", "base", "arb", "op", "pol", "bsc", "avax", "gnosis", "scroll",
    "xlayer", "monad", "plasma", "bera", "hood", "hypercore", "qtc", "prl", "abs", "fogo", "adi"]);
  const FELT = new Set(["sui", "aptos", "miden", "movement", "starknet"]);

  const DEFAULTS = {
    mode: "fixed",
    id: "route",
    brand: "", headline: "", sub: "",
    referral: "wedge",
    feeBps: 20,
    recipient: "",
    apiKey: "",
    proxyUrl: "",
    allowOriginSelect: false,
    origins: [],
    assets: ["USDC"],
    destinations: [],
    defaultFrom: null,
    defaultTo: null,
    minHint: "",
    disclosure: ""
  };
  const CFG = Object.assign({}, DEFAULTS, window.WEDGE_CONFIG || {});
  const BRIDGE = CFG.mode === "bridge";
  const chainName = (c) => CHAIN_LABEL[c] || c;

  let TOKENS = null;
  let polling = null;
  let current = null;

  const $ = (id) => document.getElementById(id);
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };

  /* ── formatting / validation ──────────────────────────────── */
  function toBaseUnits(v, dec) {
    const s = String(v).trim();
    if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
    const [i = "0", f = ""] = s.split(".");
    return BigInt(i || "0") * (10n ** BigInt(dec)) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0");
  }
  const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

  /**
   * Strict where we are confident, lenient where we are not. A false rejection
   * blocks a legitimate user, which is worse than letting the provider's own
   * validation answer — so unknown families only get a length sanity check.
   */
  function addrCheck(chain, a) {
    a = (a || "").trim();
    if (!a) return { ok: false, hint: "Required." };
    if (EVM.has(chain)) return { ok: /^0x[a-fA-F0-9]{40}$/.test(a), hint: "0x + 40 hex characters" };
    if (FELT.has(chain)) return { ok: /^0x[a-fA-F0-9]{20,64}$/.test(a), hint: "0x + up to 64 hex characters" };
    if (chain === "sol") return { ok: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a), hint: "base58, 32–44 chars" };
    if (chain === "zec") return {
      ok: /^(t1|t3)[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) || /^(u|zs)1[a-z0-9]{40,}$/i.test(a),
      hint: "t1… / t3… (transparent) or u1… / zs1… (shielded)"
    };
    if (chain === "tron") return { ok: /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a), hint: "T + 33 base58 chars" };
    if (chain === "xrp") return { ok: /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/.test(a), hint: "r + base58" };
    if (chain === "stellar") return { ok: /^G[A-Z2-7]{55}$/.test(a), hint: "G + 55 base32 chars" };
    if (chain === "ton") return { ok: /^(EQ|UQ|kQ|0Q)[A-Za-z0-9_-]{20,}$/.test(a), hint: "EQ… / UQ… address" };
    if (chain === "near") return { ok: /^([a-z0-9._-]{2,64}\.near|[a-f0-9]{64}|near)$/.test(a), hint: "name.near or 64-hex" };
    if (chain === "cardano") return { ok: /^addr1[a-z0-9]{20,}$/.test(a), hint: "addr1…" };
    if (chain === "btc" || chain === "ltc" || chain === "bch" || chain === "doge" || chain === "dash")
      return { ok: a.length >= 26, hint: "legacy or bech32 address" };
    return { ok: a.length >= 10, hint: "on-chain address" };
  }

  // Format hint for a chain, independent of whether the field is filled.
  const hintOnly = (chain) => addrCheck(chain, "x").hint;

  /* ── shell ────────────────────────────────────────────────── */
  function fixedForm() {
    const originField = CFG.allowOriginSelect ? `
      <div class="field">
        <label for="origin">From</label>
        <select id="origin"></select>
      </div>` : `
      <div class="field">
        <label>From</label>
        <div class="box" style="margin:0;padding:12px 13px">
          <span style="font-size:13.5px" id="originFixed"></span>
        </div>
      </div>`;

    return `
      ${originField}
      <div class="field">
        <label for="amount">You send</label>
        <div class="amt-line">
          <input id="amount" type="number" inputmode="decimal" min="0" step="any" placeholder="100" value="100">
          <select id="asset" style="width:132px" aria-label="Asset"></select>
        </div>
        <div class="hint" id="amtHint"></div>
      </div>
      <div class="field">
        <label for="destChain">Receive on</label>
        <select id="destChain"></select>
      </div>`;
  }

  function bridgeForm() {
    return `
      <div class="field">
        <label for="fromToken">From</label>
        <select id="fromToken"></select>
      </div>
      <div class="field">
        <label for="amount">Amount</label>
        <input id="amount" type="number" inputmode="decimal" min="0" step="any" placeholder="100" value="100">
        <div class="hint" id="amtHint"></div>
      </div>
      <div class="field">
        <label for="toToken">To</label>
        <select id="toToken"></select>
      </div>`;
  }

  function shell() {
    return `
      <div class="wrap">
        <header>
          <div class="brand"><span class="dot"></span><span id="brand"></span></div>
          <h1 id="headline"></h1>
          <p class="sub" id="sub"></p>
        </header>

        <div class="card">
          ${BRIDGE ? bridgeForm() : fixedForm()}

          <div class="field">
            <label for="recipient">Destination address</label>
            <input id="recipient" type="text" spellcheck="false" autocomplete="off">
            <div class="hint" id="addrHint"></div>
          </div>

          <div class="field">
            <label for="refund">Refund address <span class="opt" id="refundHint"></span></label>
            <input id="refund" type="text" spellcheck="false" autocomplete="off">
            <div class="hint" id="refundNote">Where funds return if the swap can't complete.</div>
          </div>

          <button id="go">Get quote</button>
          <div id="err" class="errbox hidden"></div>

          <div class="quote" id="quote">
            <div class="big">
              <div><div class="k">You receive</div><div class="v" id="outAmt">—</div></div>
              <div style="text-align:right"><div class="k">All-in cost</div><div class="v" id="costPct">—</div></div>
            </div>
            <div class="kv"><span class="k">Rate</span><span class="v" id="rate">—</span></div>
            <div class="kv"><span class="k">Service fee</span><span class="v" id="feeLine">—</span></div>
            <div class="kv"><span class="k">Total cost</span><span class="v" id="costUsd">—</span></div>
            <div class="kv"><span class="k">Est. time</span><span class="v" id="eta">—</span></div>
            <div class="kv"><span class="k">Quote expires</span><span class="v" id="expiry">—</span></div>
            <div id="ref" class="ref hidden"></div>

            <div class="box">
              <div class="k" style="font-size:12px;color:var(--mute);text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px">Deposit address</div>
              <div class="addr" id="depAddr">—</div>
              <button class="ghost copy" id="copyBtn">Copy address</button>
            </div>

            <ol class="steps">
              <li>Send <strong id="sendAmt">—</strong> <span id="sendAsset"></span> to the address above, in one transaction.</li>
              <li>Keep this page open — status updates automatically.</li>
              <li>Funds arrive on <span id="destName"></span>. Sending a different amount triggers a refund.</li>
            </ol>

            <div class="status" id="status" style="display:none">
              <div class="spin" id="spin"></div>
              <span id="statusText">Waiting for deposit…</span>
              <span class="pill" id="statusPill"></span>
            </div>
          </div>
        </div>

        <footer>
          <p>Non-custodial. Funds move through NEAR Intents to a quote-specific deposit address; this page never holds them. Quotes expire — re-quote if the deadline passes.</p>
          <p id="feeDisc"></p>
        </footer>
      </div>`;
  }

  /* ── boot ─────────────────────────────────────────────────── */
  async function boot() {
    document.getElementById("app").innerHTML = shell();

    $("brand").textContent = CFG.brand;
    $("headline").textContent = CFG.headline;
    $("sub").textContent = CFG.sub;
    $("amtHint").textContent = CFG.minHint || "";
    if (window.REF_PX) REF_PX.setProxy(CFG.proxyUrl);
    $("feeDisc").textContent = CFG.disclosure ||
      `A ${(CFG.feeBps / 100).toFixed(2)}% service fee supports this page and is included in the all-in cost shown above.`;

    $("copyBtn").addEventListener("click", () => {
      const a = $("depAddr").textContent;
      if (a && a !== "—") navigator.clipboard.writeText(a).then(() => {
        $("copyBtn").textContent = "Copied";
        setTimeout(() => $("copyBtn").textContent = "Copy address", 1400);
      });
    });
    $("go").addEventListener("click", getQuote);
    $("amount").addEventListener("keydown", e => { if (e.key === "Enter") getQuote(); });
    $("amount").addEventListener("input", () => { if (current) resetQuote(); });

    try {
      TOKENS = await (await fetch(`${API}/v0/tokens`)).json();
    } catch (e) {
      TOKENS = [];
    }

    if (BRIDGE) bootBridge(); else bootFixed();
  }

  function orderedChains() {
    const present = [...new Set((TOKENS || []).map(t => t.blockchain))];
    const head = CHAIN_ORDER.filter(c => present.includes(c));
    const tail = present.filter(c => !head.includes(c)).sort((a, b) => chainName(a).localeCompare(chainName(b)));
    return head.concat(tail);
  }

  function fillTokenSelect(sel, selectedAssetId) {
    sel.innerHTML = "";
    orderedChains().forEach(chain => {
      const group = el("optgroup");
      group.label = chainName(chain);
      (TOKENS || [])
        .filter(t => t.blockchain === chain)
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .forEach(t => {
          const o = el("option");
          o.value = t.assetId;
          o.textContent = `${t.symbol} · ${chainName(t.blockchain)}`;
          group.appendChild(o);
        });
      if (group.children.length) sel.appendChild(group);
    });
    if (selectedAssetId && [...sel.options].some(o => o.value === selectedAssetId)) sel.value = selectedAssetId;
  }

  function tokenByAssetId(id) {
    return (TOKENS || []).find(t => t.assetId === id) || null;
  }

  function bootBridge() {
    const first = CFG.defaultFrom || "USDC";
    const to = CFG.defaultTo || "ZEC";
    const findId = (sym, chain) => {
      const t = (TOKENS || []).find(x => x.symbol === sym && x.blockchain === chain);
      return t ? t.assetId : null;
    };
    fillTokenSelect($("fromToken"), findId(first, CFG.defaultFromChain || "base"));
    fillTokenSelect($("toToken"), findId(to, CFG.defaultToChain || "zec"));

    const sync = () => {
      const o = tokenByAssetId($("fromToken").value);
      const d = tokenByAssetId($("toToken").value);
      if (d) {
        $("recipient").placeholder = d.blockchain === "zec" ? "t1… / u1…" : (EVM.has(d.blockchain) ? "0x…" : "");
        $("addrHint").textContent = `Sending to ${chainName(d.blockchain)} — ${hintOnly(d.blockchain)}`;
      }
      if (o) {
        $("refundHint").textContent = `(on ${chainName(o.blockchain)})`;
        $("refund").placeholder = EVM.has(o.blockchain) ? "0x…" : "";
        $("refundNote").textContent = o.blockchain === "bsc" || o.blockchain === "tron"
          ? `Refund address on ${chainName(o.blockchain)}. Heads up: this origin is capped at roughly $1–2k by the routing layer.`
          : `Where funds return if the swap can't complete — must be on ${chainName(o.blockchain)}.`;
      }
      if (current) resetQuote();
    };
    $("fromToken").addEventListener("change", sync);
    $("toToken").addEventListener("change", sync);
    sync();
  }

  function bootFixed() {
    if (CFG.allowOriginSelect) {
      const os = $("origin");
      CFG.origins.forEach(o => {
        const opt = el("option"); opt.value = o.blockchain; opt.textContent = o.label; os.appendChild(opt);
      });
      os.value = CFG.origins[0].blockchain;
      os.addEventListener("change", () => { rebuildFixedAssets(); rebuildFixedDests(); resetQuote(); });
    } else {
      $("originFixed").textContent = `${CFG.assets[0]} on ${chainName(CFG.origins[0].blockchain)}`;
    }
    $("refundHint").textContent = CFG.allowOriginSelect ? "" : `(on ${chainName(CFG.origins[0].blockchain)})`;
    $("destChain").addEventListener("change", () => { syncFixedAddr(); if (current) resetQuote(); });

    rebuildFixedAssets();
    rebuildFixedDests();
    syncFixedAddr();
  }

  const fixedOriginChain = () => CFG.allowOriginSelect ? $("origin").value : CFG.origins[0].blockchain;

  function rebuildFixedAssets() {
    const chain = fixedOriginChain();
    const sel = $("asset");
    sel.innerHTML = "";
    const avail = CFG.assets.filter(sym => assetFor(sym, chain));
    (avail.length ? avail : CFG.assets).forEach(sym => {
      const o = el("option"); o.value = sym; o.textContent = sym; sel.appendChild(o);
    });
  }

  function rebuildFixedDests() {
    const from = fixedOriginChain();
    const sel = $("destChain");
    const prev = sel.value;
    sel.innerHTML = "";
    CFG.destinations
      .filter(d => d.blockchain !== from)
      .forEach(d => {
        const o = el("option"); o.value = d.blockchain; o.textContent = d.label; sel.appendChild(o);
      });
    if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  }

  function syncFixedAddr() {
    const c = $("destChain").value;
    const chk = addrCheck(c, "");
    $("recipient").placeholder = EVM.has(c) ? "0x…" : "";
    $("addrHint").textContent = `${chainName(c)} — ${chk.hint}`;
  }

  function assetFor(symbol, blockchain) {
    if (!TOKENS) return null;
    return TOKENS.find(t => t.symbol === symbol && t.blockchain === blockchain) || null;
  }

  function resetQuote() {
    if (polling) { clearInterval(polling); polling = null; }
    current = null;
    $("quote").classList.remove("on");
    $("status").style.display = "none";
    const rf = $("ref"); if (rf) { rf.innerHTML = ""; rf.classList.add("hidden"); }
    $("err").classList.add("hidden");
  }

  function showErr(msg) {
    const e = $("err");
    e.textContent = msg;
    e.classList.remove("hidden");
  }

  /* ── quote ────────────────────────────────────────────────── */
  async function getQuote() {
    resetQuote();
    const amountHuman = $("amount").value;
    const recipient = $("recipient").value.trim();
    const refund = $("refund").value.trim();

    let origin, dest;
    if (BRIDGE) {
      origin = tokenByAssetId($("fromToken").value);
      dest = tokenByAssetId($("toToken").value);
    } else {
      const from = fixedOriginChain();
      const symbol = $("asset").value;
      origin = assetFor(symbol, from);
      dest = assetFor(symbol, $("destChain").value);
    }

    if (!origin) return showErr("Pick an asset to send.");
    if (!dest) return showErr("Pick an asset to receive.");
    if (origin.assetId === dest.assetId) return showErr("Pick two different assets.");
    if (!amountHuman || Number(amountHuman) <= 0) return showErr("Enter an amount to send.");

    const dc = addrCheck(dest.blockchain, recipient);
    if (!dc.ok) return showErr(`That doesn't look like a valid ${chainName(dest.blockchain)} address (${dc.hint}).`);
    const rc = addrCheck(origin.blockchain, refund || recipient);
    if (!rc.ok) return showErr(`Refund address must be on ${chainName(origin.blockchain)} (${rc.hint}).`);

    const btn = $("go");
    btn.disabled = true; btn.textContent = "Getting quote…";

    try {
      if (!TOKENS || !TOKENS.length) throw new Error("Still loading the asset list — try again in a moment.");

      const amount = toBaseUnits(amountHuman, origin.decimals);
      if (amount === null) throw new Error("Invalid amount.");

      const deadline = new Date(Date.now() + 30 * 60 * 1000).toISOString().replace(".000Z", "Z");
      const body = {
        dry: false,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: origin.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: dest.assetId,
        amount: amount.toString(),
        refundTo: refund || recipient,
        refundType: "ORIGIN_CHAIN",
        recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline,
        referral: CFG.referral,
        quoteWaitingTimeMs: 4000
      };
      if (CFG.feeBps > 0 && CFG.recipient) body.appFees = [{ recipient: CFG.recipient, fee: CFG.feeBps }];

      const url = CFG.proxyUrl ? `${CFG.proxyUrl}/quote` : `${API}/v0/quote`;
      const headers = { "Content-Type": "application/json" };
      if (CFG.apiKey && !CFG.proxyUrl) headers["X-API-Key"] = CFG.apiKey;

      const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(friendly(j.message, r.status));

      renderQuote(j, origin, dest, deadline);
      if (j.quote && j.quote.depositAddress) {
        current = {
          depositAddress: j.quote.depositAddress,
          depositMemo: j.quote.depositMemo || null,
          origin, dest, amountHuman
        };
        startPolling();
      }
    } catch (e) {
      showErr(e.message || "Something went wrong.");
    } finally {
      btn.disabled = false; btn.textContent = "Get quote";
    }
  }

  function friendly(msg, status) {
    if (!msg) return `Quote failed (${status}).`;
    const capped = /minimum|max(imum)?|limit|temporary/i.test(msg);
    if (capped) {
      const m = msg.match(/\$([\d,]+)/);
      const floor = m ? ` ($${m[1]})` : "";
      return `This corridor is temporarily capped by the routing layer${floor}. ` +
             `Try a larger amount, or pick an origin on Ethereum, Base, Arbitrum, Optimism, Polygon, Avalanche or Scroll — those have no minimum. ` +
             `[${msg}]`;
    }
    if (/not available|no route/i.test(msg)) {
      return `No route for this pair right now. Not every token combination has a solver — try a different destination or a more common asset. [${msg}]`;
    }
    return msg;
  }

  function renderQuote(j, origin, dest, deadline) {
    const q = j.quote || {}, req = j.quoteRequest || {};
    const inF = Number(q.amountInFormatted ?? req.amountInFormatted ?? 0);
    const outF = Number(q.amountOutFormatted ?? 0);
    const inUsd = Number(q.amountInUsd || 0);
    const outUsd = Number(q.amountOutUsd || 0);

    $("outAmt").textContent = `${fmt(outF, outF < 100 ? 6 : 2)} ${dest.symbol}`;
    const cost = inUsd > 0 && outUsd > 0 ? ((inUsd - outUsd) / inUsd) * 100 : null;
    $("costPct").textContent = cost !== null ? `${cost.toFixed(2)}%` : "—";
    $("rate").textContent = inF > 0 ? `1 ${origin.symbol} = ${(outF / inF).toFixed(6)} ${dest.symbol}` : "—";

    const feeUsd = inUsd > 0 && outUsd > 0 ? inUsd - outUsd : null;
    $("feeLine").textContent = `${(CFG.feeBps / 100).toFixed(2)}%`;
    $("costUsd").textContent = feeUsd !== null
      ? `$${fmt(feeUsd)} of $${fmt(inUsd)}` + (cost !== null && cost > 0.35 && cost < 20 ? " · routing spread" : "")
      : "—";
    $("eta").textContent = q.timeEstimate ? `~${q.timeEstimate}s` : "~40s";
    $("expiry").textContent = new Date(deadline).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    $("depAddr").textContent = q.depositAddress || "—";
    $("sendAmt").textContent = fmt(inF, inF < 100 ? 6 : 2);
    $("sendAsset").textContent = `${origin.symbol} on ${chainName(origin.blockchain)}`;
    $("destName").textContent = chainName(dest.blockchain);

    $("quote").classList.add("on");
    $("err").classList.add("hidden");
    $("quote").scrollIntoView({ behavior: "smooth", block: "nearest" });

    if (inF > 0 && outF > 0) renderRef(origin, dest, outF / inF);
  }

  /* ── RFQ comparison strip ─────────────────────────────────── */
  let refSeq = 0;

  async function renderRef(origin, dest, ourRate) {
    const box = $("ref");
    if (!box) return;
    if (!window.REF_PX) { box.classList.add("hidden"); return; }

    const seq = ++refSeq;
    box.classList.remove("hidden");
    box.innerHTML = '<div class="refnote">Checking US exchange mid prices…</div>';

    let res;
    try {
      res = await REF_PX.compare(origin.symbol, dest.symbol, ourRate);
    } catch (_) {
      box.innerHTML = '<div class="refnote">Could not reach the US venues — comparison unavailable.</div>';
      return;
    }
    if (seq !== refSeq) return;

    if (!res.available) {
      box.innerHTML = `<div class="refnote">No US venue lists both ${esc(origin.symbol)} and ${esc(dest.symbol)} — nothing to price this against.</div>`;
      return;
    }

    const b = res.best;
    const over = b.deltaBps < 0;
    const head = over
      ? `You pay <strong>${Math.abs(b.deltaBps).toFixed(0)} bps</strong> over ${esc(b.name)}'s mid`
      : `Your rate beats ${esc(b.name)}'s mid by <strong>${b.deltaBps.toFixed(0)} bps</strong>`;

    const chips = res.rows.map(r => {
      if (!r.ok) return `<div class="chip off"><span class="cn">${esc(r.name)}</span><span class="cv">${esc(r.reason)}</span></div>`;
      const d = r.deltaBps;
      const cls = r === b ? "chip best" : "chip";
      const sign = d > 0 ? "+" : "";
      return `<div class="${cls}" title="1 ${esc(origin.symbol)} = ${r.refRate.toFixed(6)} ${esc(dest.symbol)} at mid">` +
             `<span class="cn">${esc(r.name)}</span>` +
             `<span class="cv ${d >= 0 ? "pos" : "neg"}">${sign}${d.toFixed(0)} bps</span></div>`;
    }).join("");

    box.innerHTML = `
      <div class="refhead">${head}</div>
      <div class="refchips">${chips}</div>
      <div class="refnote">Mid prices sampled now from ${res.available} reachable US venue${res.available === 1 ? "" : "s"}. Green = you beat that venue's mid, amber = you pay over it. On a volatile asset the mid moves, so read the delta alongside the all-in cost above.</div>`;
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ── status ───────────────────────────────────────────────── */
  const STATUS_COPY = {
    PENDING_DEPOSIT: ["Waiting for deposit…", ""],
    KNOWN_DEPOSIT_TX: ["Deposit seen — confirming…", ""],
    PROCESSING: ["Routing across chains…", ""],
    SUCCESS: ["Complete", "ok"],
    REFUNDED: ["Refunded", "bad"],
    FAILED: ["Failed — check refund", "bad"],
    INCOMPLETE_DEPOSIT: ["Deposit under the quoted amount", "bad"]
  };

  function startPolling() {
    $("status").style.display = "flex";
    $("spin").style.display = "block";
    setStatus("PENDING_DEPOSIT");
    let ticks = 0;

    const tick = async () => {
      if (!current) return;
      try {
        let d;
        if (CFG.proxyUrl) {
          d = await (await fetch(`${CFG.proxyUrl}/status?depositAddress=${encodeURIComponent(current.depositAddress)}`)).json();
        } else {
          const u = new URL(`${API}/v0/status`);
          u.searchParams.set("depositAddress", current.depositAddress);
          if (current.depositMemo) u.searchParams.set("depositMemo", current.depositMemo);
          d = await (await fetch(u)).json();
        }
        setStatus(d.status);
        if (d.status === "SUCCESS") {
          clearInterval(polling); polling = null;
          $("spin").style.display = "none";
          logSuccess(d);
        }
        if (["REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"].includes(d.status)) {
          clearInterval(polling); polling = null;
          $("spin").style.display = "none";
        }
      } catch (_) { /* transient */ }
      if (++ticks > 450) { clearInterval(polling); polling = null; }
    };
    polling = setInterval(tick, 8000);
    setTimeout(tick, 2500);
  }

  function setStatus(code) {
    const [text, cls] = STATUS_COPY[code] || [code, ""];
    $("statusText").textContent = text;
    const p = $("statusPill");
    p.textContent = code; p.className = "pill " + cls;
  }

  /* ── logging ──────────────────────────────────────────────── */
  function logSuccess(d) {
    try {
      const KEY = "wedge_swaps_v1";
      const rows = JSON.parse(localStorage.getItem(KEY) || "[]");
      if (rows.some(r => r.depositAddress === current.depositAddress)) return;
      const s = d.swapDetails || {};
      rows.push({
        ts: Date.now(),
        depositAddress: current.depositAddress,
        route: CFG.id,
        amountIn: s.amountInFormatted || current.amountHuman,
        amountInUsd: s.amountInUsd || null,
        amountOut: s.amountOutFormatted || null,
        asset: `${current.origin.symbol} ${current.origin.blockchain}→${current.dest.symbol} ${current.dest.blockchain}`,
        feeBps: CFG.feeBps,
        ourBps: Math.round(CFG.feeBps / 2),
        status: "SUCCESS"
      });
      localStorage.setItem(KEY, JSON.stringify(rows.slice(-2000)));
    } catch (_) { /* private mode */ }
  }

  boot();
})();
