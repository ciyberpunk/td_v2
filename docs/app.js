/* td_v2 frontend — mNAV + ETF Flows
   - mNAV charts (6 tickers, fixed order): MSTR, MTPLF, SBET, BMNR, DFDV, UPXI
   - Compute mNAV locally: (Price * Fully Diluted Shares) / NAV
   - ETF charts: daily bars + cumulative line (cumulative across full history)
   - Robust CSV parsing; tolerant to header variants; removes 'EQ ' / 'EQ:' prefixes
*/
(() => {
  "use strict";

  const DESIRED_TICKERS = ["MSTR","MTPLF","SBET","BMNR","DFDV","UPXI"];

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls) => Object.assign(document.createElement(tag), cls ? { className: cls } : {});
  const fmtDate = (d) => {
    const x = (d instanceof Date) ? d : new Date(d);
    return isNaN(+x) ? "" : x.toISOString().slice(0,10);
  };
  const lastNDays = (arr,n) => arr.slice(-n);
  const cleanTicker = (t) => String(t || "").replace(/^EQ[:\s]+/i,"").trim().toUpperCase();

  function diag(msg) {
    let bar = $("#diag");
    if (!bar) {
      bar = el("div","diag");
      bar.id = "diag";
      bar.style.cssText = "margin:8px 0 16px;padding:8px 12px;border-radius:10px;background:#2a1b1b;color:#f6dada;font:12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
      const container = document.querySelector(".container") || document.body;
      container.insertBefore(bar, container.firstChild.nextSibling);
    }
    bar.textContent = msg;
    console.warn("[td_v2]", msg);
  }

  // ---------- CSV loader ----------
  function loadCSV(relPath) {
    return new Promise((resolve, reject) => {
      if (!window.Papa) return reject(new Error("Papa Parse not loaded"));
      Papa.parse(relPath, {
        download: true,
        header: true,
        dynamicTyping: true,
        skipEmptyLines: true,
        complete: (res) => {
          const { data, errors } = res || {};
          if (errors && errors.length) {
            return reject(new Error(`CSV parse error for ${relPath}: ${errors[0].message || "unknown"}`));
          }
          resolve((data || []).filter(Boolean));
        },
        error: (err) => reject(new Error(`CSV network error for ${relPath}: ${err?.message || err}`)),
      });
    });
  }

  // ---------- Chart factory ----------
  function makeLine(ctx, labels, values, label) {
    if (!window.Chart) { diag("Chart.js not loaded"); return null; }
    return new Chart(ctx, {
      type: "line",
      data: { labels, datasets: [{ label, data: values, tension: 0.2 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins:{ legend:{ display:false } },
        scales: { x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } } },
      }
    });
  }

  function dualAxisChart(ctx, labels, bars, line, title) {
    if (!window.Chart) { diag("Chart.js not loaded"); return null; }
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
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom" }, title: { display: !!title, text: title } },
        scales: {
          y:  { position: "left",  grid: { drawOnChartArea: true } },
          y1: { position: "right", grid: { drawOnChartArea: false } },
          x:  { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        },
      },
    });
  }

  // ---------- mNAV section ----------
  async function initMnav() {
    try {
      const rows = await loadCSV("data/dat_data.csv");
      if (!rows.length) throw new Error("dat_data.csv is empty");

      // Map various possible headers → unified fields
      const normalize = (r) => {
        const date = r.date ?? r.Date ?? r.dt ?? r.Dt;
        // ticker can be like "EQ MSTR", "EQ:MSTR", etc.
        const rawT = r.ticker ?? r.Ticker ?? r.symbol ?? r.Symbol ?? r.eq_ticker ?? r.asset;
        const ticker = cleanTicker(rawT);

        // price variants
        const price = +(
          r.price ?? r.Price ?? r.close ?? r.Close ?? r.last ?? r.Last ?? r.px_last ?? r.PX_LAST
        );

        // fully diluted shares variants
        const fds = +(
          r.fully_diluted_shares ?? r.FullyDilutedShares ?? r.fullyDilutedShares ?? r.FDS ??
          r.FD_shares ?? r.shares_fd ?? r.shares_fully_diluted ?? r.NUM_OF_SHARES ?? r.num_of_shares ?? r.num_shares
        );

        // NAV variants
        const nav = +(
          r.nav ?? r.NAV ?? r.net_asset_value ?? r.NetAssetValue
        );

        // fallback precomputed mnav if present
        const fallback_mnav = +(
          r.mnav ?? r.MNAV ?? r.value ?? r.Value
        );

        const mnav = (Number.isFinite(price) && Number.isFinite(fds) && Number.isFinite(nav) && nav !== 0)
          ? (price * fds) / nav
          : (Number.isFinite(fallback_mnav) ? fallback_mnav : NaN);

        return {
          date: fmtDate(date),
          ticker,
          price, fds, nav,
          mnav
        };
      };

      // Normalize and keep only rows with useful info + desired tickers
      let norm = rows.map(normalize)
        .filter(r => r.date && r.ticker && DESIRED_TICKERS.includes(r.ticker) && Number.isFinite(r.mnav))
        .sort((a,b) => a.date.localeCompare(b.date));

      // Deduplicate per (ticker, date) → keep the last observation for the date
      const byTD = new Map();
      for (const r of norm) byTD.set(`${r.ticker}__${r.date}`, r);
      norm = Array.from(byTD.values()).sort((a,b) => (a.ticker===b.ticker? a.date.localeCompare(b.date) : a.ticker.localeCompare(b.ticker)));

      // group per ticker preserving DESIRED_TICKERS order
      const grouped = Object.fromEntries(DESIRED_TICKERS.map(t => [t, []]));
      for (const r of norm) grouped[r.ticker].push(r);

      const grid = $("#mnav-grid");
      if (!grid) { diag("Missing #mnav-grid"); return; }

      for (const tkr of DESIRED_TICKERS) {
        const series = grouped[tkr] || [];
        if (!series.length) {
          // render empty card with note
          const card = el("div","card"); 
          const head = el("div","card-head"); head.textContent = `${tkr} — mNAV`;
          const note = el("div","caption"); note.textContent = "No data found for this ticker.";
          const chartBox = el("div","chart"); const can = el("canvas"); chartBox.appendChild(can);
          card.appendChild(head); card.appendChild(chartBox); card.appendChild(note); grid.appendChild(card);
          continue;
        }

        const card = el("div","card");
        const head = el("div","card-head"); head.textContent = `${tkr} — mNAV`;
        const btns = el("div","btns");
        const b1 = el("button"); b1.type="button"; b1.textContent = "1M";
        const b3 = el("button"); b3.type="button"; b3.textContent = "3M";
        head.appendChild(btns); btns.appendChild(b1); btns.appendChild(b3);

        const chartBox = el("div","chart"); const can = el("canvas"); chartBox.appendChild(can);
        const caption = el("div","caption"); caption.textContent = "mNAV = (Price × Fully Diluted Shares) ÷ NAV";
        card.appendChild(head); card.appendChild(chartBox); card.appendChild(caption);
        grid.appendChild(card);

        // renderer
        let rangeDays = 30;
        let chart;
        const render = () => {
          const data = series;
          const labelsFull = data.map(d => d.date);
          const valsFull = data.map(d => d.mnav);
          const labels = lastNDays(labelsFull, rangeDays);
          const vals = lastNDays(valsFull, rangeDays);
          if (chart) chart.destroy();
          chart = makeLine(can.getContext("2d"), labels, vals, "mNAV");
        };
        b1.addEventListener("click", () => { rangeDays = 30; render(); });
        b3.addEventListener("click", () => { rangeDays = 90; render(); });
        render();
      }
    } catch (err) {
      diag(String(err));
    }
  }

  // ---------- ETF Flows section ----------
  async function initEtf() {
    try {
      const rows = await loadCSV("data/etf_data.csv");
      if (!rows.length) throw new Error("etf_data.csv is empty");

      const norm = rows.map(r => {
        const date = r.date ?? r.Date ?? r.dt;
        const btcDaily = +(r.btc_daily ?? r.btc_net ?? r.btc ?? r.BTC ?? r.btc_sum ?? 0);
        const ethDaily = +(r.eth_daily ?? r.eth_net ?? r.eth ?? r.ETH ?? r.eth_sum ?? 0);
        return { date: fmtDate(date), btcDaily, ethDaily };
      }).filter(r => r.date).sort((a,b) => a.date.localeCompare(b.date));

      // Cumulative across the entire dataset (not just the window)
      let bCum = 0, eCum = 0;
      const withCum = norm.map(r => {
        bCum += r.btcDaily; eCum += r.ethDaily;
        return { ...r, btcCum: bCum, ethCum: eCum };
      });

      const btcCtx = $("#btcChart")?.getContext("2d");
      const ethCtx = $("#ethChart")?.getContext("2d");
      if (!btcCtx || !ethCtx) { diag("Missing BTC/ETH canvas elements."); return; }

      let rangeDays = 30;
      function render() {
        const sliced = withCum.slice(-rangeDays);
        const labels = sliced.map(r => r.date);
        const btcBar = sliced.map(r => r.btcDaily);
        const btcLine = sliced.map(r => r.btcCum); // still all-time cumulative values within the view
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
    } catch (err) {
      diag(String(err));
    }
  }

  // ---------- init ----------
  window.addEventListener("DOMContentLoaded", () => {
    initMnav();
    initEtf();
  });
})();
