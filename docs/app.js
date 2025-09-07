// Simple mNAV dashboard: reads docs/data/dat_data.csv and renders one chart per ticker (daily)
(async function () {
  const container = document.getElementById("charts");

  // Global dark styling for Chart.js
  Chart.defaults.color = "#e6e6e6";
  Chart.defaults.borderColor = "#2a2d31";

  // Fetch & parse CSV with d3 (cache-busted to avoid stale GH Pages)
  const url = "data/dat_data.csv?ts=" + Date.now();

  let rows;
  try {
    rows = await d3.csv(url, d3.autoType);
  } catch (e) {
    container.innerHTML = `<div class="loading">Failed to load docs/data/dat_data.csv: ${e}</div>`;
    return;
  }

  // Filter to mNAV metric rows (case-insensitive)
  const mnavRows = rows.filter(r => String(r.metric).trim().toLowerCase() === "mnav");
  if (!mnavRows.length) {
    container.innerHTML = `<div class="loading">No mNAV rows found in dat_data.csv</div>`;
    return;
  }

  // Find ticker columns (everything except date & metric)
  const allCols = new Set();
  mnavRows.forEach(r => Object.keys(r).forEach(k => allCols.add(k)));
  const symbols = [...allCols].filter(k => k !== "date" && k !== "metric");
  if (!symbols.length) {
    container.innerHTML = `<div class="loading">No ticker columns found in dat_data.csv</div>`;
    return;
  }

  // Build symbol -> [{x: Date, y: number}, ...]
  const bySymbol = {};
  for (const sym of symbols) bySymbol[sym] = [];

  // Parse all points
  for (const r of mnavRows) {
    const d = new Date(r.date);
    for (const sym of symbols) {
      const v = r[sym];
      if (v !== null && v !== undefined && v !== "" && !Number.isNaN(v)) {
        // ensure number
        const y = +v;
        if (!Number.isNaN(y)) bySymbol[sym].push({ x: d, y });
      }
    }
  }
  // Sort each series by date
  for (const sym of symbols) {
    bySymbol[sym].sort((a, b) => a.x - b.x);
  }

  // Clear loading
  container.innerHTML = "";

  // Color palette (rotates)
  const palette = [
    "#79c0ff", "#ff7b72", "#a5d6ff", "#d2a8ff", "#ffa657",
    "#56d364", "#1f6feb", "#e3b341", "#ffa198", "#7ee787"
  ];
  let colorIdx = 0;
  const nextColor = () => palette[(colorIdx++) % palette.length];

  // Make a card chart per symbol
  symbols.forEach(sym => {
    const series = bySymbol[sym] || [];
    if (!series.length) return;

    const card = document.createElement("div");
    card.className = "card";

    const title = document.createElement("h2");
    title.textContent = sym;
    card.appendChild(title);

    const wrap = document.createElement("div");
    wrap.className = "canvas-wrap";
    const canvas = document.createElement("canvas");
    wrap.appendChild(canvas);
    card.appendChild(wrap);
    container.appendChild(card);

    const lineColor = nextColor();

    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        datasets: [{
          label: "mNAV",
          data: series,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.2,
          borderColor: lineColor
        }]
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false, // we already provide {x,y}
        scales: {
          x: {
            type: "time",
            time: { unit: "day" },
            grid: { color: "#22252a" }
          },
          y: {
            grid: { color: "#22252a" },
            ticks: {
              callback: (val) =>
                Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(val)
            }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: "index",
            intersect: false,
            callbacks: {
              title: (items) => items?.[0]?.parsed?.x
                ? new Date(items[0].parsed.x).toISOString().slice(0,10)
                : "",
              label: (ctx) => {
                const val = ctx.parsed.y;
                return `mNAV: ${Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(val)}`;
              }
            }
          }
        },
        elements: { line: { capBezierPoints: true } }
      }
    });
  });
})();
