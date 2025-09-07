// mNAV dashboard (robust): one daily time-series chart per ticker
// mNAV rows only, strict numeric parsing, sorted & deduped by date.

(async function () {
  const container = document.getElementById("charts");

  // Dark theme defaults
  Chart.defaults.color = "#e6e6e6";
  Chart.defaults.borderColor = "#2a2d31";

  const url = "./data/dat_data.csv?ts=" + Date.now();

  const show = (msg) => {
    container.innerHTML = `<div class="loading">${msg}</div>`;
  };

  // --- helpers ---
  const cleanHeader = (s) => String(s || "").trim();
  const parseNum = (v) => {
    if (v === null || v === undefined || v === "") return NaN;
    // remove thousands separators and spaces
    const t = String(v).replace(/,/g, "").trim();
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };
  const isDate = (d) => d instanceof Date && !isNaN(d);

  // Fetch CSV
  let text;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      show(`Failed to load ${url} — HTTP ${res.status} ${res.statusText}`);
      return;
    }
    text = await res.text();
  } catch (e) {
    show(`Failed to fetch ${url}: ${e}`);
    return;
  }

  // Parse
  let rows;
  try {
    rows = d3.csvParse(text); // we'll coerce ourselves
  } catch (e) {
    show(`CSV parse error for ${url}: ${e}`);
    return;
  }

  if (!rows.length) {
    show("CSV is empty.");
    return;
  }

  // Normalize headers
  const headers = rows.columns.map(cleanHeader);
  // Build a map in case original headers have stray spaces
  const headerMap = {};
  rows.columns.forEach((orig, i) => (headerMap[orig] = headers[i]));

  // Normalize row keys
  rows = rows.map((r) => {
    const o = {};
    for (const k in r) o[headerMap[k]] = r[k];
    return o;
  });

  // Filter to mNAV metric only
  const mnavRows = rows.filter(
    (r) => String(r.metric || "").trim().toLowerCase() === "mnav"
  );
  if (!mnavRows.length) {
    show("No mNAV rows found in dat_data.csv");
    return;
  }

  // Determine ticker columns (everything except date & metric)
  const allCols = new Set();
  mnavRows.forEach((r) => Object.keys(r).forEach((k) => allCols.add(k)));
  let symbols = [...allCols].filter((k) => k !== "date" && k !== "metric");

  // Keep only symbols that actually have at least one numeric value
  symbols = symbols.filter((sym) =>
    mnavRows.some((r) => Number.isFinite(parseNum(r[sym])))
  );
  if (!symbols.length) {
    show("mNAV exists but all ticker columns are empty / non-numeric.");
    return;
  }

  // Build daily series per symbol: [{x: Date, y: number}, ...]
  const bySymbol = {};
  for (const sym of symbols) bySymbol[sym] = [];

  for (const r of mnavRows) {
    const d = new Date(String(r.date).trim());
    if (!isDate(d)) continue;
    for (const sym of symbols) {
      const y = parseNum(r[sym]);
      if (Number.isFinite(y)) {
        bySymbol[sym].push({ x: d, y });
      }
    }
  }

  // Sort and dedupe by date (keep last value per day)
  for (const sym of symbols) {
    const series = bySymbol[sym];
    if (!series.length) continue;
    series.sort((a, b) => a.x - b.x);
    const dedup = [];
    let lastKey = "";
    for (const pt of series) {
      const key = pt.x.toISOString().slice(0, 10); // YYYY-MM-DD
      if (dedup.length && key === lastKey) {
        dedup[dedup.length - 1] = pt; // keep the last for that day
      } else {
        dedup.push(pt);
        lastKey = key;
      }
    }
    bySymbol[sym] = dedup;
  }

  // Clear loading
  container.innerHTML = "";

  // Palette
  const palette = [
    "#79c0ff", "#ff7b72", "#a5d6ff", "#d2a8ff", "#ffa657",
    "#56d364", "#1f6feb", "#e3b341", "#ffa198", "#7ee787"
  ];
  let colorIdx = 0;
  const nextColor = () => palette[(colorIdx++) % palette.length];

  // Make one mini chart card per ticker
  symbols.forEach((sym) => {
    const series = bySymbol[sym] || [];
    if (series.length < 2) return; // skip if not enough points

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
        parsing: false, // we provide {x,y}
        scales: {
          x: { type: "time", time: { unit: "day" }, grid: { color: "#22252a" } },
          y: {
            grid: { color: "#22252a" },
            ticks: {
              callback: (val) =>
                Intl.NumberFormat(undefined, {
                  notation: "compact",
                  maximumFractionDigits: 2
                }).format(val)
            }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: "index",
            intersect: false,
            callbacks: {
              title: (items) =>
                items?.[0]?.parsed?.x
                  ? new Date(items[0].parsed.x).toISOString().slice(0, 10)
                  : "",
              label: (ctx) =>
                `mNAV: ${Intl.NumberFormat(undefined, {
                  maximumFractionDigits: 2
                }).format(ctx.parsed.y)}`
            }
          }
        }
      }
    });
  });

  // If nothing drew, tell the user why
  const anyPlotted = symbols.some((s) => (bySymbol[s] || []).length >= 2);
  if (!anyPlotted) {
    show("No plottable mNAV series found (check values & dates).");
  }
})();
