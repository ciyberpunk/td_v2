// mNAV dashboard — compute directly from base series for all EQ- tickers.
// mNAV = (Price × Number of Shares Outstanding) ÷ NAV
// - Shares forward-filled by date (event-driven)
// - Price & NAV NOT forward-filled
// - One daily time-series per ticker (one card per ticker)

(async function () {
  const container = document.getElementById("charts");

  // Dark theme defaults
  Chart.defaults.color = "#e6e6e6";
  Chart.defaults.borderColor = "#2a2d31";

  const url = "./data/dat_data.csv?ts=" + Date.now();

  const show = (msg) => { container.innerHTML = `<div class="loading">${msg}</div>`; };

  // helpers
  const lc = (s) => String(s || "").trim().toLowerCase();
  const cleanHeader = (s) => String(s || "").trim();
  const parseNum = (v) => {
    if (v === null || v === undefined || v === "") return NaN;
    const t = String(v).replace(/,/g, "").trim();
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };
  const parseDate = (s) => {
    const d = new Date(String(s).trim());
    return isNaN(d) ? null : d;
  };

  // 1) fetch CSV
  let text;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return show(`Failed to load ${url} — HTTP ${res.status} ${res.statusText}`);
    text = await res.text();
  } catch (e) { return show(`Failed to fetch ${url}: ${e}`); }

  // 2) parse CSV
  let rows;
  try { rows = d3.csvParse(text); }
  catch (e) { return show(`CSV parse error for ${url}: ${e}`); }
  if (!rows.length) return show("CSV is empty.");

  // normalize headers
  const headers = rows.columns.map(cleanHeader);
  const headerMap = {};
  rows.columns.forEach((orig, i) => (headerMap[orig] = headers[i]));
  rows = rows.map((r) => {
    const o = {};
    for (const k in r) o[headerMap[k]] = r[k];
    return o;
  });

  // 3) extract base metric blocks (case-insensitive)
  const PRICE_NAMES  = new Set(["price"]);
  const NAV_NAMES    = new Set(["net asset value", "nav"]);
  const SHARES_HINTS = ["number of shares"]; // substring to catch variants

  const priceRows = rows.filter((r) => PRICE_NAMES.has(lc(r.metric)));
  const navRows   = rows.filter((r) => NAV_NAMES.has(lc(r.metric)));
  const sharesRows= rows.filter((r) => SHARES_HINTS.some(h => lc(r.metric).includes(h)));

  if (!priceRows.length || !navRows.length || !sharesRows.length) {
    const missing = [];
    if (!priceRows.length) missing.push("Price");
    if (!navRows.length)   missing.push("NAV");
    if (!sharesRows.length)missing.push("Number of Shares Outstanding");
    return show("Missing required inputs: " + missing.join(", "));
  }

  // Identify EQ- ticker columns (everything except date & metric)
  const allCols = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => allCols.add(k)));
  let symbols = [...allCols].filter(k => k !== "date" && k !== "metric" && /^eq-/i.test(k));
  if (!symbols.length) return show("No EQ- ticker columns found in dat_data.csv");

  // Build per-metric { dateString -> value } maps per symbol
  function buildMap(blockRows, sym) {
    const m = new Map();
    for (const r of blockRows) {
      const dStr = String(r.date).trim();
      const y = parseNum(r[sym]);
      if (Number.isFinite(y) && dStr) m.set(dStr, y);
    }
    return m;
  }

  // 4) compute mNAV per symbol, daily
  const bySymbol = {};
  for (const sym of symbols) {
    const pMap = buildMap(priceRows, sym);
    const nMap = buildMap(navRows, sym);
    const sMap = buildMap(sharesRows, sym);

    const dateSet = new Set([...pMap.keys(), ...nMap.keys(), ...sMap.keys()]);
    const dates = [...dateSet].sort();
    let lastShares = undefined;
    const series = [];

    for (const dStr of dates) {
      const d = parseDate(dStr);
      if (!d) continue;

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

    // de-dupe per day (keep last point per date)
    const dedup = [];
    let lastKey = "";
    for (const pt of series) {
      const key = pt.x.toISOString().slice(0,10);
      if (dedup.length && key === lastKey) dedup[dedup.length - 1] = pt;
      else { dedup.push(pt); lastKey = key; }
    }
    bySymbol[sym] = dedup;
  }

  // 5) draw charts
  container.innerHTML = "";

  const palette = [
    "#79c0ff", "#ff7b72", "#a5d6ff", "#d2a8ff", "#ffa657",
    "#56d364", "#1f6feb", "#e3b341", "#ffa198", "#7ee787"
  ];
  let colorIdx = 0;
  const nextColor = () => palette[(colorIdx++) % palette.length];

  let plotted = 0;
  for (const sym of symbols) {
    const series = bySymbol[sym];
    if (!series || series.length < 2) continue;

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
      data: { datasets: [{ label: "mNAV", data: series, borderWidth: 1.5, pointRadius: 0, tension: 0.2, borderColor: lineColor }] },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        scales: {
          x: { type: "time", time: { unit: "day" }, grid: { color: "#22252a" } },
          y: {
            grid: { color: "#22252a" },
            ticks: {
              callback: (val) => Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(val)
            }
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

  if (!plotted) show("No plottable mNAV series (check base metrics or value types).");
})();
