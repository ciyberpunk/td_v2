/* PC F1 — DATs + ETF Flows
   - mNAV: metric=='mnav' (server-computed); persistent mouse-tracking tooltip
   - ETF : bars + thin white cumulative line; persistent tooltip:
           * over a bar -> show Daily
           * elsewhere  -> show Cumulative
   - Default range: 3M (90 days)
*/
(() => {
  "use strict";

  const TICKERS = ["MSTR","MTPLF","SBET","BMNR","DFDV","UPXI"];
  const PATHS = {
    dat: ["data/dat_data.csv","Data/dat_data.csv"],
    etf: ["data/etf_data.csv","Data/etf_data.csv"],
  };

  // ---------- utils ----------
  const $ = s => document.querySelector(s);
  const el = (t,c) => Object.assign(document.createElement(t), c?{className:c}:{});
  const fmtDate = d => { const x = d instanceof Date ? d : new Date(d); return isNaN(+x) ? "" : x.toISOString().slice(0,10); };
  const lastN = (a,n) => a.slice(-n);
  const lower = o => Object.fromEntries(Object.entries(o).map(([k,v]) => [String(k).toLowerCase(), v]));
  const toNum = v => {
    if (v == null) return NaN;
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    let s = String(v).trim(); if (!s) return NaN;
    s = s.replace(/\u2212/g,"-"); if (/^\(.*\)$/.test(s)) s = "-" + s.slice(1,-1);
    s = s.replace(/[\$,]/g,"").replace(/%/g,"");
    const n = parseFloat(s); return Number.isFinite(n) ? n : NaN;
  };

  // console-only diagnostics
  function banner(msg){ console.warn("[pc-f1]", msg); }

  function loadCSV(path){
    return new Promise((resolve,reject)=>{
      if(!window.Papa) return reject(new Error("Papa Parse not loaded"));
      Papa.parse(path,{
        download:true, header:true, dynamicTyping:false, skipEmptyLines:true,
        complete:(res)=>{ const {data,errors}=res||{}; if(errors&&errors.length) return reject(new Error(`${path}: ${errors[0].message||"parse error"}`)); resolve((data||[]).filter(Boolean)); },
        error:(err)=>reject(new Error(`${path}: ${err?.message||err}`))
      });
    });
  }
  async function loadAny(paths,label){ let last; for(const p of paths){ try { return {rows:await loadCSV(p), path:p}; } catch(e){ last=e; } } throw new Error(`${label} not found (${paths.join(", ")}): ${last}`); }

  // ---------- persistent HTML tooltip (mNAV) ----------
  function getOrCreateTooltip(container, cls){
    let tt = container.querySelector(`.${cls}`);
    if (!tt) {
      tt = document.createElement("div");
      tt.className = cls;
      tt.style.cssText = [
        "position:absolute","pointer-events:none",
        "background:rgba(17,24,39,0.92)","color:#fff",
        "border:1px solid rgba(255,255,255,0.15)","border-radius:8px",
        "padding:6px 8px","font:12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,sans-serif",
        "white-space:nowrap","transform:translate(8px,-8px)","opacity:0","transition:opacity 60ms"
      ].join(";");
      container.appendChild(tt);
    }
    return tt;
  }

  // Smart tooltip placement: flip when near container edges
  function positionTooltip(tt, container, x, y){
    if (getComputedStyle(container).position === "static") container.style.position = "relative";

    // Prepare for measurement
    tt.style.visibility = "hidden";
    tt.style.opacity = 0;
    // reset any previous placement so size is natural
    tt.style.left = "0px";
    tt.style.top  = "0px";

    // Measure container and tooltip
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    // Force layout, then read size (fallbacks if not yet measurable)
    const tw = tt.offsetWidth || 180;
    const th = tt.offsetHeight || 40;

    // Decide flips
    const willOverflowRight = x + 8 + tw > cw;
    const willOverflowTop   = y - 8 - th < 0;

    const dx = willOverflowRight ? (-8 - tw) : 8;  // left side if would overflow right
    const dy = willOverflowTop   ? 8          : -8; // below cursor if would overflow top

    // Apply placement
    tt.style.transform = `translate(${dx}px,${dy}px)`;
    tt.style.left = `${x}px`;
    tt.style.top  = `${y}px`;
    tt.style.visibility = "";
    tt.style.opacity = 1;
  }
  function externalMNAVTooltip(context){
    const { chart, tooltip } = context;
    const container = chart.canvas.parentNode;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    const tt = getOrCreateTooltip(container, "mn-tooltip");
    if (tooltip.opacity === 0) { tt.style.opacity = 0; return; }
    const dp = tooltip.dataPoints?.[0];
    if (dp){
      const date = dp.label ?? "";
      const val  = dp.formattedValue ?? "";
      tt.innerHTML = `<div style="opacity:.8">${date}</div><div style="font-weight:600">${val}</div>`;
      positionTooltip(tt, container, tooltip.caretX, tooltip.caretY);
    }
  }

  // ---------- persistent HTML tooltip (ETF: bar vs line) ----------
  function externalETFTooltip(context){
    const { chart, tooltip } = context;
    const container = chart.canvas.parentNode;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    const tt = getOrCreateTooltip(container, "etf-tooltip");
    if (tooltip.opacity === 0) { tt.style.opacity = 0; return; }

    const idx = tooltip.dataPoints?.[0]?.dataIndex ?? null;
    const caretX = tooltip.caretX, caretY = tooltip.caretY;

    // Decide if we are over the bar rect
    let onBar = false;
    if (idx != null) {
      const barMeta = chart.getDatasetMeta(0); // dataset 0 = bars
      const el = barMeta?.data?.[idx];
      if (el) {
        const x = el.x;
        const half = (el.width ?? 0) / 2;
        const left = x - half, right = x + half;
        const top = Math.min(el.y, el.base ?? el.y);
        const bottom = Math.max(el.y, el.base ?? el.y);
        if (caretX >= left && caretX <= right && caretY >= top && caretY <= bottom) onBar = true;
      }
    }

    const date = tooltip.title?.[0] ?? tooltip.dataPoints?.[0]?.label ?? "";
    const daily = (idx!=null) ? chart.data.datasets[0]?.data?.[idx] : undefined;
    const cum   = (idx!=null) ? chart.data.datasets[1]?.data?.[idx] : undefined;
    const fmt = n => (typeof n === "number" && isFinite(n)) ? n.toLocaleString(undefined,{maximumFractionDigits:2}) : (n ?? "");

    tt.innerHTML = onBar
      ? `<div style="opacity:.8">${date}</div><div style="font-weight:600">Daily: ${fmt(daily)}</div>`
      : `<div style="opacity:.8">${date}</div><div style="font-weight:600">Cumulative: ${fmt(cum)}</div>`;

    tt.style.left = `${caretX}px`;
    tt.style.top  = `${caretY}px`;
    tt.style.opacity = 1;
  }

  // ---------- chart helpers ----------
  function lineChart(ctx, labels, values){
    return new Chart(ctx,{
      type:"line",
      data:{ labels, datasets:[{ label:"mNAV", data:values, tension:0.2, borderColor:"#ffffff", borderWidth:1, pointRadius:0 }] },
      options:{
        responsive:true, maintainAspectRatio:false,
        interaction:{ mode:"index", intersect:false, axis:"x" },
        plugins:{ legend:{display:false}, title:{display:false}, tooltip:{ enabled:false, external: externalMNAVTooltip } },
        scales:{ x:{ticks:{minRotation:45,maxRotation:45,autoSkip:true,maxTicksLimit:8}} }
      }
    });
  }
  function barLineChartETF(ctx, labels, bars, line){
    return new Chart(ctx,{
      type:"bar",
      data:{ labels,
        datasets:[
          { label:"Daily net flow", data:bars, yAxisID:"y", order:2,
            backgroundColor:(c)=>{const v=(c.raw ?? c.parsed?.y ?? 0); return (typeof v==="number"&&v<0)?"rgba(239,68,68,0.85)":"rgba(22,163,74,0.85)"; },
            borderColor:(c)=>{const v=(c.raw ?? c.parsed?.y ?? 0); return (typeof v==="number"&&v<0)?"rgba(220,38,38,1)":"rgba(21,128,61,1)"; },
            borderWidth:1 },
          { type:"line", label:"Cumulative", data:line, yAxisID:"y1", order:1,
            tension:0.2, borderWidth:1, borderColor:"#ffffff", pointRadius:0 }
        ]
      },
      options:{
        responsive:true, maintainAspectRatio:false,
        interaction:{ mode:"index", intersect:false, axis:"x" },
        plugins:{ legend:{display:false}, title:{display:false}, tooltip:{ enabled:false, external: externalETFTooltip } },
        scales:{
          y:{ position:"left", grid:{drawOnChartArea:true} },
          y1:{ position:"right", grid:{drawOnChartArea:false} },
          x:{ ticks:{ minRotation:45, maxRotation:45, autoSkip:true, maxTicksLimit:8 } }
        }
      }
    });
  }

  // ---------- mNAV ----------
  async function initMnav(){
    try{
      const {rows, path} = await loadAny(PATHS.dat, "dat_data.csv");
      const lc = rows.map(lower);
      const mnavRows = lc.filter(r => (r.metric||"").toLowerCase()==="mnav");
      if (!mnavRows.length) { banner("mNAV missing in dat_data.csv — ensure art_dat.py wrote metric='mnav' rows."); return; }

      const colToTicker = (k) => {
        const kk = String(k).toLowerCase();
        if (kk==="date"||kk==="metric") return null;
        for (const t of TICKERS) if (kk.includes(t.toLowerCase())) return t;
        const m = kk.match(/(mstr|mtplf|sbet|bmnr|dfdv|upxi)/);
        return m ? m[1].toUpperCase() : null;
      };

      const seriesMap = Object.fromEntries(TICKERS.map(t=>[t,[]]));
      for (const r of mnavRows){
        const date = fmtDate(r.date || r.dt || r.timestamp);
        if (!date) continue;
        for (const k of Object.keys(r)){
          const t = colToTicker(k); if (!t) continue;
          const v = toNum(r[k]);
          if (Number.isFinite(v)) seriesMap[t].push({date, val:v});
        }
      }
      for (const t of TICKERS) seriesMap[t].sort((a,b)=>a.date.localeCompare(b.date));

      banner(`mNAV source: ${path} • ` + TICKERS.map(t=>`${t}:${seriesMap[t].length}`).join("  "));

      const grid = $("#mnav-grid"); if (!grid) { banner("Missing #mnav-grid"); return; }
      grid.innerHTML = "";

      for (const tkr of TICKERS){
        const series = seriesMap[tkr];
        const card = el("div","card");
        const head = el("div","card-head"); head.textContent = `${tkr} — mNAV`;
        const btns = el("div","btns");
        const b1 = el("button"); b1.type="button"; b1.textContent="1M";
        const b3 = el("button"); b3.type="button"; b3.textContent="3M";
        const ba = el("button"); ba.type="button"; ba.textContent="All";
        head.appendChild(btns); btns.appendChild(b1); btns.appendChild(b3); btns.appendChild(ba);
        const box = el("div","chart"); const can = el("canvas"); box.appendChild(can);
        const cap = el("div","caption"); cap.textContent = "mNAV = (Price × Shares) ÷ NAV";
        card.appendChild(head); card.appendChild(box); card.appendChild(cap);
        if (!series.length){ const note=el("div","caption"); note.textContent="No mNAV points."; card.appendChild(note); }
        grid.appendChild(card);

        let days = 90, chart;  // default 3M
        const render = () => {
          const data = (days===Infinity)?series:lastN(series,days);
          const labels = data.map(d=>d.date);
          const vals = data.map(d=>d.val);
          if (chart) chart.destroy();
          chart = lineChart(can.getContext("2d"), labels, vals);
        };
        b1.addEventListener("click",()=>{days=30;render();});
        b3.addEventListener("click",()=>{days=90;render();});
        ba.addEventListener("click",()=>{days=Infinity;render();});
        render();
      }
    } catch (e) { banner(String(e)); }
  }
  // ---------- ETF ----------
  async function initEtf(){
    try{
      const {rows, path} = await loadAny(PATHS.etf, "etf_data.csv");
      if (!rows.length) throw new Error("etf_data.csv is empty");

      const normalized = rows.map(o => {
        const r = lower(o);
        const d = fmtDate(r.date||r.dt||r.timestamp);
        if (!d) return null;
        return { date:d, metric:(r.metric||"").toLowerCase(), btc:toNum(r.btc), eth:toNum(r.eth), raw:r };
      }).filter(Boolean);

      const byDate = {};
      for (const r of normalized){
        const rec = (byDate[r.date] ||= {btcDaily:undefined,ethDaily:undefined,btcCum:undefined,ethCum:undefined});
        if (r.metric.includes("net_flow")){ if(Number.isFinite(r.btc))rec.btcDaily=r.btc; if(Number.isFinite(r.eth))rec.ethDaily=r.eth; }
        else if (r.metric.includes("cumulative")){ if(Number.isFinite(r.btc))rec.btcCum=r.btc; if(Number.isFinite(r.eth))rec.ethCum=r.eth; }
        else if (!r.metric){
          const rr=r.raw; const keys=Object.keys(rr);
          const bTry=toNum(rr.btc_daily??rr.btc_net_flow_usd_millions??rr.btc_flow??rr.btc);
          const eTry=toNum(rr.eth_daily??rr.eth_net_flow_usd_millions??rr.eth_flow??rr.eth);
          const bSum=keys.filter(k=>/btc/.test(k)&&/(net|flow)/.test(k)&&!/cum|cumulative/.test(k)).map(k=>toNum(rr[k])).filter(Number.isFinite).reduce((a,b)=>a+b,0);
          const eSum=keys.filter(k=>/eth/.test(k)&&/(net|flow)/.test(k)&&!/cum|cumulative/.test(k)).map(k=>toNum(rr[k])).filter(Number.isFinite).reduce((a,b)=>a+b,0);
          if (Number.isFinite(bTry)||Number.isFinite(bSum)) rec.btcDaily=Number.isFinite(bTry)?bTry:bSum;
          if (Number.isFinite(eTry)||Number.isFinite(eSum)) rec.ethDaily=Number.isFinite(eTry)?eTry:eSum;
        }
      }

      const dates = Object.keys(byDate).sort();
      let bCum=0, startedB=false; const btc=[];
      for (const d of dates){ const r=byDate[d]; const has=Number.isFinite(r.btcDaily)||Number.isFinite(r.btcCum);
        if(!startedB&&!has) continue; if(!startedB) startedB=true;
        const daily=Number.isFinite(r.btcDaily)?r.btcDaily:0;
        if(Number.isFinite(r.btcCum)) bCum=r.btcCum; else bCum+=daily;
        btc.push({date:d,daily,cum:bCum});
      }

      const ETH_START="2024-07-23";
      let eCum=0, startedE=false; const eth=[];
      for (const d of dates){
        if (d < ETH_START) continue;
        const r=byDate[d]; const has=Number.isFinite(r.ethDaily)||Number.isFinite(r.ethCum);
        if(!startedE&&!has) continue; if(!startedE) startedE=true;
        const daily=Number.isFinite(r.ethDaily)?r.ethDaily:0;
        if(Number.isFinite(r.ethCum)) eCum=r.ethCum; else eCum+=daily;
        eth.push({date:d,daily,cum:eCum});
      }

      banner(`ETF source: ${path} • BTC:${btc.length} • ETH:${eth.length}`);

      const bctx=$("#btcChart")?.getContext("2d");
      const ectx=$("#ethChart")?.getContext("2d");
      if(!bctx || !ectx){ banner("Missing BTC/ETH canvas"); return; }

      // ensure All buttons exist
      (function ensureAll(){
        for (const p of ["btc","eth"]){
          const b1=document.querySelector(`[data-range="${p}-1m"]`); if(!b1) continue;
          const wrap=b1.parentElement;
          if(!wrap.querySelector(`[data-range="${p}-all"]`)){
            const all=document.createElement("button"); all.type="button"; all.textContent="All"; all.setAttribute("data-range",`${p}-all`); wrap.appendChild(all);
          }
        }
      })();

      let days=90;  // default 3M
      function render(){
        const bb=(days===Infinity)?btc:btc.slice(-days);
        const ee=(days===Infinity)?eth:eth.slice(-days);
        bctx.__chart && bctx.__chart.destroy();
        ectx.__chart && ectx.__chart.destroy();
        bctx.__chart = barLineChartETF(bctx, bb.map(r=>r.date), bb.map(r=>r.daily), bb.map(r=>r.cum));
        ectx.__chart = barLineChartETF(ectx, ee.map(r=>r.date), ee.map(r=>r.daily), ee.map(r=>r.cum));
      }
      const hook=(sel,val)=>{ const btn=document.querySelector(sel); if(btn) btn.addEventListener("click", ()=>{ days=val; render(); }); };
      hook('[data-range="btc-1m"]',30); hook('[data-range="btc-3m"]',90); hook('[data-range="btc-all"]',Infinity);
      hook('[data-range="eth-1m"]',30); hook('[data-range="eth-3m"]',90); hook('[data-range="eth-all"]',Infinity);
      render();
    } catch(e) { banner(String(e)); }
  }

  // ---------- boot ----------
  window.addEventListener("DOMContentLoaded", () => { initMnav(); initEtf(); });
})();
