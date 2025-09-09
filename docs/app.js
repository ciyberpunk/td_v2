/* td_v2 frontend — robust mNAV + ETF (long/wide CSV tolerant)
   mNAV for: MSTR, MTPLF, SBET, BMNR, DFDV, UPXI
   Preferred mNAV = (Price × Number of Shares) ÷ NAV
   Fallbacks: precomputed mnav, then Market Cap ÷ NAV

   Why charts were blank before:
   - Long-format metrics didn't match exactly (e.g., "net asset value")
   - Raw tickers like "EQ-MSTR" weren’t normalized consistently
   - Some rows lack 1 of (price/shares/nav); we now show per-ticker diagnostics
*/

(() => {
  "use strict";

  const WANT = ["MSTR","MTPLF","SBET","BMNR","DFDV","UPXI"];
  const PATHS = {
    dat: ["data/dat_data.csv","Data/dat_data.csv"],
    map: ["data/dat_data_mapping.json","Data/dat_data_mapping.json"],
    etf: ["data/etf_data.csv","Data/etf_data.csv"],
  };

  // ---------- tiny DOM helpers ----------
  const $ = (s) => document.querySelector(s);
  const el = (t,c) => Object.assign(document.createElement(t), c?{className:c}:{});
  const fmtDate = (d) => { const x = d instanceof Date ? d : new Date(d); return isNaN(+x) ? "" : x.toISOString().slice(0,10); };
  const lastN = (a,n) => a.slice(-n);
  const lowerKeys = (o) => Object.fromEntries(Object.entries(o).map(([k,v]) => [String(k).toLowerCase(), v]));
  const pick = (obj, keys) => { for (const k of keys) if (obj[k] !== undefined) return obj[k]; };
  const toNum = (v) => {
    if (v === null || v === undefined) return NaN;
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    let s = String(v).trim(); if (!s) return NaN;
    s = s.replace(/\u2212/g,"-"); if (/^\(.*\)$/.test(s)) s = "-" + s.slice(1,-1);
    s = s.replace(/[\$,]/g,"").replace(/%/g,"");
    const n = parseFloat(s); return Number.isFinite(n) ? n : NaN;
  };

  function banner(msg) {
    let bar = $("#diag"); if (!bar) {
      bar = el("div","diag");
      bar.id = "diag";
      bar.style.cssText = "margin:8px 0 16px;padding:8px 12px;border-radius:10px;background:#2a1b1b;color:#f6dada;font:12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
      const container = document.querySelector(".container") || document.body;
      container.insertBefore(bar, container.firstChild?.nextSibling || container.firstChild);
    }
    bar.textContent = msg;
    console.warn("[td_v2]", msg);
  }

  // ---------- file loaders ----------
  function loadCSV(path) {
    return new Promise((resolve, reject) => {
      if (!window.Papa) return reject(new Error("Papa Parse not loaded"));
      Papa.parse(path, {
        download: true, header: true, dynamicTyping: false, skipEmptyLines: true,
        complete: (res) => {
          const { data, errors } = res || {};
          if (errors && errors.length) return reject(new Error(`${path}: ${errors[0].message || "parse error"}`));
          resolve((data||[]).filter(Boolean));
        },
        error: (err) => reject(new Error(`${path}: ${err?.message || err}`)),
      });
    });
  }
  async function loadAny(paths,label, kind="csv"){
    let last;
    for (const p of paths){
      try {
        if (kind === "csv") return { rows: await loadCSV(p), path: p };
        // JSON
        const r = await fetch(p, { cache:"no-cache" });
        if (!r.ok) throw new Error(`${r.status}`);
        const json = await r.json();
        return { json, path: p };
      } catch(e){ last = e; }
    }
    throw new Error(`${label} not found (${paths.join(", ")}): ${last}`);
  }

  // ---------- ticker normalization (with optional mapping) ----------
  function cleanTicker(raw) {
    if (!raw) return "";
    let S = String(raw).toUpperCase();
    S = S.replace(/^EQ[:\s\-]+/,"");      // drop EQ- or EQ:
    S = S.replace(/[:\-]US\b/g,"");       // drop :US or -US
    S = S.replace(/\bUS\s+EQUITY\b/g,""); // drop "US Equity"
    S = S.replace(/\s+EQUITY\b/g,"");     // drop trailing "Equity"
    S = S.replace(/[^\w]/g," ").trim();
    const tok = S.split(/\s+/)[0] || "";
    // exact contain
    for (const w of WANT) if (S.includes(w)) return w;
    return WANT.includes(tok) ? tok : "";
  }
  function buildMap(obj){
    // Accepts:
    //  - {"EQ-MSTR": {...}, "EQ-MTPLF": {...}, ...}
    //  - {"map":{"EQ-MSTR":"MSTR",...}} or any nested — we grab top-level keys
    const m = {};
    if (!obj || typeof obj !== "object") return m;
    const add = (k) => { const ck = cleanTicker(k); if (ck) m[String(k).toUpperCase()] = ck; };
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        // if nested object with non-numeric keys, collect those too
        add(k);
        for (const kk of Object.keys(v)) add(kk);
      } else {
        add(k);
        if (typeof v === "string") add(v);
      }
    }
    return m;
  }

  let TICKER_MAP = {}; // raw -> cleaned (WANT)

  // ---------- charts (45° tilt, as requested) ----------
  function lineChart(ctx, labels, values, label="mNAV") {
    return new Chart(ctx, {
      type: "line",
      data: { labels, datasets: [{ label, data: values, tension: 0.2 }] },
      options: {
        responsive:true,
        maintainAspectRatio:false,
        plugins:{ legend:{ display:false } },
        scales:{ x:{ ticks:{ minRotation:45, maxRotation:45, autoSkip:true, maxTicksLimit:8 } } }
      }
    });
  }
  function barLineChart(ctx, labels, bars, line) {
    return new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Daily net flow",
            data: bars, yAxisID: "y", order: 2,
            backgroundColor: (c) => {
              const v = (c.raw ?? c.parsed?.y ?? 0);
              return (typeof v === "number" && v < 0) ? "rgba(239,68,68,0.8)" : "rgba(22,163,74,0.8)";
            },
            borderColor: (c) => {
              const v = (c.raw ?? c.parsed?.y ?? 0);
              return (typeof v === "number" && v < 0) ? "rgba(220,38,38,1)" : "rgba(21,128,61,1)";
            },
            borderWidth: 1
          },
          { type:"line", label:"Cumulative", data: line, yAxisID:"y1", order:1, tension:0.2, borderWidth:1, borderColor:"#d1d5db", pointRadius:0 }
        ],
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false }, title:{ display:false } },
        scales:{
          y:  { position:"left",  grid:{ drawOnChartArea:true } },
          y1: { position:"right", grid:{ drawOnChartArea:false } },
          x:  { ticks:{ minRotation:45, maxRotation:45, autoSkip:true, maxTicksLimit:8 } },
        },
      },
    });
  }

  // ---------- mNAV ----------
  async function initMnav(){
    try {
      // Load optional mapping first (to resolve EQ-… -> want tickers)
      try {
        const { json } = await loadAny(PATHS.map, "dat_data_mapping.json", "json");
        TICKER_MAP = buildMap(json);
      } catch { TICKER_MAP = {}; }

      const { rows, path } = await loadAny(PATHS.dat, "dat_data.csv", "csv");
      if (!rows.length) throw new Error("dat_data.csv is empty");

      const asDate = (r) => fmtDate(pick(r,["date","dt","timestamp","asof","as_of","time","recorded_at"]));
      const getTicker = (r) => {
        const raw = pick(r,["ticker","symbol","eq_ticker","asset","name","security","company","eqticker"]);
        const fromMap = raw && TICKER_MAP[String(raw).toUpperCase()];
        return fromMap || cleanTicker(raw);
      };

      // Long vs wide
      const sample = lowerKeys(rows[0]||{});
      const cols = Object.keys(sample);
      const isLong = cols.includes("metric") && (cols.includes("val") || cols.includes("value") || cols.includes("amount"));

      // bucket[t][d] = { price, shares, nav, mc, mnav_pre }
      const bucket = {};
      const ensure = (t,d)=>((bucket[t] ||= {}), (bucket[t][d] ||= { price:NaN, shares:NaN, nav:NaN, mc:NaN, mnav_pre:NaN }));

      // helpers to recognize metrics by *your* strings
      const isPrice = (s) => /^price$|^px$|px[_\s-]*last$|close$|last$/i.test(s);
      const isNav   = (s) => /^nav$|nav[_\s-]*usd$|^net[_\s-]*asset[_\s-]*value$|^net\s*asset\s*value$/i.test(s);
      const isMC    = (s) => /^mc$|^market[_\s-]*cap$|^mkt[_\s-]*cap$|^marketcap$/i.test(s);
      const isShares= (s) =>
        /^(num|number)[_\s-]*(of)?[_\s-]*shares/i.test(s) ||
        /shares?[_\s-]*outstanding/i.test(s) ||
        /shares?[_\s-]*basic/i.test(s) ||
        /share[_\s-]*count/i.test(s) ||
        /shs[_\s-]*out/i.test(s) ||
        /basic[_\s-]*shares?[_\s-]*out/i.test(s) ||
        /diluted[_\s-]*shares?[_\s-]*out/i.test(s);
      const isPreMNAV = (s) => /^mnav$|^mn_a?v$|mnav[_\s-]*usd$/i.test(s);

      if (isLong){
        for (const o of rows){
          const r = lowerKeys(o);
          const d = asDate(r); const t = getTicker(r);
          if (!d || !t || !WANT.includes(t)) continue;

          const metric = String(r.metric || "").toLowerCase().trim();
          const v = toNum(pick(r,["val","value","amount","v"]));
          const rec = ensure(t,d);

          if      (isPrice(metric))  rec.price  = v;
          else if (isNav(metric))    rec.nav    = v;
          else if (isMC(metric))     rec.mc     = v;
          else if (isShares(metric)) rec.shares = v;
          else if (isPreMNAV(metric))rec.mnav_pre = v;
          // ignore: number of tokens held, volume, volatility, warrants, etc.
        }
      } else {
        for (const o of rows){
          const r = lowerKeys(o);
          const d = asDate(r); const t = getTicker(r);
          if (!d || !t || !WANT.includes(t)) continue;
          const rec = ensure(t,d);
          // best-effort field name coverage
          rec.price  = Number.isFinite(rec.price ) ? rec.price  : toNum(r.price||r.px||r.px_last||r.close||r.last);
          rec.nav    = Number.isFinite(rec.nav   ) ? rec.nav    : toNum(r.nav||r.nav_usd||r.net_asset_value||r.navtotal||r.nav_total);
          rec.mc     = Number.isFinite(rec.mc    ) ? rec.mc     : toNum(r.mc||r.market_cap||r.mkt_cap||r.marketcap);
          rec.shares = Number.isFinite(rec.shares) ? rec.shares : toNum(
            r.num_of_shares||r.number_of_shares||r.num_shares||
            r.shares_outstanding||r.basic_shares_outstanding||
            r.diluted_shares_outstanding||r.shares_basic||r.shares_out||r.share_count||r.shs_out||r.shares
          );
          rec.mnav_pre = Number.isFinite(rec.mnav_pre) ? rec.mnav_pre : toNum(r.mnav||r.mn_av||r.mnav_usd||r.value);
        }
      }

      // Build series + simple reasons counter
      const grouped = Object.fromEntries(WANT.map(t => [t, []]));
      const reasons = Object.fromEntries(WANT.map(t => [t, {needPrice:0, needShares:0, needNav:0}])); // missing components counters

      for (const t of Object.keys(bucket)){
        if (!WANT.includes(t)) continue;
        for (const d of Object.keys(bucket[t]).sort()){
          const r = bucket[t][d];
          let mnav = NaN;

          // preferred
          if (Number.isFinite(r.price) && Number.isFinite(r.shares) && Number.isFinite(r.nav) && r.nav !== 0) {
            mnav = (r.price * r.shares) / r.nav;
          } else if (Number.isFinite(r.mnav_pre)) {
            mnav = r.mnav_pre;
          } else if (Number.isFinite(r.mc) && Number.isFinite(r.nav) && r.nav !== 0) {
            mnav = r.mc / r.nav;
          } else {
            // track why we couldn't compute (first-true wins order: price, shares, nav)
            if (!Number.isFinite(r.price))  reasons[t].needPrice++;
            if (!Number.isFinite(r.shares)) reasons[t].needShares++;
            if (!Number.isFinite(r.nav))    reasons[t].needNav++;
          }

          if (Number.isFinite(mnav)) grouped[t].push({ date:d, mnav });
        }
      }

      const statStr = WANT.map(t => {
        const s = grouped[t]?.length||0;
        const z = reasons[t]; const miss = (z.needPrice||z.needShares||z.needNav)
          ? ` (miss p:${z.needPrice} sh:${z.needShares} nav:${z.needNav})` : "";
        return `${t}:${s}${miss}`;
      }).join("  ");

      banner(`mNAV source: ${path} • rows: ${rows.length} • ${statStr}`);

      // render
      const grid = $("#mnav-grid"); if (!grid){ banner("Missing #mnav-grid"); return; }
      grid.innerHTML = "";

      for (const tkr of WANT){
        const series = (grouped[tkr] || []);
        const card = el("div","card");
        const head = el("div","card-head"); head.textContent = `${tkr} — mNAV`;
        const btns = el("div","btns");
        const b1 = el("button"); b1.type="button"; b1.textContent="1M";
        const b3 = el("button"); b3.type="button"; b3.textContent="3M";
        head.appendChild(btns); btns.appendChild(b1); btns.appendChild(b3);
        const chartBox = el("div","chart"); const can = el("canvas"); chartBox.appendChild(can);
        const caption = el("div","caption"); caption.textContent = "mNAV = (Price × Number of Shares) ÷ NAV";
        card.appendChild(head); card.appendChild(chartBox); card.appendChild(caption);
        if (!series.length) { const note = el("div","caption"); note.textContent="No mNAV points computed for this ticker."; card.appendChild(note); }
        grid.appendChild(card);

        let rangeDays = 30, chart;
        const render = () => {
          const labels = lastN(series.map(s=>s.date), rangeDays);
          const vals   = lastN(series.map(s=>s.mnav), rangeDays);
          if (chart) chart.destroy();
          chart = lineChart(can.getContext("2d"), labels, vals, "mNAV");
        };
        b1.addEventListener("click", ()=>{ rangeDays=30; render(); });
        b3.addEventListener("click", ()=>{ rangeDays=90; render(); });
        render();
      }
    } catch (e) { banner(String(e)); }
  }

  // ---------- ETF (stable from earlier) ----------
  async function initEtf(){
    try {
      const { rows, path } = await loadAny(PATHS.etf, "etf_data.csv", "csv");
      if (!rows.length) throw new Error("etf_data.csv is empty");

      const normalized = rows.map(o => {
        const r = lowerKeys(o);
        const d = fmtDate(r.date || r.dt || r.timestamp);
        if (!d) return null;
        const metric = (r.metric ? String(r.metric).toLowerCase() : "");
        const btc = toNum(r.btc);
        const eth = toNum(r.eth);
        return { date: d, metric, btc, eth, raw: r };
      }).filter(Boolean);

      const byDate = {}; // date -> { btcDaily, ethDaily, btcCum, ethCum }
      for (const r of normalized) {
        const rec = (byDate[r.date] ||= { btcDaily: undefined, ethDaily: undefined, btcCum: undefined, ethCum: undefined });

        if (r.metric.includes("net_flow")) {
          if (Number.isFinite(r.btc)) rec.btcDaily = r.btc;
          if (Number.isFinite(r.eth)) rec.ethDaily = r.eth;
        } else if (r.metric.includes("cumulative")) {
          if (Number.isFinite(r.btc)) rec.btcCum = r.btc;
          if (Number.isFinite(r.eth)) rec.ethCum = r.eth;
        } else if (!r.metric) {
          const rr = r.raw; const keys = Object.keys(rr);
          const bTry = toNum(rr.btc_daily ?? rr.btc_net_flow_usd_millions ?? rr.btc_flow ?? rr.btc);
          const eTry = toNum(rr.eth_daily ?? rr.eth_net_flow_usd_millions ?? rr.eth_flow ?? rr.eth);
          const bSum = keys.filter(k => /btc/.test(k) && /(net|flow)/.test(k) && !/cum|cumulative/.test(k))
                           .map(k => toNum(rr[k])).filter(Number.isFinite).reduce((a,b)=>a+b,0);
          const eSum = keys.filter(k => /eth/.test(k) && /(net|flow)/.test(k) && !/cum|cumulative/.test(k))
                           .map(k => toNum(rr[k])).filter(Number.isFinite).reduce((a,b)=>a+b,0);
          if (Number.isFinite(bTry) || Number.isFinite(bSum)) rec.btcDaily = Number.isFinite(bTry) ? bTry : bSum;
          if (Number.isFinite(eTry) || Number.isFinite(eSum)) rec.ethDaily = Number.isFinite(eTry) ? eTry : eSum;
        }
      }

      const dates = Object.keys(byDate).sort();

      // BTC from first day with data
      let bCum = 0, startedB = false;
      const btcSeries = [];
      for (const d of dates) {
        const r = byDate[d];
        const hasB = Number.isFinite(r.btcDaily) || Number.isFinite(r.btcCum);
        if (!startedB && !hasB) continue;
        if (!startedB) startedB = true;
        const daily = Number.isFinite(r.btcDaily) ? r.btcDaily : 0;
        if (Number.isFinite(r.btcCum)) bCum = r.btcCum; else bCum += daily;
        btcSeries.push({ date: d, daily, cum: bCum });
      }

      // ETH start at 2024-07-23
      const ETH_START = "2024-07-23";
      let eCum = 0, startedE = false;
      const ethSeries = [];
      for (const d of dates) {
        if (d < ETH_START) continue;
        const r = byDate[d];
        const hasE = Number.isFinite(r.ethDaily) || Number.isFinite(r.ethCum);
        if (!startedE && !hasE) continue;
        if (!startedE) startedE = true;
        const daily = Number.isFinite(r.ethDaily) ? r.ethDaily : 0;
        if (Number.isFinite(r.ethCum)) eCum = r.ethCum; else eCum += daily;
        ethSeries.push({ date: d, daily, cum: eCum });
      }

      banner(`ETF source: ${path} • BTC:${btcSeries.length} • ETH:${ethSeries.length}`);

      const bctx = $("#btcChart")?.getContext("2d");
      const ectx = $("#ethChart")?.getContext("2d");
      if (!bctx || !ectx){ banner("Missing BTC/ETH canvas"); return; }

      // Ensure All buttons exist
      (function addAllButtons(){
        const add = (prefix) => {
          const b1 = document.querySelector(`[data-range="${prefix}-1m"]`);
          if (!b1) return;
          const wrap = b1.parentElement;
          if (!wrap.querySelector(`[data-range="${prefix}-all"]`)) {
            const all = document.createElement('button');
            all.type = 'button'; all.textContent = 'All';
            all.setAttribute('data-range', `${prefix}-all`);
            wrap.appendChild(all);
          }
        }; add('btc'); add('eth');
      })();

      let rangeDays = 30; // 30=1M, 90=3M, Infinity=All
      function render(){
        const bView = (rangeDays === Infinity) ? btcSeries : btcSeries.slice(-rangeDays);
        const eView = (rangeDays === Infinity) ? ethSeries : ethSeries.slice(-rangeDays);
        const bl = bView.map(r=>r.date), bb = bView.map(r=>r.daily), bc = bView.map(r=>r.cum);
        const el = eView.map(r=>r.date), eb = eView.map(r=>r.daily), ec = eView.map(r=>r.cum);

        bctx.__chart && bctx.__chart.destroy();
        ectx.__chart && ectx.__chart.destroy();
        bctx.__chart = barLineChart(bctx, bl, bb, bc);
        ectx.__chart = barLineChart(ectx, el, eb, ec);
      }
      const hook=(sel,val)=>{ const btn=document.querySelector(sel); if (btn) btn.addEventListener("click", ()=>{ rangeDays=val; render(); }); };
      hook('[data-range="btc-1m"]',30); hook('[data-range="btc-3m"]',90); hook('[data-range="btc-all"]',Infinity);
      hook('[data-range="eth-1m"]',30); hook('[data-range="eth-3m"]',90); hook('[data-range="eth-all"]',Infinity);
      render();

    } catch (e) { banner(String(e)); }
  }

  window.addEventListener("DOMContentLoaded", () => { initMnav(); initEtf(); });
})();
