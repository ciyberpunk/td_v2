/* td_v2 frontend — strict mNAV + ETF flows
   - mNAV: (Price × num_of_shares) ÷ NAV
   - ETF: bars = signed daily net flow; line = all-time cumulative
   - Number parsing handles commas, $, %, Unicode minus, and (123) negatives
*/
(() => {
  "use strict";

  const DESIRED_TICKERS = ["MSTR","MTPLF","SBET","BMNR","DFDV","UPXI"];
  const CSV_CANDIDATES = {
    dat: ["data/dat_data.csv","Data/dat_data.csv"],
    etf: ["data/etf_data.csv","Data/etf_data.csv"],
  };

  // ---------- tiny DOM helpers ----------
  const $ = (s) => document.querySelector(s);
  const el = (t,c) => Object.assign(document.createElement(t), c?{className:c}:{});
  const fmtDate = (d) => { const x = (d instanceof Date)? d : new Date(d); return isNaN(+x) ? "" : x.toISOString().slice(0,10); };
  const lastNDays = (a,n) => a.slice(-n);

  function diag(msg) {
    let bar = $("#diag"); if (!bar) {
      bar = el("div","diag");
      bar.id = "diag";
      bar.style.cssText = "margin:8px 0 16px;padding:8px 12px;border-radius:10px;background:#2a1b1b;color:#f6dada;font:12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
      const container = document.querySelector(".container") || document.body;
      container.insertBefore(bar, container.firstChild.nextSibling);
    }
    bar.textContent = msg;
    console.warn("[td_v2]", msg);
  }

  // ---------- robust number parsing ----------
  function toNumber(v) {
    if (v === null || v === undefined) return NaN;
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    let s = String(v).trim();
    if (!s) return NaN;
    s = s.replace(/\u2212/g,"-");     // Unicode minus → hyphen minus
    if (/^\(.*\)$/.test(s)) s = "-" + s.slice(1, -1); // (123) → -123
    s = s.replace(/[\$,]/g,"");       // remove $ and thousands commas
    s = s.replace(/%/g,"");           // drop % if any
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  }

  // ---------- CSV loader ----------
  function loadCSV(path) {
    return new Promise((resolve, reject) => {
      if (!window.Papa) return reject(new Error("Papa Parse not loaded"));
      Papa.parse(path, {
        download: true, header: true, dynamicTyping: false, skipEmptyLines: true, // dynamicTyping off → we control parsing
        complete: (res) => {
          const { data, errors } = res || {};
          if (errors && errors.length) return reject(new Error(`CSV parse error for ${path}: ${errors[0].message || "unknown"}`));
          resolve((data||[]).filter(Boolean));
        },
        error: (err) => reject(new Error(`CSV network error for ${path}: ${err?.message || err}`)),
      });
    });
  }
  async function loadCSVAny(paths,label){let e; for(const p of paths){try{return {rows:await loadCSV(p), path:p}}catch(err){e=err}} throw new Error(`${label}: none of [${paths.join(", ")}] worked → ${e?.message||e}`);}

  // ---------- charts ----------
  function makeLine(ctx, labels, values, label) {
    return new Chart(ctx, {
      type: "line",
      data: { labels, datasets: [{ label, data: values, tension: 0.2 }] },
      options: { responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}},
                 scales:{ x:{ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:8}} } }
    });
  }
  function dualAxisChart(ctx, labels, bars, line, title) {
    return new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Daily net flow", data: bars, yAxisID: "y", order: 2 },
          { type: "line", label: "Cumulative (all-time)", data: line, yAxisID: "y1", tension: 0.2, order: 1 },
        ],
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{legend:{position:"bottom"}, title:{display:!!title, text:title}},
        scales:{
          y:{ position:"left", grid:{drawOnChartArea:true} },
          y1:{ position:"right", grid:{drawOnChartArea:false} },
          x:{ ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:8} },
        },
      },
    });
  }

  // ---------- helpers ----------
  const lowerKeys = (o) => Object.fromEntries(Object.entries(o).map(([k,v]) => [String(k).toLowerCase(), v]));
  const pick = (obj, keys) => { for (const k of keys) if (obj[k] !== undefined) return obj[k]; return undefined; };
  const mapTicker = (raw) => {
    if (!raw) return "";
    const S = String(raw).toUpperCase().replace(/^EQ[:\s-]+/,"");
    for (const want of DESIRED_TICKERS) if (S.includes(want)) return want;
    const tok = S.replace(/EQUITY/g,"").replace(/[^A-Z0-9]/g," ").trim().split(/\s+/)[0];
    return DESIRED_TICKERS.includes(tok) ? tok : "";
  };

  // ---------- mNAV ----------
  async function initMnav() {
    try {
      const { rows, path } = await loadCSVAny(CSV_CANDIDATES.dat, "dat_data.csv");

      const norm = rows.map(o => {
        const r = lowerKeys(o);
        const date = pick(r, ["date","dt","timestamp","asof","as_of"]);
        const ticker = mapTicker(pick(r, ["ticker","symbol","eq_ticker","asset","name"]));

        const price  = toNumber(pick(r, ["price","close","px_last","last"]));
        const shares = toNumber(pick(r, [
          "num_of_shares","num_shares","nums","shares","shares_outstanding","shares_basic","shares_out","sharecount"
        ]));
        const nav    = toNumber(pick(r, ["nav","nav_usd","net_asset_value"]));

        const mnav = (Number.isFinite(price) && Number.isFinite(shares) && Number.isFinite(nav) && nav !== 0)
                       ? (price * shares) / nav : NaN;
        return { date: fmtDate(date), ticker, mnav };
      })
      .filter(x => x.date && x.ticker && Number.isFinite(x.mnav))
      .sort((a,b) => a.date.localeCompare(b.date));

      // dedup per (ticker,date)
      const byTD = new Map();
      for (const r of norm) byTD.set(`${r.ticker}__${r.date}`, r);
      const dedup = Array.from(byTD.values());

      // group to fixed 6 tickers
      const grouped = Object.fromEntries(DESIRED_TICKERS.map(t => [t, []]));
      for (const r of dedup) if (grouped[r.ticker]) grouped[r.ticker].push(r);

      // counts banner
      diag(`mNAV source: ${path} • points → ` + DESIRED_TICKERS.map(t => `${t}:${(grouped[t]||[]).length}`).join("  "));

      const grid = $("#mnav-grid"); if (!grid) { diag("Missing #mnav-grid"); return; }
      grid.innerHTML = "";

      for (const tkr of DESIRED_TICKERS) {
        const series = grouped[tkr] || [];
        const card = el("div","card");
        const head = el("div","card-head"); head.textContent = `${tkr} — mNAV`;
        const btns = el("div","btns"), b1 = el("button"), b3 = el("button");
        b1.type="button"; b3.type="button"; b1.textContent="1M"; b3.textContent="3M";
        head.appendChild(btns); btns.appendChild(b1); btns.appendChild(b3);
        const chartBox = el("div","chart"), can = el("canvas"); chartBox.appendChild(can);
        const caption = el("div","caption"); caption.textContent = "mNAV = (Price × Number of Shares) ÷ NAV";
        card.appendChild(head); card.appendChild(chartBox); card.appendChild(caption);
        if (!series.length) { const note = el("div","caption"); note.textContent = "No data found for this ticker in CSV."; card.appendChild(note); }
        grid.appendChild(card);

        let rangeDays = 30, chart;
        const render = () => {
          const labels = lastNDays(series.map(d => d.date), rangeDays);
          const vals   = lastNDays(series.map(d => d.mnav), rangeDays);
          if (chart) chart.destroy();
          chart = makeLine(can.getContext("2d"), labels, vals, "mNAV");
        };
        b1.addEventListener("click", () => { rangeDays = 30; render(); });
        b3.addEventListener("click", () => { rangeDays = 90; render(); });
        render();
      }
    } catch (err) { diag(String(err)); }
  }

  // ---------- ETF Flows (strict) ----------
  async function initEtf() {
    try {
      const { rows, path } = await loadCSVAny(CSV_CANDIDATES.etf, "etf_data.csv");

      // Flexible header mapping; we only trust "daily" and compute cumulative ourselves.
      const base = rows.map(o => {
        const r = lowerKeys(o);
        const date = pick(r, ["date","dt","timestamp"]);
        const btcDaily = toNumber(
          pick(r, ["btc_net_flow_usd_millions","btc_daily","btc_flow","btc"])
        );
        const ethDaily = toNumber(
          pick(r, ["eth_net_flow_usd_millions","eth_daily","eth_flow","eth"])
        );
        return { date: fmtDate(date), btcDaily, ethDaily };
      })
      .filter(r => r.date && (Number.isFinite(r.btcDaily) || Number.isFinite(r.ethDaily)))
      .sort((a,b) => a.date.localeCompare(b.date));

      // all-time cumulative (signed)
      let bCum = 0, eCum = 0;
      const withCum = base.map(r => {
        bCum += (Number.isFinite(r.btcDaily) ? r.btcDaily : 0);
        eCum += (Number.isFinite(r.ethDaily) ? r.ethDaily : 0);
        return { ...r, btcCum: bCum, ethCum: eCum };
      });

      diag(`ETF source: ${path} • rows: ${withCum.length}`);

      const btcCtx = $("#btcChart")?.getContext("2d");
      const ethCtx = $("#ethChart")?.getContext("2d");
      if (!btcCtx || !ethCtx) { diag("Missing BTC/ETH canvas elements."); return; }

      let rangeDays = 30;
      function render() {
        const sliced = withCum.slice(-rangeDays);
        const labels = sliced.map(r => r.date);

        const btcBar  = sliced.map(r => Number.isFinite(r.btcDaily) ? r.btcDaily : 0);
        const btcLine = sliced.map(r => r.btcCum);
        const ethBar  = sliced.map(r => Number.isFinite(r.ethDaily) ? r.ethDaily : 0);
        const ethLine = sliced.map(r => r.ethCum);

        btcCtx.__chart && btcCtx.__chart.destroy();
        ethCtx.__chart && ethCtx.__chart.destroy();
        btcCtx.__chart = dualAxisChart(btcCtx, labels, btcBar, btcLine, "BTC ETF Flows");
        ethCtx.__chart = dualAxisChart(ethCtx, labels, ethBar, ethLine, "ETH ETF Flows");
      }
      const hook = (sel, days) => { const b = document.querySelector(sel); if (b) b.addEventListener("click", () => { rangeDays = days; render(); }); };
      hook('[data-range="btc-1m"]', 30); hook('[data-range="btc-3m"]', 90);
      hook('[data-range="eth-1m"]', 30); hook('[data-range="eth-3m"]', 90);
      render();
    } catch (err) { diag(String(err)); }
  }

  window.addEventListener("DOMContentLoaded", () => { initMnav(); initEtf(); });
})();
