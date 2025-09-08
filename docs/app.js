/* app.js — mNAV + ETF charts
   - Loads /data/dat_data.csv (mNAV) and /data/etf_data.csv (ETF flows)
   - Renders mNAV charts (line) and ETF charts (bar + cumulative line)
   - Per-chart 1M / 3M toggles for ETF; mNAV keeps existing behavior
*/

(() => {
  console.log("mNAV + ETF app loaded: v=etf-1", new Date().toISOString());

  // ---------- Small CSV loader (no extra libs) ----------
  async function fetchCSV(path) {
    const url = `${path}?t=${Date.now()}`; // cache-bust for end-users
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to load ${path}: ${res.status}`);
    const text = await res.text();
    return parseCSV(text);
  }

  function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length === 0) return [];
    const headers = lines[0].split(",").map(h => h.trim());
    return lines.slice(1).map(line => {
      const cols = line.split(","); // safe: our CSV has no quoted commas
      const obj = {};
      headers.forEach((h, i) => obj[h] = cols[i] !== undefined ? cols[i] : "");
      return obj;
    });
  }

  // ---------- Date helpers ----------
  function toDate(s) { return new Date(s + "T00:00:00"); }
  function daysAgoDate(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    d.setHours(0,0,0,0);
    return d;
    }

  function filterByRange(rows, days) {
    const cutoff = daysAgoDate(days);
    return rows.filter(r => toDate(r.date) >= cutoff);
  }

  // ---------- COLORS ----------
  const colorBarPos = "rgba(34,197,94,0.65)";   // green-ish
  const colorBarNeg = "rgba(239,68,68,0.70)";   // red-ish
  const colorLine = "rgba(79,140,255,0.95)";    // blue-ish
  const gridColor = "rgba(148,163,184,0.25)";
  const axisColor = "rgba(230,233,239,0.9)";
  const tooltipBg = "rgba(18,21,26,0.95)";
  const tooltipBd = "rgba(79,140,255,0.6)";

  // ---------- CHART.JS DEFAULTS ----------
  Chart.defaults.color = axisColor;
  Chart.defaults.borderColor = gridColor;
  Chart.defaults.plugins.legend.labels.usePointStyle = true;
  Chart.defaults.plugins.tooltip.backgroundColor = tooltipBg;
  Chart.defaults.plugins.tooltip.borderColor = tooltipBd;
  Chart.defaults.plugins.tooltip.borderWidth = 1;

  // ---------- ETF: build bar+line chart ----------
  function buildEtfDatasets(rows, asset) {
    // rows: [{date, metric, BTC, ETH}]
    const daily = rows.filter(r => r.metric === "etf_net_flow_usd_millions")
                      .map(r => ({ date: r.date, v: +r[asset] || 0 }));
    const cum = rows.filter(r => r.metric === "etf_cumulative_net_flow_usd_millions")
                    .map(r => ({ date: r.date, v: +r[asset] || 0 }));

    // Ensure sorted, align by date
    daily.sort((a,b) => a.date.localeCompare(b.date));
    cum.sort((a,b) => a.date.localeCompare(b.date));
    const labels = daily.map(d => d.date);
    const bars = daily.map(d => d.v);
    const line = cum.map(d => d.v);

    // Color bars pos/neg
    const barColors = bars.map(v => v >= 0 ? colorBarPos : colorBarNeg);

    return { labels, bars, line, barColors };
  }

  function makeEtfChart(ctx, ds) {
    return new Chart(ctx, {
      type: "bar",
      data: {
        labels: ds.labels,
        datasets: [
          {
            type: "bar",
            label: "Net flow (USD m)",
            data: ds.bars,
            backgroundColor: ds.barColors,
            borderWidth: 0,
            yAxisID: "y",
          },
          {
            type: "line",
            label: "Cumulative (USD m)",
            data: ds.line,
            borderColor: colorLine,
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
            yAxisID: "y1",
          }
        ]
      },
      options: {
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: true },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const v = ctx.raw ?? 0;
                return `${ctx.dataset.label}: ${Number(v).toLocaleString(undefined, {maximumFractionDigits:1})}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { maxRotation: 0, autoSkip: true, autoSkipPadding: 10 },
          },
          y: {
            position: "left",
            title: { display: true, text: "Net flow (USD m)" },
            ticks: { callback: v => Number(v).toLocaleString() },
          },
          y1: {
            position: "right",
            grid: { drawOnChartArea: false },
            title: { display: true, text: "Cumulative (USD m)" },
            ticks: { callback: v => Number(v).toLocaleString() },
          }
        }
      }
    });
  }

  function updateEtfChart(chart, rows, asset, days) {
    const subset = days ? filterByRange(rows, days) : rows;
    const ds = buildEtfDatasets(subset, asset);
    chart.data.labels = ds.labels;
    chart.data.datasets[0].data = ds.bars;
    chart.data.datasets[0].backgroundColor = ds.barColors;
    chart.data.datasets[1].data = ds.line;
    chart.update();
  }

  function wireEtfToggles(container, chart, rows, asset) {
    const btns = container.querySelectorAll(".toggle-btn");
    btns.forEach(btn => {
      btn.addEventListener("click", () => {
        btns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        const days = parseInt(btn.dataset.range, 10);
        updateEtfChart(chart, rows, asset, days);
      });
    });
  }

  // ---------- mNAV (existing) ----------
  // We keep it simple: render all eq-XXXX mNAV line charts you already have in csv
  async function renderMNAV() {
    try {
      const datRows = await fetchCSV("data/dat_data.csv");
      // Expect columns at least: date, ticker, price, nav, num_of_shares, mNAV (we compute in your backend)
      // We will detect tickers and build charts (line) with 1M/3M toggles like before.

      // Build per-ticker series from mNAV column if present; otherwise compute fallback
      // Normalize headers (case-insensitive lookup)
      const lc = s => (s || "").toLowerCase();
      const headers = Object.keys(datRows[0] || {}).reduce((acc, k) => (acc[lc(k)] = k, acc), {});
      const keyDate = headers["date"] || "date";
      const keyTicker = headers["ticker"] || headers["symbol"] || "ticker";
      const keyMNAV = headers["mnav"] || "mNAV";
      const keyPrice = headers["price"] || "price";
      const keyNAV = headers["nav"] || "nav";
      const keyShares = headers["num_of_shares"] || headers["num_of_tokens"] || "num_of_shares";

      // Build map ticker -> [{date, mnav}]
      const byTicker = new Map();
      for (const r of datRows) {
        const t = (r[keyTicker] || "").toString();
        if (!t) continue;
        const d = r[keyDate];
        let m = r[keyMNAV];
        if (m === undefined || m === "") {
          // fallback compute if needed
          const price = +r[keyPrice] || 0;
          const nav   = +r[keyNAV] || 0;
          const sh    = +r[keyShares] || 0;
          m = (nav > 0 && sh > 0) ? (price * sh) / nav : NaN;
        } else {
          m = +m;
        }
        if (!byTicker.has(t)) byTicker.set(t, []);
        byTicker.get(t).push({ date: d, mnav: m });
      }

      // Preferred order you asked for earlier
      const preferred = ["eq-mstr","eq-mtplf","eq-sbet","eq-bmnr","eq-dfdv","eq-upxi"];
      const allTickers = Array.from(byTicker.keys());
      const ordered = [...preferred.filter(x => allTickers.includes(x)), ...allTickers.filter(x => !preferred.includes(x))];

      // Render
      const grid = document.getElementById("mnav-grid");
      for (const sym of ordered) {
        const pretty = sym.replace(/^eq-?/i, "").toUpperCase();
        const card = document.createElement("div");
        card.className = "chart-card";
        card.innerHTML = `
          <div class="card-head">
            <h3>${pretty} — mNAV</h3>
            <div class="toggles" data-target="mnav-${sym}">
              <button class="toggle-btn active" data-range="30">1M</button>
              <button class="toggle-btn" data-range="90">3M</button>
            </div>
          </div>
          <canvas id="mnav-${sym}"></canvas>
          <p class="card-note">mNAV = (Price × Shares) ÷ NAV</p>
        `;
        grid.appendChild(card);

        // build dataset
        const rows = (byTicker.get(sym) || []).slice().sort((a,b) => a.date.localeCompare(b.date));
        const ctx = card.querySelector(`#mnav-${sym}`).getContext("2d");

        const fullLabels = rows.map(r => r.date);
        const fullData = rows.map(r => +r.mnav || 0);

        const chart = new Chart(ctx, {
          type: "line",
          data: {
            labels: fullLabels,
            datasets: [{
              label: "mNAV",
              data: fullData,
              borderColor: colorLine,
              borderWidth: 2,
              pointRadius: 0,
              tension: 0.25
            }]
          },
          options: {
            maintainAspectRatio: false,
            interaction: { mode: "index", intersect: false },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => `mNAV: ${Number(ctx.raw ?? 0).toLocaleString(undefined,{maximumFractionDigits:1})}`
                }
              }
            },
            scales: {
              x: { grid: { display:false }, ticks:{ maxRotation:0, autoSkip:true, autoSkipPadding:10 } },
              y: { ticks: { callback: v => Number(v).toLocaleString() } }
            }
          }
        });

        // wire toggles
        const toggles = card.querySelectorAll(".toggle-btn");
        const update = (days) => {
          const subset = filterByRange(rows.map(r => ({date:r.date, v:r.mnav})), days);
          chart.data.labels = subset.map(r => r.date);
          chart.data.datasets[0].data = subset.map(r => +r.v || 0);
          chart.update();
        };
        toggles.forEach(btn => {
          btn.addEventListener("click", () => {
            toggles.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            update(parseInt(btn.dataset.range, 10));
          });
        });
        // default 1M
        update(30);
      }
    } catch (e) {
      console.error("mNAV load/render failed:", e);
    }
  }

  // ---------- ETF render ----------
  async function renderETF() {
    try {
      const rows = await fetchCSV("data/etf_data.csv");
      // Expect: date, metric, BTC, ETH
      // Build charts for BTC and ETH
      const grid = document.getElementById("etf-grid");

      // BTC
      {
        const ctx = document.getElementById("etf-btc").getContext("2d");
        const chart = makeEtfChart(ctx, buildEtfDatasets(rows, "BTC"));
        const toggles = grid.querySelector('.toggles[data-target="etf-btc"]');
        wireEtfToggles(toggles, chart, rows, "BTC");
        // default 1M
        updateEtfChart(chart, rows, "BTC", 30);
      }

      // ETH
      {
        const ctx = document.getElementById("etf-eth").getContext("2d");
        const chart = makeEtfChart(ctx, buildEtfDatasets(rows, "ETH"));
        const toggles = grid.querySelector('.toggles[data-target="etf-eth"]');
        wireEtfToggles(toggles, chart, rows, "ETH");
        // default 1M
        updateEtfChart(chart, rows, "ETH", 30);
      }
    } catch (e) {
      console.error("ETF load/render failed:", e);
    }
  }

  // ---------- boot ----------
  renderMNAV();
  renderETF();
})();
