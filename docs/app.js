/* td_v2 frontend — SIMPLE + ROBUST (no assumptions about CSV case)
   mNAV: 6 tickers (MSTR, MTPLF, SBET, BMNR, DFDV, UPXI)
         mNAV = (Market Cap ÷ NAV) fallback (Price × num_of_shares) ÷ NAV
   ETF:  bars = signed daily flows, line = all-time cumulative

   Works with "wide" CSVs (date,ticker,mc,nav,price,num_of_shares,...) OR
   "long" CSVs (date,ticker,metric,val). Handles EQ- prefixes, “US Equity”
   suffixes, commas/$/unicode minus/(123) negatives.
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
    const mapTicker = (raw) => {
      if (!raw) return "";
      const S = String(raw).toUpperCase().replace(/^EQ[:\s\-]+/,"").replace(/EQUITY/g,"");
      for (const want of WANT) if (S.includes(want)) return want;
      const tok = S.replace(/[^A-Z0-9]/g," ").trim().split(/\s+/)[0];
      return WANT.includes(tok) ? tok : "";
    };
  
    function banner(msg) {
      let bar = $("#diag"); if (!bar) {
        bar = el("div","diag");
        bar.id = "diag";
        bar.style.cssText = "margin:8px 0 16px;padding:8px 12px;border-radius:10px;background:#2a1b1b;color:#f6dada;font:12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
        const container = document.querySelector(".container") || document.body;
        container.insertBefore(bar, container.firstChild.nextSibling);
      }
      bar.textContent = msg;
    }
  
    // ---------- CSV loader (tries multiple locations) ----------
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
  
    // ---------- charts ----------
    function lineChart(ctx, labels, values) {
      return new Chart(ctx, {
        type: "line",
        data: { labels, datasets: [{ label:"mNAV", data: values, tension: 0.2 }] },
        options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
                   scales:{ x:{ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:8}} } }
      });
    }
    function barLineChart(ctx, labels, bars, line, title) {
      return new Chart(ctx, {
        type: "bar",
        data: { labels,
          datasets: [
            { label:"Daily net flow", data: bars, yAxisID:"y", order:2 },
            { type:"line", label:"Cumulative (all-time)", data: line, yAxisID:"y1", tension:0.2, order:1 },
          ]},
        options: {
          responsive:true, maintainAspectRatio:false,
          plugins:{ legend:{position:"bottom"}, title:{display:!!title,text:title} },
          scales:{ y:{position:"left"}, y1:{position:"right", grid:{drawOnChartArea:false}},
                   x:{ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:8}} }
        }
      });
    }
  
    // ---------- mNAV ----------
    async function initMnav(){
      try {
        const { rows, path } = await loadAny(PATHS.dat, "dat_data.csv");
        const cols = Object.keys(lowerKeys(rows[0]||{}));
        const isLong = cols.some(k=>["metric","series","field","name"].includes(k)) && cols.some(k=>["val","value"].includes(k));
  
        // bucket[t][d] = { mc, nav, price, shares, mnav_pre }
        const bucket = {};
        const ensure = (t,d)=>((bucket[t] ||= {}), (bucket[t][d] ||= {mc:NaN,nav:NaN,price:NaN,shares:NaN,mnav_pre:NaN}));
  
        if (isLong){
          for (const o of rows){
            const r = lowerKeys(o);
            const d = fmtDate(pick(r,["date","dt","timestamp","asof","as_of"]));
            const t = mapTicker(pick(r,["ticker","symbol","eq_ticker","asset","name"]));
            if (!d || !t) continue;
            const metric = String(pick(r,["metric","series","field","name"])||"").toLowerCase();
            const v = toNum(pick(r,["val","value"]));
            const rec = ensure(t,d);
            if (/^mnav$/.test(metric)) rec.mnav_pre = v;
            else if (/^mc$|market.?cap/.test(metric)) rec.mc = v;
            else if (/^nav$|nav_usd|net.?asset/.test(metric)) rec.nav = v;
            else if (/^price$|px_last|close|last/.test(metric)) rec.price = v;
            else if (/num.?of.?shares|shares_outstanding|shares_basic|shares_out|sharecount/.test(metric)) rec.shares = v;
          }
        } else {
          for (const o of rows){
            const r = lowerKeys(o);
            const d = fmtDate(pick(r,["date","dt","timestamp","asof","as_of"]));
            const t = mapTicker(pick(r,["ticker","symbol","eq_ticker","asset","name"]));
            if (!d || !t) continue;
            const rec = ensure(t,d);
            rec.mnav_pre = Number.isFinite(rec.mnav_pre) ? rec.mnav_pre : toNum(r.mnav || r.value);
            rec.mc   = Number.isFinite(rec.mc)   ? rec.mc   : toNum(r.mc || r.market_cap || r.marketcap);
            rec.nav  = Number.isFinite(rec.nav)  ? rec.nav  : toNum(r.nav || r.nav_usd || r.net_asset_value);
            rec.price= Number.isFinite(rec.price)? rec.price: toNum(r.price || r.close || r.px_last || r.last);
            rec.shares=Number.isFinite(rec.shares)?rec.shares:toNum(r.num_of_shares || r.num_shares || r.shares_outstanding || r.shares_basic || r.shares_out || r.shares);
          }
        }
  
        const grouped = Object.fromEntries(WANT.map(t => [t, []]));
        for (const t of Object.keys(bucket)){
          if (!WANT.includes(t)) continue;
          for (const d of Object.keys(bucket[t]).sort()){
            const r = bucket[t][d];
            let mnav = NaN;
            if (Number.isFinite(r.mc) && Number.isFinite(r.nav) && r.nav !== 0) mnav = r.mc / r.nav;
            else if (Number.isFinite(r.price) && Number.isFinite(r.shares) && Number.isFinite(r.nav) && r.nav !== 0) mnav = (r.price * r.shares) / r.nav;
            else if (Number.isFinite(r.mnav_pre)) mnav = r.mnav_pre;
            if (Number.isFinite(mnav)) grouped[t].push({date:d, mnav});
          }
        }
  
        banner(`mNAV source: ${path} • ` + WANT.map(t => `${t}:${grouped[t]?.length||0}`).join("  "));
  
        const grid = $("#mnav-grid"); if (!grid){ banner("Missing #mnav-grid"); return; }
        grid.innerHTML = "";
  
        for (const tkr of WANT){
          const series = grouped[tkr] || [];
          const card = el("div","card");
          const head = el("div","card-head"); head.textContent = `${tkr} — mNAV`;
          const btns = el("div","btns");
          const b1 = el("button"); b1.type="button"; b1.textContent="1M";
          const b3 = el("button"); b3.type="button"; b3.textContent="3M";
          head.appendChild(btns); btns.appendChild(b1); btns.appendChild(b3);
          const chartBox = el("div","chart"); const can = el("canvas"); chartBox.appendChild(can);
          const caption = el("div","caption"); caption.textContent = "mNAV = Market Cap ÷ NAV (fallback: (Price × Number of Shares) ÷ NAV)";
          card.appendChild(head); card.appendChild(chartBox); card.appendChild(caption);
          if (!series.length) { const note = el("div","caption"); note.textContent="No data for this ticker."; card.appendChild(note); }
          grid.appendChild(card);
  
          let rangeDays = 30, chart;
          const render = () => {
            const labels = lastN(series.map(s=>s.date), rangeDays);
            const vals   = lastN(series.map(s=>s.mnav), rangeDays);
            if (chart) chart.destroy();
            chart = lineChart(can.getContext("2d"), labels, vals);
          };
          b1.addEventListener("click", ()=>{ rangeDays=30; render(); });
          b3.addEventListener("click", ()=>{ rangeDays=90; render(); });
          render();
        }
      } catch (e) { banner(String(e)); }
    }
  
    // ---------- ETF Flows ----------
    async function initEtf(){
      try {
        const { rows, path } = await loadAny(PATHS.etf, "etf_data.csv");
    
        // Normalize to {date, metric, btc, eth}
        const normalized = rows.map(o => {
          const r = lowerKeys(o);
          const d = fmtDate(r.date || r.dt || r.timestamp);
          const m = String(r.metric || "").toLowerCase();
          // CSV headers are "BTC" and "ETH" (case-insensitive)
          const btc = toNum(r.btc ?? r.BTC ?? r["btc"]);
          const eth = toNum(r.eth ?? r.ETH ?? r["eth"]);
          return d ? { date: d, metric: m, btc, eth } : null;
        }).filter(Boolean);
    
        // Group by date: pick daily from "etf_net_flow_usd_millions" and cumulative from "etf_cumulative_net_flow_usd_millions"
        const byDate = {}; // date -> { btcDaily, ethDaily, btcCum, ethCum }
        for (const r of normalized) {
          const rec = (byDate[r.date] ||= { btcDaily: 0, ethDaily: 0, btcCum: undefined, ethCum: undefined });
          if (r.metric.includes("cumulative")) {
            if (Number.isFinite(r.btc)) rec.btcCum = r.btc;
            if (Number.isFinite(r.eth)) rec.ethCum = r.eth;
          } else if (r.metric.includes("net_flow")) {
            if (Number.isFinite(r.btc)) rec.btcDaily = r.btc;
            if (Number.isFinite(r.eth)) rec.ethDaily = r.eth;
          }
        }
    
        // Build time series in date order; if cumulative missing, compute from daily
        let bCum = 0, eCum = 0;
        const series = Object.keys(byDate).sort().map(d => {
          const r = byDate[d];
          const bD = Number.isFinite(r.btcDaily) ? r.btcDaily : 0;
          const eD = Number.isFinite(r.ethDaily) ? r.ethDaily : 0;
          if (Number.isFinite(r.btcCum)) bCum = r.btcCum; else bCum += bD;
          if (Number.isFinite(r.ethCum)) eCum = r.ethCum; else eCum += eD;
          return { date: d, btcDaily: bD, ethDaily: eD, btcCum: bCum, ethCum: eCum };
        });
    
        banner(`ETF source: ${path} • rows: ${series.length}`);
    
        const bctx = $("#btcChart")?.getContext("2d");
        const ectx = $("#ethChart")?.getContext("2d");
        if (!bctx || !ectx){ banner("Missing BTC/ETH canvas"); return; }
    
        let rangeDays = 30;
        function render(){
          const slice = series.slice(-rangeDays);
          const labels = slice.map(r=>r.date);
          const bBar  = slice.map(r=>r.btcDaily); // signed daily bars
          const bLine = slice.map(r=>r.btcCum);   // cumulative line
          const eBar  = slice.map(r=>r.ethDaily);
          const eLine = slice.map(r=>r.ethCum);
    
          bctx.__chart && bctx.__chart.destroy();
          ectx.__chart && ectx.__chart.destroy();
          bctx.__chart = barLineChart(bctx, labels, bBar, bLine, "BTC ETF Flows");
          ectx.__chart = barLineChart(ectx, labels, eBar, eLine, "ETH ETF Flows");
        }
        const hook=(sel,days)=>{ const btn=document.querySelector(sel); if (btn) btn.addEventListener("click", ()=>{rangeDays=days; render();}); };
        hook('[data-range="btc-1m"]',30); hook('[data-range="btc-3m"]',90);
        hook('[data-range="eth-1m"]',30); hook('[data-range="eth-3m"]',90);
        render();
      } catch (e) { banner(String(e)); }
    }
  
    window.addEventListener("DOMContentLoaded", () => { initMnav(); initEtf(); });
  })();
