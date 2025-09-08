/* td_v2 frontend — mNAV uses (Price × num_of_shares) ÷ NAV */
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
  const lastNDays = (a,n) => a.slice(-n);
  const cleanTicker = (t) => String(t||"").replace(/^EQ[:\s]+/i,"").trim().toUpperCase();

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
    for (const p of candidates) {
      try { return await loadCSVOnce(p); } catch (e) { lastErr = e; }
    }
    throw new Error(`${label}: none of [${candidates.join(", ")}] worked → ${lastErr?.message || lastErr}`);
  }

  function makeLine(ctx, labels, values, label) {
    return new Chart(ctx, {
      type: "line",
      data: { labels, datasets: [{ label, data: values, tension: 0.2 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins:{ legend:{ display:false }},
        scales: { x: { ticks: { maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } } },
      }
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

  // ----- mNAV with num_of_shares -----
  async function initMnav() {
    try {
      const { rows, path } = await loadCSVAny(CSV_CANDIDATES.dat, "dat_data.csv");
      diag(`mNAV source: ${path}`);

      const norm = rows.map(r => {
        const date = r.date ?? r.Date ?? r.dt ?? r.Dt;
        const ticker = cleanTicker(r.ticker ?? r.Ticker ?? r.symbol ?? r.Symbol ?? r.eq_ticker ?? r.asset);

        // price variants
        const price = +(
          r.price ?? r.Price ?? r.close ?? r.Close ?? r.last ?? r.Last ?? r.px_last ?? r.PX_LAST
        );

        // strictly prefer number of shares (basic/outstanding)
        const shares = +(
          r.num_of_shares ?? r.NUM_OF_SHARES ?? r.num_shares ?? r.numShares ??
          r.shares_outstanding ?? r.SharesOutstanding ?? r.shares_out ?? r.shares_basic ??
          r.basic_shares ?? r.shares ?? r.Shares
        );

        // NAV variants
        const nav = +(
          r.nav ?? r.NAV ?? r.net_asset_value ?? r.NetAssetValue
        );

        const fallback_mnav = +(r.mnav ?? r.MNAV ?? r.value ?? r.Value);

        const mnav = (Number.isFinite(price) && Number.isFinite(shares) && Number.isFinite(nav) && nav !== 0)
          ? (price * shares) / nav
          : (Number.isFinite(fallback_mnav) ? fallback_mnav : NaN);

        return { date: fmtDate(date), ticker, mnav };
      })
      .filter(x => x.date && x.ticker && Number.isFinite(x.mnav))
      .sort((a,b) => a.date.localeCompare(b.date));

      // Dedup per (ticker,date)
      const byTD = new Map();
      for (const r of norm) byTD.set(`${r.ticker}__${r.date}`, r);
      const dedup = Array.from(byTD.values());

      // Group exactly the 6 desired tickers, in order
      const grouped = Object.fromEntries(DESIRED_TICKERS.map(t => [t, []]));
      for (const r of dedup) if (grouped[r.ticker]) grouped[r.ticker].push(r);

      const grid = $("#mnav-grid");
      if (!grid) { diag("Missing #mnav-grid"); return; }
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
        $("#mnav-grid").appendChild(card);

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

  // ----- ETF Flows (unchanged spec) -----
  async function initEtf() {
    try {
      const { rows, path } = await loadCSVAny(CSV_CANDIDATES.etf, "etf_data.csv");
      diag(`ETF source: ${path}`);

      const base = rows.map(r => {
        const date = r.date ?? r.Date ?? r.dt;
        const btcDaily = +(r.btc_daily ?? r.btc_net ?? r.btc ?? r.BTC ?? r.btc_sum ?? r.BTC_Flow ?? 0);
        const ethDaily = +(r.eth_daily ?? r.eth_net ?? r.eth ?? r.ETH ?? r.eth_sum ?? r.ETH_Flow ?? 0);
        return { date: fmtDate(date), btcDaily, ethDaily };
      }).filter(r => r.date).sort((a,b) => a.date.localeCompare(b.date));

      // all-time cumulative
      let bCum = 0, eCum = 0;
      const withCum = base.map(r => { bCum += r.btcDaily; eCum += r.ethDaily; return { ...r, btcCum: bCum, ethCum: eCum }; });

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
