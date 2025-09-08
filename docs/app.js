/* td_v2 frontend (robust) — mNAV = (Price × num_of_shares) / NAV */
(() => {
  "use strict";

  const DESIRED_TICKERS = ["MSTR","MTPLF","SBET","BMNR","DFDV","UPXI"];
  const CSV_CANDIDATES = {
    dat: ["data/dat_data.csv","Data/dat_data.csv"],
    etf: ["data/etf_data.csv","Data/etf_data.csv"],
  };

  const $ = (s) => document.querySelector(s);
  const el = (t,c) => Object.assign(document.createElement(t), c?{className:c}:{});
  const fmtDate = (d) => { const x = (d instanceof Date) ? d : new Date(d); return isNaN(+x) ? "" : x.toISOString().slice(0,10); };
  const lastNDays = (arr,n) => arr.slice(-n);

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

  // ---------- CSV loader (tries multiple locations) ----------
  function loadCSVOnce(path) {
    return new Promise((resolve, reject) => {
      if (!window.Papa) return reject(new Error("Papa Parse not loaded"));
      Papa.parse(path, {
        download: true, header: true, dynamicTyping: true, skipEmptyLines: true,
        complete: (res) => {
          const { data, errors } = res || {};
          if (errors && errors.length) return reject(new Error(`CSV parse error for ${path}: ${errors[0].message || "unknown"}`));
          resolve({ rows: (data||[]).filter(Boolean), path });
        },
        error: (err) => reject(new Error(`CSV network error for ${path}: ${err?.message || err}`)),
      });
    });
  }
  async function loadCSVAny(candidates, label) {
    let lastErr;
    for (const p of candidates) { try { return await loadCSVOnce(p); } catch (e) { lastErr = e; } }
    throw new Error(`${label}: none of [${candidates.join(", ")}] worked → ${lastErr?.message || lastErr}`);
  }

  // ---------- Helpers to normalize columns / tickers ----------
  const lowerKeys = (o) => Object.fromEntries(Object.entries(o).map(([k,v]) => [String(k).toLowerCase(), v]));

  // pick a numeric field by trying exact candidates, then fuzzy "contains"
  function pickNum(rowLower, exactList, fuzzyList = []) {
    for (const k of exactList) if (rowLower[k] !== undefined && Number.isFinite(+rowLower[k])) return +rowLower[k];
    for (const frag of fuzzyList) {
      const key = Object.keys(rowLower).find(kk => kk.includes(frag));
      if (key && Number.isFinite(+rowLower[key])) return +rowLower[key];
    }
    return NaN;
  }

  // Map any messy ticker (e.g., "EQ MSTR", "MSTR US Equity") to one of our 6
  function mapTicker(raw) {
    if (!raw) return "";
    const S = String(raw).toUpperCase();
    for (const want of DESIRED_TICKERS) if (S.includes(want)) return want; // substring catch-all
    // fallback: strip EQ prefixes & non-alnum, take first token
    let s = S.replace(/^EQ[:\s-]+/,"").replace(/EQUITY/g,"").replace(/[\.\-:]/g," ").trim();
    let tok = s.split(/\s+/)[0].replace(/[^A-Z0-9]/g,"");
    return DESIRED_TICKERS.includes(tok) ? tok : "";
  }

  // ---------- Chart factories ----------
  function makeLine(ctx, labels, values, label) {
    return new Chart(ctx, {
      type: "line",
      data: { labels, datasets: [{ label, data: values, tension: 0.2 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins:{ legend:{ display:false } },
                 scales: { x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } } } }
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
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, title: { display: !!title, text: title } },
        scales: {
          y:  { position: "left",  grid: { drawOnChartArea: true } },
          y1: { position: "right", grid: { drawOnChartArea: false } },
          x:  { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        },
      },
    });
  }

  // ---------- mNAV ----------
  async function initMnav() {
    try {
      const { rows, path } = await loadCSVAny(CSV_CANDIDATES.dat, "dat_data.csv");
      const outCounts = {};
      const norm = rows.map(orig => {
        const r = lowerKeys(orig);
        const date = r.date || r.dt || r.timestamp;
        const ticker = mapTicker(r.ticker || r.symbol || r.eq_ticker || r.asset || r.name);
        const price = pickNum(r,
          ["price","close","px_last","last"],
          ["price","close","px_last","last"]);
        const shares = pickNum(r,
          ["num_of_shares","num_shares","nums","shares","shares_outstanding","shares_basic","shares_out","sharecount"],
          ["num_of_shares","num_shares","shares_outstanding","shares_basic","shares"]);
        const nav = pickNum(r,
          ["nav","nav_usd","net_asset_value"],
          ["nav"]);
        const mnav = (Number.isFinite(price) && Number.isFinite(shares) && Number.isFinite(nav) && nav !== 0)
          ? (price * shares) / nav
          : NaN;
        if (ticker) outCounts[ticker] = (outCounts[ticker] || 0) + (Number.isFinite(mnav) ? 1 : 0);
        return { date: fmtDate(date), ticker, mnav };
      })
      .filter(x => x.date && x.ticker && Number.isFinite(x.mnav))
      .sort((a,b) => a.date.localeCompare(b.date));

      // dedup per (ticker,date)
      const dedupMap = new Map();
      for (const r of norm) dedupMap.set(`${r.ticker}__${r.date}`, r);
      const dedup = Array.from(dedupMap.values());

      // group to our fixed ticker order
      const grouped = Object.fromEntries(DESIRED_TICKERS.map(t => [t, []]));
      for (const r of dedup) if (grouped[r.ticker]) grouped[r.ticker].push(r);

      diag(`mNAV source: ${path} • points → ` + DESIRED_TICKERS.map(t => `${t}:${(grouped[t]||[]).length}`).join("  "));

      const grid = $("#mnav-grid"); if (!grid) { diag("Missing #mnav-grid"); return; }
      grid.innerHTML = "";

      for (const tkr of DESIRED_TICKERS) {
        const series = grouped[tkr] || [];
        const card = el("div","card");
        const head = el("div","card-head"); head.textContent = `${tkr} — mNAV`;
        const btns = el("div","btns");
        const b1 = el("button"); b1.type="button"; b1.textContent = "1M";
        const b3 = el("button"); b3.type="button"; b3.textContent = "3M";
        head.appendChild(btns); btns.appendChild(b1); btns.appendChild(b3);

        const chartBox = el("div","chart"); const can = el("canvas"); chartBox.appendChild(can);
        const caption = el("div","caption"); caption.textContent = "mNAV = (Price × Number of Shares) ÷ NAV";
        card.appendChild(head); card.appendChild(chartBox); card.appendChild(caption);
        if (!series.length) { const note = el("div","caption"); note.textContent = "No data found for this ticker in CSV."; card.appendChild(note); }
        grid.appendChild(card);

        let rangeDays = 30, chart;
        const render = () => {
          const labels = lastNDays(series.map(d => d.date),  rangeDays);
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

  // ---------- ETF Flows ----------
  async function initEtf() {
    try {
      const { rows, path } = await loadCSVAny(CSV_CANDIDATES.etf, "etf_data.csv");
      const base = rows.map(o => {
        const r = lowerKeys(o);
        const date = r.date || r.dt || r.timestamp;
        const btcDaily = +(r.btc_daily ?? r.btc_net ?? r.btc ?? r.btc_sum ?? r.btc_flow ?? 0);
        const ethDaily = +(r.eth_daily ?? r.eth_net ?? r.eth ?? r.eth_sum ?? r.eth_flow ?? 0);
        return { date: fmtDate(date), btcDaily, ethDaily };
      }).filter(r => r.date).sort((a,b) => a.date.localeCompare(b.date));

      // all-time cumulative
      let bCum = 0, eCum = 0;
      const withCum = base.map(r => { bCum += r.btcDaily; eCum += r.ethDaily; return { ...r, btcCum: bCum, ethCum: eCum }; });

      diag(`ETF source: ${path} • rows: ${withCum.length}`);

      const btcCtx = $("#btcChart")?.getContext("2d");
      const ethCtx = $("#ethChart")?.getContext("2d");
      if (!btcCtx || !ethCtx) { diag("Missing BTC/ETH canvas elements."); return; }

      let rangeDays = 30;
      function render() {
        const sliced = withCum.slice(-rangeDays);
        const labels = sliced.map(r => r.date);
        const btcBar = sliced.map(r => r.btcDaily);
        const btcLine = sliced.map(r => r.btcCum);
        const ethBar = sliced.map(r => r.ethDaily);
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
