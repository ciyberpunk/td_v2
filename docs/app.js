/* PC F1 — DATs + ETF Flows
   - mNAV: read metric=='mnav' from dat_data.csv (server-computed)
           custom external tooltip that persists & follows the mouse
   - ETF : signed daily bars + thin white cumulative line; 1M / 3M / All
           external tooltip: bar shows Daily; elsewhere shows Cumulative
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
  const fmtNum = n => Number.isFinite(+n) ? (+n).toLocaleString(undefined,{maximumFractionDigits:2}) : "";

  // console-only diagnostics (no UI banner)
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

  // ---------- reusable HTML tooltip (container-scoped) ----------
  function getOrCreateTooltip(container){
    let tt = container.querySelector(".mn-tooltip");
    if (!tt) {
      tt = document.createElement("div");
      tt.className = "mn-tooltip";
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

  // ---------- external tooltip: mNAV (always show line value under cursor) ----------
  function externalMNAVTooltip(context){
    const { chart, tooltip } = context;
    const container = chart.canvas.parentNode;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    const tt = getOrCreateTooltip(container);
    if (tooltip.opacity === 0) { tt.style.opacity = 0; return; }
    const dp = tooltip.dataPoints?.[0];
    if (!dp) { tt.style.opacity = 0; return; }
    const date = dp.label ?? "";
    const val  = dp.formattedValue ?? "";
    tt.innerHTML = `<div style="opacity:.8">${date}</div><div style="font-weight:600">${val}</div>`;
    tt.style.left = `${tooltip.caretX}px`;
    tt.style.top  = `${tooltip.caretY}px`;
    tt.style.opacity = 1;
  }

  // ---------- external tooltip: ETF (bar => Daily, else => Cumulative) ----------
  function externalETFTooltip(context){
    const { chart, tooltip } = context;
    const container = chart.canvas.parentNode;
    if (getComputedStyle(container).position === "static") container.style.position = "relative";
    const tt = getOrCreateTooltip(container);
    if (tooltip.opacity === 0) { tt.style.opacity = 0; return; }

    const dp = tooltip.dataPoints?.[0];
    if (!dp) { tt.style.opacity = 0; return; }
    const i = dp.dataIndex;
    const labels = chart.data.labels || [];
    const date = labels[i] || "";

    // datasets: 0 = bars (daily), 1 = line (cumulative)
    const barDS  = chart.data.datasets?.[0];
    const lineDS = chart.data.datasets?.[1];
    const daily = Number(barDS?.data?.[i]);
    const cum   = Number(lineDS?.data?.[i]);

    // determine if cursor is *inside* the bar rectangle
    let overBar = false;
    try {
      const meta = chart.getDatasetMeta(0);
      const el = meta?.data?.[i];
      if (el) {
        const { x, y, base, width, height } = el.getProps(["x","y","base","width","height"], true);
        const left = x - width/2, right = x + width/2;
        const top = Math.min(y, base), bottom = Math.max(y, base);
        const cx = tooltip.caretX, cy = tooltip.caretY;
        overBar = cx >= left && cx <= right && cy >= top && cy <= bottom;
      }
    } catch {}

    if (overBar && Number.isFinite(daily)) {
      tt.innerHTML = `<div style="opacity:.8">${date}</div><div style="font-weight:600">Daily: ${fmtNum(daily)}</div>`;
    } else {
      tt.innerHTML = `<div style="opacity:.8">${date}</div><div style="font-weight:600">Cumulative: ${fmtNum(cum)}</div>`;
    }

    tt.style.left = `${tooltip.caretX}px`;
    tt.style.top  = `${tooltip.caretY}px`;
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
        plugins:{
          legend:{display:false}, title:{display:false},
          tooltip:{ enabled:false, external: externalMNAVTooltip }
        },
        scales:{ x:{ticks:{minRotation:45,maxRotation:45,autoSkip:true,maxTicksLimit:8}} }
      }
    });
  }
