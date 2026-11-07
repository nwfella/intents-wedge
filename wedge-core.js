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
    const search = (id) =>
      `<input id="${id}" type="search" class="search" placeholder="Search by name or symbol — zcash, usd coin, bitcoin" autocomplete="off">`;
    return `
      <div class="field">
        <label>From</label>
        <div class="pickrow">
          <select id="fromChain" aria-label="Origin chain"></select>
          <select id="fromToken" aria-label="Origin token"></select>
        </div>
        ${search("fromSearch")}
      </div>
      <div class="field">
        <label for="amount">Amount</label>
        <input id="amount" type="number" inputmode="decimal" min="0" step="any" placeholder="100" value="100">
        <div class="hint" id="amtHint"></div>
      </div>
      <div class="field">
        <label>To</label>
        <div class="pickrow">
          <select id="toChain" aria-label="Destination chain"></select>
          <select id="toToken" aria-label="Destination token"></select>
        </div>
        ${search("toSearch")}
      </div>`;
  }

  function shell() {
    return `
      <div class="wrap">
        <header>
          <div class="brand"><span class="dot"></span><span id="brand"></span></div>
          <h1 id="headline"></h1>
          <p class="sub" id="sub"></p>
          <div class="statbar" id="statbar" hidden><span class="statdot"></span><span id="statText"></span></div>
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
    loadStats();
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

  // The provider ships no display name — only a CoinGecko slug — so derive one.
  // Searching matches symbol, derived name and slug, which is what people type.
  const NAMES = {
    USDC: "USD Coin", USDT: "Tether", BTC: "Bitcoin", ETH: "Ether", ZEC: "Zcash",
    SOL: "Solana", BNB: "BNB", AVAX: "Avalanche", POL: "Polygon", ARB: "Arbitrum",
    OP: "Optimism", NEAR: "NEAR", SUI: "Sui", APT: "Aptos", DOGE: "Dogecoin",
    XRP: "XRP", ADA: "Cardano", LTC: "Litecoin", BCH: "Bitcoin Cash", DASH: "Dash",
    XLM: "Stellar", TON: "Toncoin", TRX: "TRON", ATOM: "Cosmos", LINK: "Chainlink",
    UNI: "Uniswap", AAVE: "Aave", DAI: "Dai", WBTC: "Wrapped Bitcoin"
  };
  function displayName(t) {
    if (NAMES[t.symbol]) return NAMES[t.symbol];
    const slug = t.coingeckoId || "";
    if (!slug) return t.symbol;
    return slug.split("-").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  }
  function matchToken(t, q) {
    if (!q) return true;
    const hay = `${t.symbol} ${displayName(t)} ${t.coingeckoId || ""}`.toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(part => hay.includes(part));
  }

  function fillChainSelect(sel, def) {
    const chains = orderedChains();
    sel.innerHTML = "";
    chains.forEach(c => { const o = el("option"); o.value = c; o.textContent = chainName(c); sel.appendChild(o); });
    if (def && chains.includes(def)) sel.value = def;
  }

  function fillTokenSelect(sel, chain, wantSymbol, query) {
    const prev = sel.value;
    const list = (TOKENS || [])
      .filter(t => t.blockchain === chain && matchToken(t, query))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));
    sel.innerHTML = "";
    list.forEach(t => {
      const o = el("option");
      o.value = t.assetId;
      o.textContent = `${t.symbol} · ${displayName(t)}`;
      sel.appendChild(o);
    });
    const want = wantSymbol ? list.find(t => t.symbol === wantSymbol) : null;
    if (want) sel.value = want.assetId;
    else if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
    return list.length;
  }

  function tokenByAssetId(id) {
    return (TOKENS || []).find(t => t.assetId === id) || null;
  }

  function bootBridge() {
    fillChainSelect($("fromChain"), CFG.defaultFromChain || "base");
    fillChainSelect($("toChain"), CFG.defaultToChain || "zec");

    const refill = (side, wantSymbol) =>
      fillTokenSelect($(side + "Token"), $(side + "Chain").value, wantSymbol, $(side + "Search").value.trim());

    refill("from", CFG.defaultFrom || "USDC");
    refill("to", CFG.defaultTo || "ZEC");

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
    // chain first: changing a chain rebuilds that side's token list
    ["from", "to"].forEach(side => {
      $(side + "Chain").addEventListener("change", () => { refill(side); sync(); });
      $(side + "Token").addEventListener("change", sync);
      $(side + "Search").addEventListener("input", () => { refill(side); sync(); });
    });
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

  }

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
          postStat().then(loadStats);
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

  /* ── bridged totals ───────────────────────────────────────── */
  // localStorage only ever sees this browser's swaps. The site-wide figure
  // comes from the Worker; without it we say "you" rather than "we", because
  // claiming a site total we cannot see would be a fabrication.
  function localTotals() {
    try {
      const rows = JSON.parse(localStorage.getItem("wedge_swaps_v1") || "[]").filter(r => r.status === "SUCCESS");
      return { usd: rows.reduce((s, r) => s + (Number(r.amountInUsd) || 0), 0), count: rows.length };
    } catch (_) { return { usd: 0, count: 0 }; }
  }

  async function loadStats() {
    const box = $("statbar"); if (!box) return;

    if (CFG.proxyUrl) {
      try {
        const d = await (await fetch(`${CFG.proxyUrl}/stat`)).json();
        if (d && d.configured !== false && Number.isFinite(Number(d.usd))) {
          const n = Number(d.count) || 0;
          box.hidden = false;
          $("statText").innerHTML = `<strong>$${fmt(Number(d.usd), 0)}</strong> bridged across <strong>${n}</strong> swap${n === 1 ? "" : "s"}`;
          return;
        }
      } catch (_) { /* fall back to the local log */ }
    }

    const t = localTotals();
    if (t.count > 0) {
      box.hidden = false;
      $("statText").innerHTML = `You've moved <strong>$${fmt(t.usd, 0)}</strong> through this page in ${t.count} swap${t.count === 1 ? "" : "s"}`;
    }
  }

  async function postStat() {
    if (!CFG.proxyUrl || !current) return;
    try {
      await fetch(`${CFG.proxyUrl}/stat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ depositAddress: current.depositAddress }),
      });
    } catch (_) { /* non-fatal: the swap itself already succeeded */ }
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
