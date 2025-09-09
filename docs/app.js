/* td_v2 frontend — robust mNAV + ETF
   mNAV: 6 tickers (MSTR, MTPLF, SBET, BMNR, DFDV, UPXI)
         mNAV = (Price × num_of_shares) ÷ NAV (preferred)
         fallback: precomputed mnav, else market_cap ÷ NAV
   ETF:  unchanged (daily bars + cumulative line)

   Works with "wide" CSVs (date,ticker,...) OR "long" CSVs (date,ticker,metric,val).
   Handles EQ- prefixes, :US, “US Equity”, commas/$, unicode minus, (123) negatives.
*/

(() => {
  "use strict";

  const WANT = ["MSTR","MTPLF","SBET","BMNR","DFDV","UPXI"];
  const PATHS = {
    dat: ["data/dat_data.csv","Data/dat_data.csv"],
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
  const normTicker = (raw) => {
    if (!raw) return "";
    let S = String(raw).toUpperCase();
    S = S.replace(/^EQ[:\s\-]+/,"");          // drop EQ- or EQ:
    S = S.replace(/[:\-]US\b/g,"");           // drop :US or -US
    S = S.replace(/\bUS\s+EQUITY\b/g,"");     // drop "US Equity"
    S = S.replace(/\s+EQUITY\b/g,"");         // drop trailing "Equity"
    S = S.replace(/[^\w]/g," ").trim();
    // try exact WANT match first
    for (const want of WANT) if (S.split(/\s+/).includes(want)) return want;
    // else try "first token"
    const tok = S.split(/\s+/)[0] || "";
    return WANT.includes(tok) ? tok : "";
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

  // ---------- CSV loader ----------
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
  async function loadAny(paths,label){
    let last; for (const p of paths){ try { return {rows:await loadCSV(p), path:p}; } catch(e){ last=e; } }
    throw new Error(`${label} not found (${paths.join(", ")}): ${last}`);
  }

  // ---------- chart helpers (keep “passable” slant) ----------
  function lineChart(ctx, labels, values, label="mNAV") {
    return new Chart(ctx, {
      type: "line",
      data: { labels, datasets: [{ label, data: values, tension: 0.2 }] },
      options: {
        responsive:true,
        maintainAspectRatio:false,
        plugins:{ legend:{ display:false } },
        scales:{
          x:{ ticks:{ minRotation:45, maxRotation:45, autoSkip:true, maxTicksLimit:8 } }
        }
      }
    });
  }
  function barLineChart(ctx, labels, bars, line, title) {
    return new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          {
            label: "Daily net flow",
            data: bars,
            yAxisID: "y",
            order: 2,
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
          { type: "line", label: "Cumulative", data: line, yAxisID: "y1", tension: 0.2, order: 1, borderWidth: 1, borderColor: "#d1d5db", pointRadius: 0 }
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false }, title: { display: false } },
        scales: {
          y:  { position: "left",  grid: { drawOnChartArea: true } },
          y1: { position: "right", grid: { drawOnChartArea: false } },
          x:  { ticks: { minRotation:45, maxRotation:45, autoSkip:true, maxTicksLimit:8 } },
        },
      },
    });
  }

  // ---------- mNAV ----------
  async function initMnav(){
    try {
      const { rows, path } = await loadAny(PATHS.dat, "dat_data.csv");
      if (!rows.length) throw new Error("dat_data.csv is empty");

      const sample = lowerKeys(rows[0] || {});
      const cols = Object.keys(sample);
      const isLong = cols.includes("metric") && (cols.includes("val") || cols.includes("value") || cols.includes("amount"));

      // gather[ticker][date] = { price, shares, nav, mc, mnav_pre }
      const gather = {};
      const ensure = (t,d)=>((gather[t] ||= {}), (gather[t][d] ||= { price:NaN, shares:NaN, nav:NaN, mc:NaN, mnav_pre:NaN }));

      const asDate = (r) => fmtDate(pick(r,["date","dt","timestamp","asof","as_of","time"]));

      if (isLong){
        for (const o of rows){
          const r = lowerKeys(o);
          const d = asDate(r);
          const t = normTicker(pick(r,["ticker","symbol","eq_ticker","asset","name"]));
          if (!d || !t) continue;

          const metric = String(r.metric || "").toLowerCase().trim();
          const v = toNum(pick(r,["val","value","amount","v"]));

          const rec = ensure(t,d);

          if (/^mnav$|^mn_a?v\b|^mnav_usd$/.test(metric)) { rec.mnav_pre = v; continue; }

          if (/^nav$|nav[_\s-]*usd|net[_\s-]*asset/.test(metric)) { rec.nav = v; continue; }

          if (/^mc$|market[_\s-]*cap|mkt[_\s-]*cap|marketcap/.test(metric)) { rec.mc = v; continue; }

          if (/^price$|^px$|px[_\s-]*last|close|last/.test(metric)) { rec.price = v; continue; }

          if (/(num[_\s-]*of[_\s-]*shares|num[_\s-]*shares|shares[_\s-]*outstanding|shares[_\s-]*basic|shares[_\s-]*out|share[_\s-]*count|shs[_\s-]*out)/.test(metric)) {
            rec.shares = v; continue;
          }
        }
      } else {
        for (const o of rows){
          const r = lowerKeys(o);
          const d = asDate(r);
          const t = normTicker(pick(r,["ticker","symbol","eq_ticker","asset","name"]));
          if (!d || !t) continue;

          const rec = ensure(t,d);
          // try all reasonable spellings
          rec.mnav_pre = Number.isFinite(rec.mnav_pre) ? rec.mnav_pre : toNum(r.mnav || r.mn_av || r.value || r.mnav_usd);
          rec.nav      = Number.isFinite(rec.nav)      ? rec.nav      : toNum(r.nav || r.nav_usd || r.net_asset_value || r.nav_total);
          rec.mc       = Number.isFinite(rec.mc)       ? rec.mc       : toNum(r.mc || r.market_cap || r.mkt_cap || r.marketcap);
          rec.price    = Number.isFinite(rec.price)    ? rec.price    : toNum(r.price || r.px || r.px_last || r.close || r.last);
          rec.shares   = Number.isFinite(rec.shares)   ? rec.shares   : toNum(r.num_of_shares || r.num_shares || r.shares_outstanding || r.shares_basic || r.shares_out || r.share_count || r.shs_out || r.shares);
        }
      }

      // compute series per desired ticker
      const grouped = Object.fromEntries(WANT.map(t => [t, []]));
      let haveAny = false;
      for (const t of Object.keys(gather)){
        if (!WANT.includes(t)) continue;
        const days = Object.keys(gather[t]).sort();
        for (const d of days){
          const r = gather[t][d];
          let mnav = NaN;
          // preferred: (price × shares) / nav
          if (Number.isFinite(r.price) && Number.isFinite(r.shares) && Number.isFinite(r.nav) && r.nav !== 0) {
            mnav = (r.price * r.shares) / r.nav;
          } else if (Number.isFinite(r.mnav_pre)) {
            mnav = r.mnav_pre;
          } else if (Number.isFinite(r.mc) && Number.isFinite(r.nav) && r.nav !== 0) {
            mnav = r.mc / r.nav;
          }
          if (Number.isFinite(mnav)) {
            grouped[t].push({ date:d, mnav });
            haveAny = true;
          }
        }
      }

      // diagnostics
      const tickerStats = WANT.map(t => `${t}:${grouped[t]?.length||0}`).join("  ");
      const uniqTickers = [...new Set(rows.map(o => normTicker(pick(lowerKeys(o),["ticker","symbol","eq_ticker","asset","name"])))).values()].filter(Boolean);
      banner(`mNAV source: ${path} • parsed: ${rows.length} • tickers seen: ${uniqTickers.length} • ${tickerStats}`);

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
        if (!series.length) { const note = el("div","caption"); note.textContent="No data for this ticker."; card.appendChild(note); }
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

      if (!haveAny) {
        // extra hint: show a few unique metric names it found for quick debugging
        const metrics = new Set();
        for (const o of rows) { const r = lowerKeys(o); if (r.metric) metrics.add(String(r.metric).toLowerCase()); if (metrics.size>8) break; }
        if (metrics.size) banner(`mNAV hint: found metrics like [${[...metrics].join(", ")}]. If mNAV still empty, column names may not match.`);
      }
    } catch (e) { banner(String(e)); }
  }

  // ---------- ETF (unchanged) ----------
  async function initEtf(){
    try {
      const { rows, path } = await loadAny(PATHS.etf, "etf_data.csv");
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

      // BTC series: start at first day that has BTC data
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

      // ETH series starts at 2024-07-23
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

      // ensure All buttons exist
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
        bctx.__chart = barLineChart(bctx, bl, bb, bc, "BTC ETF Flows");
        ectx.__chart = barLineChart(ectx, el, eb, ec, "ETH ETF Flows");
      }
      const hook=(sel,val)=>{ const btn=document.querySelector(sel); if (btn) btn.addEventListener("click", ()=>{ rangeDays=val; render(); }); };
      hook('[data-range="btc-1m"]',30); hook('[data-range="btc-3m"]',90); hook('[data-range="btc-all"]',Infinity);
      hook('[data-range="eth-1m"]',30); hook('[data-range="eth-3m"]',90); hook('[data-range="eth-all"]',Infinity);
      render();

    } catch (e) { banner(String(e)); }
  }

  window.addEventListener("DOMContentLoaded", () => { initMnav(); initEtf(); });
})();
