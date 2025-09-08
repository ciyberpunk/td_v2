/* mNAV + ETF charts (client-side, robust + diagnostics) */
(() => {
  const VERSION = "diag-7";
  const diag = (msg) => {
    const el = document.getElementById("diag");
    if (el) el.textContent = `[${VERSION}] ${msg}`;
    console.log(`[${VERSION}] ${msg}`);
  };

  diag("booting…");

  // ---- utils ----
  async function fetchCSV(path) {
    const url = `${path}?t=${Date.now()}`; // cache-bust for viewers
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    return res.text();
  }

  async function loadCSVObjects(path) {
    const text = await fetchCSV(path);
    // Robust parsing via Papa
    const parsed = Papa.parse(text, { header: true, dynamicTyping: false, skipEmptyLines: true });
    if (parsed.errors && parsed.errors.length) {
      console.warn("Papa parse errors:", parsed.errors.slice(0,3));
    }
    return parsed.data || [];
  }

  function toDate(s) { return new Date(s + "T00:00:00"); }
  function daysAgo(days) { const d = new Date(); d.setDate(d.getDate() - days); d.setHours(0,0,0,0); return d; }
  function filterByDays(rows, days) { const c = daysAgo(days); return rows.filter(r => toDate(r.date) >= c); }

  // ---- colors & Chart.js defaults ----
  const colorLine = "rgba(79,140,255,0.95)";
  const colorBarPos = "rgba(34,197,94,0.65)";
  const colorBarNeg = "rgba(239,68,68,0.70)";
  const gridColor = "rgba(148,163,184,0.25)";
  const axisColor = "rgba(230,233,239,0.9)";
  const tooltipBg = "rgba(18,21,26,0.95)";
  const tooltipBd = "rgba(79,140,255,0.6)";

  Chart.defaults.color = axisColor;
  Chart.defaults.borderColor = gridColor;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.tooltip.backgroundColor = tooltipBg;
  Chart.defaults.plugins.tooltip.borderColor = tooltipBd;
  Chart.defaults.plugins.tooltip.borderWidth = 1;

  // ================= mNAV =================
  async function renderMNAV() {
    try {
      const dat = await loadCSVObjects("data/dat_data.csv");
      diag(`mNAV: loaded ${dat.length} rows`);
      if (!dat.length) return;

      // header map (case-insensitive)
      const lc = s => (s || "").toLowerCase();
      const head = Object.keys(dat[0]).reduce((a, k) => (a[lc(k)] = k, a), {});
      const K = {
        date: head["date"] || "date",
        ticker: head["ticker"] || head["symbol"] || "ticker",
        mnav: head["mnav"] || "mNAV",
        price: head["price"] || "price",
        nav: head["nav"] || "nav",
        shares: head["num_of_shares"] || head["num_of_tokens"] || "num_of_shares",
      };

      // group by ticker
      const byT = new Map();
      for (const r of dat) {
        const t = (r[K.ticker] || "").toString();
        if (!t) continue;
        const d = r[K.date];
        let v = r[K.mnav];
        if (v === undefined || v === "") {
          const p = +r[K.price] || 0; const n = +r[K.nav] || 0; const s = +r[K.shares] || 0;
          v = (n > 0 && s > 0) ? (p * s) / n : NaN;
        } else { v = +v; }
        if (!byT.has(t)) byT.set(t, []);
        byT.get(t).push({ date: d, v });
      }

      const all = Array.from(byT.keys());
      diag(`mNAV: detected ${all.length} tickers: ${all.join(", ")}`);
      if (all.length === 0) {
        diag("mNAV: no tickers found — check CSV headers/columns");
        return;
      }

      const desiredOrder = ["eq-mstr","eq-mtplf","eq-sbet","eq-bmnr","eq-dfdv","eq-upxi"];
      const ordered = [...desiredOrder.filter(x => all.includes(x)), ...all.filter(x => !desiredOrder.includes(x))];

      const grid = document.getElementById("mnav-grid");
      for (const sym of ordered) {
        const title = sym.replace(/^eq-?/i, "").toUpperCase();
        const card = document.createElement("div");
        card.className = "chart-card";
        card.innerHTML = `
          <div class="card-head">
            <h3>${title} — mNAV</h3>
            <div class="toggles" data-target="mnav-${sym}">
              <button class="toggle-btn active" data-range="30">1M</button>
              <button class="toggle-btn" data-range="90">3M</button>
            </div>
          </div>
          <canvas id="mnav-${sym}" class="chart-canvas"></canvas>
          <p class="card-note">mNAV = (Price × Shares) ÷ NAV</p>
        `;
        grid.appendChild(card);

        const series = (byT.get(sym) || []).slice().sort((a,b) => a.date.localeCompare(b.date));
        const ctx = card.querySelector(`#mnav-${sym}`).getContext("2d");

        const chart = new Chart(ctx, {
          type: "line",
          data: {
            labels: series.map(r => r.date),
            datasets: [{ label: "mNAV", data: series.map(r => +r.v || 0), borderColor: colorLine, borderWidth: 2, pointRadius: 0, tension: 0.25 }]
          },
          options: {
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: "index", intersect: false },
            plugins: { legend: { display: false },
              tooltip: { callbacks: { label: c => `mNAV: ${Number(c.raw ?? 0).toLocaleString(undefined,{maximumFractionDigits:1})}` } }
            },
            scales: {
              x: { grid:{display:false}, ticks:{maxRotation:0, autoSkip:true, autoSkipPadding:10} },
              y: { ticks:{ callback:v=>Number(v).toLocaleString() } }
            }
          }
        });

        // toggles
        const btns = card.querySelectorAll(".toggle-btn");
        const update = days => {
          const sub = filterByDays(series.map(r => ({date:r.date, v:r.v})), days);
          chart.data.labels = sub.map(r => r.date);
          chart.data.datasets[0].data = sub.map(r => +r.v || 0);
          chart.update();
        };
        btns.forEach(b => b.addEventListener("click", () => {
          btns.forEach(x => x.classList.remove("active")); b.classList.add("active");
          update(parseInt(b.dataset.range, 10));
        }));
        update(30);
      }
    } catch (e) {
      diag(`mNAV error: ${e.message}`);
      console.error(e);
    }
  }

  // ================= ETF =================
  function buildEtfDatasets(rows, asset) {
    const daily = rows.filter(r => r.metric === "etf_net_flow_usd_millions")
                      .map(r => ({ date: r.date, v: +r[asset] || 0 }))
                      .sort((a,b) => a.date.localeCompare(b.date));
    const cum = rows.filter(r => r.metric === "etf_cumulative_net_flow_usd_millions")
                    .map(r => ({ date: r.date, v: +r[asset] || 0 }))
                    .sort((a,b) => a.date.localeCompare(b.date));
    const labels = daily.map(d => d.date);
    const bars = daily.map(d => d.v);
    const line = cum.map(d => d.v);
    const barColors = bars.map(v => v >= 0 ? "rgba(34,197,94,0.65)" : "rgba(239,68,68,0.70)");
    return { labels, bars, line, barColors };
  }
  function makeEtfChart(ctx, ds) {
    return new Chart(ctx, {
      type: "bar",
      data: {
        labels: ds.labels,
        datasets: [
          { type:"bar", label:"Net flow (USD m)", data: ds.bars, backgroundColor: ds.barColors, borderWidth: 0, yAxisID: "y" },
          { type:"line", label:"Cumulative (USD m)", data: ds.line, borderColor: "rgba(79,140,255,0.95)", borderWidth: 2, pointRadius: 0, tension: 0.25, yAxisID:"y1" }
        ]
      },
      options: {
        maintainAspectRatio: false,
        animation: false,           // prevents initial warp
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { display: true } },
        scales: {
          x: { grid:{display:false}, ticks:{maxRotation:0, autoSkip:true, autoSkipPadding:10} },
          y: { position:"left",  title:{display:true, text:"Net flow (USD m)"}, ticks:{ callback:v=>Number(v).toLocaleString() } },
          y1:{ position:"right", grid:{drawOnChartArea:false}, title:{display:true, text:"Cumulative (USD m)"}, ticks:{ callback:v=>Number(v).toLocaleString() } }
        }
      }
    });
  }
  function updateEtfChart(chart, rows, asset, days) {
    const subset = days ? filterByDays(rows, days) : rows;
    const ds = buildEtfDatasets(subset, asset);
    chart.data.labels = ds.labels;
    chart.data.datasets[0].data = ds.bars;
    chart.data.datasets[0].backgroundColor = ds.barColors;
    chart.data.datasets[1].data = ds.line;
    chart.update();
  }
  function wireEtfToggles(container, chart, rows, asset) {
    const btns = container.querySelectorAll(".toggle-btn");
    btns.forEach(btn => btn.addEventListener("click", () => {
      btns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      updateEtfChart(chart, rows, asset, parseInt(btn.dataset.range, 10));
    }));
  }
  async function renderETF() {
    try {
      const rows = await loadCSVObjects("data/etf_data.csv");
      diag(`ETF: loaded ${rows.length} rows`);
      const grid = document.getElementById("etf-grid");
      // BTC
      {
        const ctx = document.getElementById("etf-btc").getContext("2d");
        const chart = makeEtfChart(ctx, buildEtfDatasets(rows, "BTC"));
        const toggles = grid.querySelector('.toggles[data-target="etf-btc"]');
        wireEtfToggles(toggles, chart, rows, "BTC");
        updateEtfChart(chart, rows, "BTC", 30);
      }
      // ETH
      {
        const ctx = document.getElementById("etf-eth").getContext("2d");
        const chart = makeEtfChart(ctx, buildEtfDatasets(rows, "ETH"));
        const toggles = grid.querySelector('.toggles[data-target="etf-eth"]');
        wireEtfToggles(toggles, chart, rows, "ETH");
        updateEtfChart(chart, rows, "ETH", 30);
      }
    } catch (e) {
      diag(`ETF error: ${e.message}`);
      console.error(e);
    }
  }

  // boot
  (async () => {
    await renderMNAV();
    await renderETF();
    diag("ready.");
  })();
})();
