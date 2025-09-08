/* td_v2 — frontend loader (Charts + Papa)
   - Relative paths for GitHub Pages (no leading '/')
   - Defensive CSV parsing & schema auto-detect
   - 1M / 3M toggles
   - Small diagnostics banner on errors
*/
(() => {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const el = (t,c) => Object.assign(document.createElement(t), c?{className:c}:{});
  const fmtDate = (d) => {
    if (!d) return "";
    const x = (d instanceof Date) ? d : new Date(d);
    return isNaN(+x) ? "" : x.toISOString().slice(0,10);
  };
  const lastNDays = (arr, n) => arr.slice(-n);

  function diag(msg) {
    let bar = $("#diag");
    if (!bar) {
      bar = el("div","diag");
      bar.id = "diag";
      bar.style.cssText = "margin:8px 0;padding:8px 12px;border-radius:10px;background:#2a1b1b;color:#f6dada;font:12px/1.3 system-ui,-apple-system,Segoe UI,Roboto,sans-serif";
      const hdr = document.querySelector("h1,header,main") || document.body;
      hdr.parentNode.insertBefore(bar, hdr.nextSibling);
    }
    bar.textContent = msg;
    console.warn("[td_v2]", msg);
  }

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

  function dualAxisChart(ctx, labels, bars, line, title) {
    if (!window.Chart) { diag("Chart.js not loaded"); return null; }
    return new Chart(ctx, {
      type: "bar",
      data: {
        labels,
        datasets: [
          { label: "Daily net flow", data: bars, yAxisID: "y", order: 2 },
          { type: "line", label: "Cumulative", data: line, yAxisID: "y1", tension: 0.2, order: 1 },
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

  async function initEtf() {
    try {
      const rows = await loadCSV("data/etf_data.csv");
      if (!rows.length) throw new Error("etf_data.csv is empty");

      const norm = rows.map(r => {
        const date = r.date ?? r.Date ?? r.dt;
        const btcDaily = r.btc_daily ?? r.btc_net ?? r.btc ?? r.BTC ?? r.btc_sum;
        const ethDaily = r.eth_daily ?? r.eth_net ?? r.eth ?? r.ETH ?? r.eth_sum;
        const btcCum   = r.btc_cum   ?? r.btc_cumulative ?? r.BTC_cum;
        const ethCum   = r.eth_cum   ?? r.eth_cumulative ?? r.ETH_cum;
        return { date: fmtDate(date), btcDaily: +btcDaily || 0, ethDaily: +ethDaily || 0, btcCum, ethCum };
      }).filter(r => r.date).sort((a,b) => a.date.localeCompare(b.date));

      // Compute cumulative if missing
      let b=0,e=0;
      for (const r of norm) {
        b += r.btcDaily; e += r.ethDaily;
        if (typeof r.btcCum !== "number") r.btcCum = b;
        if (typeof r.ethCum !== "number") r.ethCum = e;
      }

      const btcCtx = $("#btcChart")?.getContext("2d");
      const ethCtx = $("#ethChart")?.getContext("2d");
      if (!btcCtx || !ethCtx) { diag("Missing BTC/ETH canvas elements."); return; }

      let rangeDays = 30;
      function render() {
        const sliced = lastNDays(norm, rangeDays);
        const labels = sliced.map(r => r.date);
        const btcBar = sliced.map(r => r.btcDaily);
        const btcLin = sliced.map(r => r.btcCum);
        const ethBar = sliced.map(r => r.ethDaily);
        const ethLin = sliced.map(r => r.ethCum);
        btcCtx.__chart && btcCtx.__chart.destroy();
        ethCtx.__chart && ethCtx.__chart.destroy();
        btcCtx.__chart = dualAxisChart(btcCtx, labels, btcBar, btcLin, "BTC ETF Flows");
        ethCtx.__chart = dualAxisChart(ethCtx, labels, ethBar, ethLin, "ETH ETF Flows");
      }
      const hook = (sel, days) => { const b = document.querySelector(sel); if (b) b.addEventListener("click", () => { rangeDays = days; render(); }); };
      hook('[data-range="btc-1m"]', 30); hook('[data-range="btc-3m"]', 90);
      hook('[data-range="eth-1m"]', 30); hook('[data-range="eth-3m"]', 90);
      render();
    } catch (err) { diag(String(err)); }
  }

  async function initMnav() {
    try {
      const rows = await loadCSV("data/dat_data.csv");
      if (!rows.length) throw new Error("dat_data.csv is empty");

      let long = [];
      if (rows[0].ticker || rows[0].Ticker) {
        for (const r of rows) {
          long.push({
            date: fmtDate(r.date || r.Date),
            ticker: String(r.ticker || r.Ticker || "").trim(),
            mnav: +(r.mnav ?? r.MNAV ?? r.value ?? r.Value),
          });
        }
      } else {
        const keys = Object.keys(rows[0] || {}).filter(k => !/^date$/i.test(k));
        for (const r of rows) {
          for (const k of keys) {
            long.push({ date: fmtDate(r.date || r.Date), ticker: k, mnav: +r[k] || 0 });
          }
        }
      }
      long = long.filter(d => d.date && d.ticker && Number.isFinite(d.mnav))
                 .sort((a,b) => a.date.localeCompare(b.date));

      const byTicker = {};
      for (const r of long) (byTicker[r.ticker] ||= []).push(r);

      const grid = $("#mnav-grid");
      if (!grid) { diag("Missing #mnav-grid element."); return; }

      for (const [ticker, series] of Object.entries(byTicker)) {
        const card = el("div","card");
        const head = el("div","card-head"); head.textContent = `${ticker} — mNAV`;
        const btns = el("div","btns");
        const b1 = el("button"); b1.textContent = "1M"; b1.type="button";
        const b3 = el("button"); b3.textContent = "3M"; b3.type="button";
        const can = el("canvas");
        head.appendChild(btns); btns.appendChild(b1); btns.appendChild(b3);
        const chwrap = el("div","chart"); chwrap.appendChild(can);
        card.appendChild(head); card.appendChild(chwrap);
        grid.appendChild(card);

        let rangeDays = 30, chart;
        const render = () => {
          const data = lastNDays(series, rangeDays);
          const labels = data.map(d => d.date);
          const vals = data.map(d => d.mnav);
          if (chart) chart.destroy();
          chart = new Chart(can.getContext("2d"), {
            type: "line",
            data: { labels, datasets: [{ label: "mNAV", data: vals, tension: 0.2 }] },
            options: { responsive: true, maintainAspectRatio: false, plugins:{legend:{display:false}} }
          });
        };
        b1.addEventListener("click", () => { rangeDays = 30; render(); });
        b3.addEventListener("click", () => { rangeDays = 90; render(); });
        render();
      }
    } catch (err) { diag(String(err)); }
  }

  window.addEventListener("DOMContentLoaded", () => { initEtf(); initMnav(); });
})();
