// app.js — robust client-side mNAV for all EQ- tickers (v=simple-4)
// mNAV = (Price × Shares) ÷ NAV
// - Shares forward-filled (event-driven). Price & NAV NOT forward-filled.
// - Tolerant to header case, metric aliases (NUM_OF_SHARES, etc.), and $/comma numbers.

console.log("mNAV Pages app loaded: v=simple-4");

(async function () {
  const container = document.getElementById("charts");
  const show = (msg) => (container.innerHTML = `<div class="loading">${msg}</div>`);

  // Dark theme defaults
  Chart.defaults.color = "#e6e6e6";
  Chart.defaults.borderColor = "#2a2d31";

  const url = "./data/dat_data.csv?ts=" + Date.now();

  // ---------- helpers ----------
  const trim = (s) => String(s ?? "").trim();
  const lc = (s) => trim(s).toLowerCase();
  const normMetric = (s) => lc(s).replace(/[^a-z0-9]+/g, "_"); // "NUM_OF_SHARES" -> "num_of_shares"
  const parseNum = (v) => {
    if (v === null || v === undefined || v === "") return NaN;
    // keep digits, ., -, +, and exponent letters; drop $, commas, spaces, etc.
    const t = String(v).replace(/[^0-9eE\.\+\-]/g, "").trim();
    if (t === "" || t === "." || t === "-" || t === "+") return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };
  const parseDate = (s) => {
    const raw = trim(s);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) { // avoid TZ drift
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

  const headersLC = rows.columns.map((c) => lc(c));
  const headerMap = {};
  rows.columns.forEach((orig, i) => (headerMap[orig] = headersLC[i]));

  // Re-key row keys to lowercase, and add a normalized metric key `_m`
  rows = rows.map((r) => {
    const o = {};
    for (const k in r) o[headerMap[k]] = r[k];
    o._m = normMetric(o.metric ?? "");
    return o;
  });

  // ---------- 3) slice base metrics ----------
  // Price aliases are usually just "PRICE"
  const priceRows = rows.filter((r) => oin(r._m, ["price"]));
  // NAV can be "NAV" or "NET_ASSET_VALUE"
  const navRows   = rows.filter((r) => oin(r._m, ["nav", "net_asset_value"]));

  // Shares: accept common Artemis/Sheets variants, but EXCLUDE fully diluted shares
  const sharesRows = rows.filter((r) => {
    const m = r._m;
    if (m.includes("fully") && m.includes("diluted")) return false;
    return (
      oin(m, [
        "number_of_shares_outstanding",
        "number_of_shares",
        "num_of_shares",
        "shares_outstanding",
        "shares"
      ]) ||
      // broad fallback: any metric mentioning "number_of_shares"
      m.includes("number_of_shares")
    );
  });

  if (!priceRows.length || !navRows.length || !sharesRows.length) {
    return show("Missing required inputs: Price, NAV, or Shares (see CSV).");
  }

  // ---------- 4) EQ- ticker columns (lowercased headers) ----------
  const allCols = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => allCols.add(k)));
  const symbols = [...allCols].filter(
    (k) => k !== "date" && k !== "metric" && k !== "_m" && /^eq-/.test(k)
  );
  if (!symbols.length) return show("No EQ- ticker columns found.");

  // ---------- 5) compute mNAV per symbol ----------
  function oin(val, arr) { return arr.includes(val); }

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
  for (const sym of symbols) {
    const pMap = buildMap(priceRows,  sym);
    const nMap = buildMap(navRows,    sym);
    const sMap = buildMap(sharesRows, sym);

    const dates = [...new Set([...pMap.keys(), ...nMap.keys(), ...sMap.keys()])].sort();

    let lastShares;
    const series = [];
    for (const dStr of dates) {
      const d = parseDate(dStr);
      if (!d) continue;

      if (sMap.has(dStr)) {
        const v = sMap.get(dStr);
        if (Number.isFinite(v)) lastShares = v; // forward-fill shares
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
  for (const sym of symbols) {
    const series = bySymbol[sym];
    if (!series || series.length < 2) continue; // skip tickers with insufficient points

    const card = document.createElement("div"); card.className = "card";
    const h2 = document.createElement("h2"); h2.textContent = sym.toUpperCase(); card.appendChild(h2);
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
              title: (items) =>
                items?.[0]?.parsed?.x ? new Date(items[0].parsed.x).toISOString().slice(0,10) : "",
              label: (ctx) =>
                `mNAV: ${Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(ctx.parsed.y)}`
            }
          }
        }
      }
    });

    plotted++;
  }

  if (!plotted) show("No plottable mNAV series (check Price/NAV/Shares names & values).");
})();
