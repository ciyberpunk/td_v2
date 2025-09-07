// app.js — simple client-side mNAV for all EQ- tickers (v=simple-3)
// Robust header normalization (lowercase), strict parsing, daily dedupe.
// mNAV = (Price × Number of Shares Outstanding) ÷ NAV
// Shares forward-filled; Price & NAV NOT forward-filled.

console.log("mNAV Pages app loaded: v=simple-3");

(async function () {
  const container = document.getElementById("charts");
  const show = (msg) => (container.innerHTML = `<div class="loading">${msg}</div>`);

  // Dark theme defaults for Chart.js
  Chart.defaults.color = "#e6e6e6";
  Chart.defaults.borderColor = "#2a2d31";

  const url = "./data/dat_data.csv?ts=" + Date.now();

  // ---------- helpers ----------
  const trim = (s) => String(s ?? "").trim();
  const lc = (s) => trim(s).toLowerCase();
  const parseNum = (v) => {
    if (v === null || v === undefined || v === "") return NaN;
    // strip thousands separators (commas/spaces)
    const t = String(v).replace(/[,\s]+/g, "").trim();
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };
  const parseDate = (s) => {
    const raw = trim(s);
    // Avoid TZ drift for YYYY-MM-DD by parsing as UTC midnight
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const d = new Date(raw + "T00:00:00Z");
      return isNaN(d) ? null : d;
    }
    const d = new Date(raw);
    return isNaN(d) ? null : d;
  };

  // ---------- 1) fetch CSV ----------
  let text;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return show(`Failed to load ${url} — HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    return show(`Failed to fetch ${url}: ${e}`);
  }

  // ---------- 2) parse & normalize headers to lowercase ----------
  let rows = d3.csvParse(text);
  if (!rows.length) return show("CSV is empty.");

  // Build lowercase header map
  const headersLC = rows.columns.map((c) => lc(c));
  const mapH = {};
  rows.columns.forEach((orig, i) => (mapH[orig] = headersLC[i]));

  // Re-key each row to lowercase headers
  rows = rows.map((r) => {
    const o = {};
    for (const k in r) o[mapH[k]] = r[k];
    return o;
  });

  // ---------- 3) slice base metrics ----------
  const priceRows  = rows.filter((r) => lc(r.metric) === "price");
  const navRows    = rows.filter((r) => ["net asset value", "nav"].includes(lc(r.metric)));
  // Shares: allow variants; match if contains "number of shares"
  const sharesRows = rows.filter((r) => lc(r.metric).includes("number of shares"));
  if (!priceRows.length || !navRows.length || !sharesRows.length) {
    return show("Missing required inputs: Price, NAV, or Number of Shares Outstanding.");
  }

  // ---------- 4) tickers = EQ- columns (everything except date/metric) ----------
  const allCols = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => allCols.add(k)));
  const symbolsLC = [...allCols].filter(
    (k) => k !== "date" && k !== "metric" && /^eq-/.test(k) // already lowercase
  );
  if (!symbolsLC.length) return show("No EQ- ticker columns found.");

  // ---------- 5) compute mNAV per symbol (daily; shares ffill, price/nav not) ----------
  function buildMap(blockRows, sym) {
    const m = new Map();
    for (const r of blockRows) {
      const dStr = trim(r.date);
      if (!dStr) continue;
      const y = parseNum(r[sym]);
      if (Number.isFinite(y)) m.set(dStr, y);
    }
    return m;
  }

  const bySymbol = {};
  for (const sym of symbolsLC) {
    const pMap = buildMap(priceRows,  sym);
    const nMap = buildMap(navRows,    sym);
    const sMap = buildMap(sharesRows, sym);

    // Union of dates where any component exists
    const dates = [...new Set([...pMap.keys(), ...nMap.keys(), ...sMap.keys()])].sort();

    let lastShares;
    const series = [];
    for (const dStr of dates) {
      const d = parseDate(dStr);
      if (!d) continue;

      // forward-fill shares
      if (sMap.has(dStr)) {
        const v = sMap.get(dStr);
        if (Number.isFinite(v)) lastShares = v;
      }

      const price = pMap.get(dStr);
      const nav   = nMap.get(dStr);

      if (Number.isFinite(price) && Number.isFinite(nav) && nav !== 0 && Number.isFinite(lastShares)) {
        series.push({ x: d, y: (price * lastShares) / nav });
      }
    }

    // De-duplicate by calendar day (keep last)
    const dedup = [];
    let lastKey = "";
    for (const pt of series) {
      const key = pt.x.toISOString().slice(0, 10);
      if (dedup.length && key === lastKey) dedup[dedup.length - 1] = pt;
      else { dedup.push(pt); lastKey = key; }
    }
    bySymbol[sym] = dedup;
  }

  // ---------- 6) render one chart per ticker ----------
  container.innerHTML = "";
  const palette = ["#79c0ff","#ff7b72","#a5d6ff","#d2a8ff","#ffa657","#56d364","#1f6feb","#e3b341","#ffa198","#7ee787"];
  let idx = 0; const nextColor = () => palette[(idx++) % palette.length];

  let plotted = 0;
  for (const symLC of symbolsLC) {
    const series = bySymbol[symLC];
    if (!series || series.length < 2) continue;

    const card = document.createElement("div"); card.className = "card";
    const h2 = document.createElement("h2"); h2.textContent = symLC.toUpperCase(); card.appendChild(h2);
    const wrap = document.createElement("div"); wrap.className = "canvas-wrap";
    const canvas = document.createElement("canvas"); wrap.appendChild(canvas);
    card.appendChild(wrap); container.appendChild(card);

    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        datasets: [{
          label: "mNAV",
          data: series,
          parsing: false,
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.2,
          borderColor: nextColor()
        }]
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        scales: {
          x: { type: "time", time: { unit: "day" }, grid: { color: "#22252a" } },
          y: {
            grid: { color: "#22252a" },
            ticks: { callback: (v) => Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v) }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            mode: "index", intersect: false,
            callbacks: {
              title: (items) => items?.[0]?.parsed?.x ? new Date(items[0].parsed.x).toISOString().slice(0,10) : "",
              label: (ctx) => `mNAV: ${Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(ctx.parsed.y)}`
            }
          }
        }
      }
    });

    plotted++;
  }

  if (!plotted) show("No plottable mNAV series (check Price/NAV/Shares columns).");
})();
