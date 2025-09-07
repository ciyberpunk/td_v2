// app.js — simple client-side mNAV for all EQ- tickers (v=simple-2)
// mNAV = (Price × Number of Shares Outstanding) ÷ NAV
// Shares are forward-filled; Price & NAV are NOT.

console.log("mNAV Pages app loaded: v=simple-2");

(async function () {
  const container = document.getElementById("charts");
  const show = (msg) => (container.innerHTML = `<div class="loading">${msg}</div>`);

  // Dark theme defaults for Chart.js
  Chart.defaults.color = "#e6e6e6";
  Chart.defaults.borderColor = "#2a2d31";

  const url = "./data/dat_data.csv?ts=" + Date.now();

  // --- helpers ---
  const trim = (s) => String(s ?? "").trim();
  const lc = (s) => trim(s).toLowerCase();
  const parseNum = (v) => {
    if (v === null || v === undefined || v === "") return NaN;
    const n = Number(String(v).replace(/,/g, "").trim());
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

  // --- 1) fetch CSV ---
  let text;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return show(`Failed to load ${url} — HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    return show(`Failed to fetch ${url}: ${e}`);
  }

  // --- 2) parse & normalize headers ---
  let rows = d3.csvParse(text);
  if (!rows.length) return show("CSV is empty.");
  const headers = rows.columns.map((c) => trim(c));
  const mapH = {};
  rows.columns.forEach((orig, i) => (mapH[orig] = headers[i]));
  rows = rows.map((r) => {
    const o = {};
    for (const k in r) o[mapH[k]] = r[k];
    return o;
  });

  // --- 3) slice base metrics (strict names; shares allows substring backup) ---
  const priceRows  = rows.filter((r) => lc(r.metric) === "price");
  const navRows    = rows.filter((r) => ["net asset value", "nav"].includes(lc(r.metric)));
  let   sharesRows = rows.filter((r) => lc(r.metric) === "number of shares outstanding");
  if (!sharesRows.length) {
    // fallback: any metric containing "number of shares"
    sharesRows = rows.filter((r) => lc(r.metric).includes("number of shares"));
  }
  if (!priceRows.length || !navRows.length || !sharesRows.length) {
    return show("Missing required inputs: Price, NAV, or Number of Shares Outstanding.");
  }

  // --- 4) tickers = EQ- columns (everything except date/metric) ---
  const allCols = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => allCols.add(k)));
  const symbols = [...allCols].filter((k) => k !== "date" && k !== "metric" && /^eq-/i.test(k));
  if (!symbols.length) return show("No EQ- ticker columns found.");

  // Build quick lookup maps: { "YYYY-MM-DD" -> value } for each metric+symbol
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

  // --- 5) compute mNAV per symbol (daily; shares ffill, price/nav not) ---
  const bySymbol = {};
  for (const sym of symbols) {
    const pMap = buildMap(priceRows,  sym);
    const nMap = buildMap(navRows,    sym);
    const sMap = buildMap(sharesRows, sym);

    // Union of dates where any component exists
    const dateSet = new Set([...pMap.keys(), ...nMap.keys(), ...sMap.keys()]);
    const dates = [...dateSet].sort(); // "YYYY-MM-DD" order

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

  // --- 6) render one chart per ticker ---
  container.innerHTML = "";
  const palette = ["#79c0ff","#ff7b72","#a5d6ff","#d2a8ff","#ffa657","#56d364","#1f6feb","#e3b341","#ffa198","#7ee787"];
  let idx = 0; const nextColor = () => palette[(idx++) % palette.length];

  let plotted = 0;
  for (const sym of symbols) {
    const series = bySymbol[sym];
    if (!series || series.length < 2) continue;

    const card = document.createElement("div"); card.className = "card";
    const h2 = document.createElement("h2"); h2.textContent = sym; card.appendChild(h2);
    const wrap = document.createElement("div"); wrap.className = "canvas-wrap";
    const canvas = document.createElement("canvas"); wrap.appendChild(canvas);
    card.appendChild(wrap); container.appendChild(card);

    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets: [{ label: "mNAV", data: series, parsing: false, pointRadius: 0, borderWidth: 1.5, tension: 0.2, borderColor: nextColor() }] },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        scales: {
          x: { type: "time", time: { unit: "day" }, grid: { color: "#22252a" } },
          y: { grid: { color: "#22252a" },
               ticks: { callback: (v) => Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v) } }
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
