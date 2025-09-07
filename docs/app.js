// app.js — client-side mNAV with 1M/3M toggle and fixed order (v=ui-4)
// mNAV = (Price × Shares Outstanding) ÷ NAV
// Shares forward-filled; Price & NAV NOT forward-filled.
// Layout: 2 charts per row on large screens.
// Order: MSTR + MTPLF (top), SBET + BMNR (middle), DFDV + UPXI (bottom).

console.log("mNAV Pages app loaded: v=ui-4");

(async function () {
  const container = document.getElementById("charts");
  const show = (msg) => (container.innerHTML = `<div class="loading">${msg}</div>`);

  // Dark theme
  Chart.defaults.color = "#e6e6e6";
  Chart.defaults.borderColor = "#2a2d31";

  const url = "./data/dat_data.csv?ts=" + Date.now();
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Target order (labels without EQ-)
  const DESIRED_ORDER = ["MSTR", "MTPLF", "SBET", "BMNR", "DFDV", "UPXI"];

  // ----- helpers -----
  const trim = (s) => String(s ?? "").trim();
  const lc = (s) => trim(s).toLowerCase();
  const normMetric = (s) => lc(s).replace(/[^a-z0-9]+/g, "_");
  const parseNum = (v) => {
    if (v === null || v === undefined || v === "") return NaN;
    const t = String(v).replace(/[^0-9eE.\-+]/g, ""); // strip $, commas, spaces
    if (!t || t === "." || t === "-" || t === "+") return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };
  // Return UNIX ms (for Chart.js time scale)
  const toDayTS = (s) => {
    const raw = trim(s);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const ms = Date.parse(raw + "T00:00:00Z"); // avoid TZ drift
      return Number.isFinite(ms) ? ms : NaN;
    }
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : NaN;
  };
  const tickerLabel = (sym) => sym.toUpperCase().replace(/^EQ-/, "");
  const isIn = (val, arr) => arr.includes(val);

  // ----- 1) fetch CSV -----
  let text;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return show(`Failed to load ${url} — HTTP ${res.status}`);
    text = await res.text();
  } catch (e) { return show(`Failed to fetch ${url}: ${e}`); }

  // ----- 2) parse & normalize headers (lowercase) -----
  let rows = d3.csvParse(text);
  if (!rows.length) return show("CSV is empty.");

  const headersLC = rows.columns.map((c) => lc(c));
  const headerMap = {};
  rows.columns.forEach((orig, i) => (headerMap[orig] = headersLC[i]));
  rows = rows.map((r) => {
    const o = {};
    for (const k in r) o[headerMap[k]] = r[k];
    o._m = normMetric(o.metric ?? "");
    return o;
  });

  // ----- 3) base metrics -----
  const priceRows = rows.filter((r) => isIn(r._m, ["price"]));
  const navRows   = rows.filter((r) => isIn(r._m, ["nav", "net_asset_value"]));
  const sharesRows = rows.filter((r) => {
    const m = r._m;
    if (m.includes("fully") && m.includes("diluted")) return false;
    return (
      isIn(m, [
        "number_of_shares_outstanding",
        "number_of_shares",
        "num_of_shares",
        "shares_outstanding",
        "shares"
      ]) || m.includes("number_of_shares")
    );
  });

  if (!priceRows.length || !navRows.length || !sharesRows.length) {
    return show("Missing required inputs: Price, NAV, or Shares.");
  }

  // ----- 4) EQ- ticker columns -----
  const allCols = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => allCols.add(k)));
  const allSymbols = [...allCols].filter(
    (k) => k !== "date" && k !== "metric" && k !== "_m" && /^eq-/.test(k)
  );
  if (!allSymbols.length) return show("No EQ- ticker columns found.");

  // Filter & order symbols to match DESIRED_ORDER (skip missing)
  const presentLabels = new Map(allSymbols.map(sym => [tickerLabel(sym), sym])); // label -> symbol
  const symbols = DESIRED_ORDER.map(lbl => presentLabels.get(lbl)).filter(Boolean);
  if (!symbols.length) return show("Desired tickers not found in CSV.");

  // ----- 5) compute full mNAV series per symbol -----
  function buildMap(blockRows, sym) {
    const m = new Map(); // "YYYY-MM-DD" -> number
    for (const r of blockRows) {
      const dStr = trim(r.date);
      if (!dStr) continue;
      const y = parseNum(r[sym]);
      if (Number.isFinite(y)) m.set(dStr, y);
    }
    return m;
  }

  const fullBySymbol = {};
  for (const sym of symbols) {
    const pMap = buildMap(priceRows,  sym);
    const nMap = buildMap(navRows,    sym);
    const sMap = buildMap(sharesRows, sym);

    const dates = [...new Set([...pMap.keys(), ...nMap.keys(), ...sMap.keys()])].sort();
    let lastShares;
    const raw = [];

    for (const dStr of dates) {
      const ts = toDayTS(dStr);
      if (!Number.isFinite(ts)) continue;

      if (sMap.has(dStr)) {
        const v = sMap.get(dStr);
        if (Number.isFinite(v)) lastShares = v; // forward-fill shares
      }
      const price = pMap.get(dStr);
      const nav   = nMap.get(dStr);

      if (Number.isFinite(price) && Number.isFinite(nav) && nav !== 0 && Number.isFinite(lastShares)) {
        raw.push({ x: ts, y: (price * lastShares) / nav });
      }
    }

    // dedupe by day (keep last point)
    raw.sort((a, b) => a.x - b.x);
    const series = [];
    let lastKey = "";
    for (const pt of raw) {
      const key = new Date(pt.x).toISOString().slice(0, 10);
      if (series.length && key === new Date(series[series.length - 1].x).toISOString().slice(0, 10)) {
        series[series.length - 1] = pt;
      } else {
        series.push(pt);
      }
    }
    fullBySymbol[sym] = series;
  }

  // ----- 6) render with window (1M default, 3M optional) -----
  const palette = ["#79c0ff","#ff7b72","#a5d6ff","#d2a8ff","#ffa657","#56d364","#1f6feb","#e3b341","#ffa198","#7ee787"];
  let colorIndex;

  function filterWindow(series, days) {
    if (!series || !series.length) return [];
    const maxX = series[series.length - 1].x;
    const cutoff = maxX - days * DAY_MS;
    return series.filter((pt) => pt.x >= cutoff);
  }

  function render(windowDays = 30) {
    container.innerHTML = "";
    colorIndex = 0;

    for (const sym of symbols) {
      const series = filterWindow(fullBySymbol[sym], windowDays);
      if (!series || series.length < 2) continue;

      const card = document.createElement("div"); card.className = "card";
      const h2 = document.createElement("h2"); h2.textContent = tickerLabel(sym); card.appendChild(h2);
      const wrap = document.createElement("div"); wrap.className = "canvas-wrap";
      const canvas = document.createElement("canvas"); wrap.appendChild(canvas);
      card.appendChild(wrap); container.appendChild(card);

      new Chart(canvas.getContext("2d"), {
        type: "line",
        data: {
          datasets: [{
            label: "mNAV",
            data: series,            // [{x: ms, y: number}]
            parsing: false,
            pointRadius: 0,
            borderWidth: 1.5,
            tension: 0.2,
            borderColor: palette[(colorIndex++) % palette.length],
            spanGaps: true
          }]
        },
        options: {
          animation: false,
          responsive: true,
          maintainAspectRatio: false,
          scales: {
            x: { type: "time", time: { unit: "day" }, grid: { color: "#22252a" } },
            y: { grid: { color: "#22252a" },
                 ticks: { callback: (v) => Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v) } }
          },
          plugins: {
            legend: { display: false },
            tooltip: {
              mode: "index",
              intersect: false,
              callbacks: {
                title: (items) => {
                  const ts = items?.[0]?.raw?.x ?? items?.[0]?.parsed?.x;
                  return Number.isFinite(ts) ? new Date(ts).toISOString().slice(0,10) : "";
                },
                label: (ctx) => {
                  const val = ctx.raw?.y ?? ctx.parsed?.y;
                  return `mNAV: ${Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(val)}`;
                }
              }
            }
          }
        }
      });
    }

    if (!container.children.length) {
      show(`No plottable mNAV series in the last ${windowDays} days for the selected tickers.`);
    }
  }

  // Initial render (1M)
  render(30);

  // ----- 7) toggles (1M / 3M) -----
  function setActive(btn) {
    document.querySelectorAll(".toggle").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
  }
  document.getElementById("btn-1m")?.addEventListener("click", (e) => {
    setActive(e.currentTarget); render(30);
  });
  document.getElementById("btn-3m")?.addEventListener("click", (e) => {
    setActive(e.currentTarget); render(90);
  });
})();
