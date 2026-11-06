/**
 * wedge-core — the whole product, driven by window.WEDGE_CONFIG.
 *
 * Deliberately has NO client-side minimum. Provider caps are per-route and
 * described as "temporary", so the UI submits whatever the user asks for and
 * surfaces the provider's own message when a corridor is capped. Hard-coding a
 * floor turns a transient routing limit into a permanent product limit.
 */
(function () {
  "use strict";

  const API = "https://1click.chaindefuser.com";

  const DEFAULTS = {
    id: "route",
    brand: "",
    headline: "",
    sub: "",
    referral: "wedge",
    feeBps: 20,
    recipient: "",
    apiKey: "",
    proxyUrl: "",
    allowOriginSelect: false,
    origins: [],
    assets: ["USDC"],
    destinations: [],
    minHint: "",
    chainLabel: { bsc: "BNB Chain", eth: "Ethereum", base: "Base", arb: "Arbitrum", op: "Optimism", pol: "Polygon", sol: "Solana" },
    disclosure: ""
  };
  const CFG = Object.assign({}, DEFAULTS, window.WEDGE_CONFIG || {});
  const chainName = (c) => CFG.chainLabel[c] || c;

  let TOKENS = null;
  let polling = null;
  let current = null;

  const $ = (id) => document.getElementById(id);
  const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };

  /* ── formatting ───────────────────────────────────────────── */
  function toBaseUnits(v, dec) {
    const s = String(v).trim();
    if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return null;
    const [i = "0", f = ""] = s.split(".");
    return BigInt(i || "0") * (10n ** BigInt(dec)) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0");
  }
  function fromBaseUnits(v, dec) {
    const s = BigInt(v).toString().padStart(dec + 1, "0");
    const i = s.slice(0, s.length - dec);
    const f = s.slice(s.length - dec).replace(/0+$/, "");
    return f ? `${i}.${f}` : i;
  }
  const fmt = (n, d = 2) => Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  const isEvm = (c) => c !== "sol" && c !== "near" && c !== "btc" && c !== "aptos" && c !== "sui";
  const addrOk = (c, a) => c === "sol" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a) : /^0x[a-fA-F0-9]{40}$/.test(a);
  const addrPlaceholder = (c) => c === "sol" ? "Base58 address" : "0x…";

  /* ── shell ────────────────────────────────────────────────── */
  function shell() {
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
      <div class="wrap">
        <header>
          <div class="brand"><span class="dot"></span><span id="brand"></span></div>
          <h1 id="headline"></h1>
          <p class="sub" id="sub"></p>
        </header>

        <div class="card">
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
          </div>

          <div class="field">
            <label for="recipient">Destination address</label>
            <input id="recipient" type="text" spellcheck="false" autocomplete="off">
            <div class="hint" id="addrHint"></div>
          </div>

          <div class="field">
            <label for="refund">Refund address <span class="opt" id="refundHint"></span></label>
            <input id="refund" type="text" placeholder="0x…" spellcheck="false" autocomplete="off">
            <div class="hint">Where funds return if the swap can't complete.</div>
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
    $("feeDisc").textContent = CFG.disclosure ||
      `A ${(CFG.feeBps / 100).toFixed(2)}% service fee supports this page and is included in the all-in cost shown above.`;

    if (CFG.allowOriginSelect) {
      const os = $("origin");
      CFG.origins.forEach(o => {
        const opt = el("option"); opt.value = o.blockchain; opt.textContent = o.label; os.appendChild(opt);
      });
      os.value = CFG.origins[0].blockchain;
      os.addEventListener("change", () => { rebuildAssets(); rebuildDests(); resetQuote(); });
    } else {
      $("originFixed").textContent = `USDC on ${chainName(CFG.origins[0].blockchain)}`;
    }
    $("refundHint").textContent = CFG.allowOriginSelect ? "" : `(on ${chainName(CFG.origins[0].blockchain)})`;

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
    $("destChain").addEventListener("change", () => { syncAddrUi(); if (current) resetQuote(); });

    try {
      TOKENS = await (await fetch(`${API}/v0/tokens`)).json();
    } catch (e) {
      TOKENS = [];
    }
    rebuildAssets();
    rebuildDests();
    syncAddrUi();
  }

  const originChain = () => CFG.allowOriginSelect ? $("origin").value : CFG.origins[0].blockchain;

  function rebuildAssets() {
    const chain = originChain();
    const sel = $("asset");
    sel.innerHTML = "";
    const avail = CFG.assets.filter(sym => assetFor(sym, chain));
    (avail.length ? avail : CFG.assets).forEach(sym => {
      const o = el("option"); o.value = sym; o.textContent = sym; sel.appendChild(o);
    });
  }

  function rebuildDests() {
    const from = originChain();
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

  function syncAddrUi() {
    const c = $("destChain").value;
    $("recipient").placeholder = addrPlaceholder(c);
    $("addrHint").textContent = isEvm(c) ? "0x + 40 hex characters" : "base58, 32–44 chars";
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
    const symbol = $("asset").value;
    const from = originChain();
    const destChain = $("destChain").value;
    const recipient = $("recipient").value.trim();
    const refund = $("refund").value.trim();

    if (!amountHuman || Number(amountHuman) <= 0) return showErr("Enter an amount to send.");
    if (destChain === from) return showErr("Pick a different destination chain.");
    if (!addrOk(destChain, recipient)) return showErr(`That doesn't look like a valid ${chainName(destChain)} address.`);

    const btn = $("go");
    btn.disabled = true; btn.textContent = "Getting quote…";

    try {
      if (!TOKENS || !TOKENS.length) throw new Error("Still loading the asset list — try again in a moment.");
      const origin = assetFor(symbol, from);
      const dest = assetFor(symbol, destChain);
      if (!origin) throw new Error(`${symbol} on ${chainName(from)} isn't routable right now.`);
      if (!dest) throw new Error(`${symbol} on ${chainName(destChain)} isn't routable right now.`);

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
          origin, dest, amountHuman, symbol, from, destChain
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
    const cap = /minimum|max(imum)?|limit|temporary/i.test(msg);
    if (cap) {
      const m = msg.match(/\$([\d,]+)/);
      const floor = m ? ` ($${m[1]})` : "";
      return `This route is temporarily capped by the routing layer${floor}. ` +
             `Try a larger amount, or switch origin chain — the Ethereum/Base/Arbitrum corridors currently have no minimum. ` +
             `[${msg}]`;
    }
    return msg;
  }

  function renderQuote(j, origin, dest, deadline) {
    const q = j.quote || {}, req = j.quoteRequest || {};
    const inF = Number(q.amountInFormatted ?? req.amountInFormatted ?? 0);
    const outF = Number(q.amountOutFormatted ?? 0);
    const inUsd = Number(q.amountInUsd || 0);
    const outUsd = Number(q.amountOutUsd || 0);

    $("outAmt").textContent = `${fmt(outF, outF < 100 ? 4 : 2)} ${dest.symbol}`;
    const cost = inUsd > 0 && outUsd > 0 ? ((inUsd - outUsd) / inUsd) * 100 : null;
    $("costPct").textContent = cost !== null ? `${cost.toFixed(2)}%` : "—";
    $("rate").textContent = inF > 0 ? `1 ${origin.symbol} = ${(outF / inF).toFixed(5)} ${dest.symbol}` : "—";

    const feeUsd = inUsd > 0 && outUsd > 0 ? inUsd - outUsd : null;
    $("feeLine").textContent = feeUsd !== null
      ? `${(CFG.feeBps / 100).toFixed(2)}% + routing · $${fmt(feeUsd)}`
      : `${(CFG.feeBps / 100).toFixed(2)}%`;
    $("eta").textContent = q.timeEstimate ? `~${q.timeEstimate}s` : "~40s";
    $("expiry").textContent = new Date(deadline).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });

    $("depAddr").textContent = q.depositAddress || "—";
    $("sendAmt").textContent = fmt(inF, inF < 100 ? 4 : 2);
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
        asset: `${current.symbol} ${current.from}→${current.destChain}`,
        feeBps: CFG.feeBps,
        ourBps: Math.round(CFG.feeBps / 2),
        status: "SUCCESS"
      });
      localStorage.setItem(KEY, JSON.stringify(rows.slice(-2000)));
    } catch (_) { /* private mode */ }
  }

  boot();
})();
