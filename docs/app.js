// app.js — bulletproof client-side mNAV (v=force-5)
// mNAV = (Price × Number of Shares Outstanding) ÷ NAV
// - Shares forward-filled; Price & NAV NOT forward-filled
// - Robust to header casing, metric aliases, commas/$, etc.
// - Dates converted to timestamps for Chart.js time scale
// - Per-card badge shows coverage & last value

console.log("mNAV Pages app loaded: v=force-5");

(async function () {
  const container = document.getElementById("charts");
  const show = (msg) => (container.innerHTML = `<div class="loading">${msg}</div>`);

  // Dark theme
  Chart.defaults.color = "#e6e6e6";
  Chart.defaults.borderColor = "#2a2d31";

  const url = "./data/dat_data.csv?ts=" + Date.now();

  // ---------- helpers ----------
  const trim = (s) => String(s ?? "").trim();
  const lc = (s) => trim(s).toLowerCase();
  const normMetric = (s) => lc(s).replace(/[^a-z0-9]+/g, "_");
  const parseNum = (v) => {
    if (v === null || v === undefined || v === "") return NaN;
    const t = String(v).replace(/[^0-9eE.\-+]/g, ""); // keep digits, ., +, -, e/E
    if (!t || t === "." || t === "-" || t === "+") return NaN;
    const n = Number(t);
    return Number.isFinite(n) ? n : NaN;
  };
  // Return UNIX ms (number), not Date object
  const toDayTS = (s) => {
    const raw = trim(s);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      // Parse as UTC midnight → ms
      const ms = Date.parse(raw + "T00:00:00Z");
      return Number.isFinite(ms) ? ms : NaN;
    }
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : NaN;
  };

  // ---------- 1) fetch CSV ----------
  let text;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return show(`Failed to load ${url} — HTTP ${res.status}`);
    text = await res.text();
  } catch (e) { return show(`Failed to fetch ${url}: ${e}`); }

  // ---------- 2) parse & lowercase headers ----------
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

  // ---------- 3) base metrics ----------
  const isIn = (val, arr) => arr.includes(val);
  const priceRows = rows.filter((r) => isIn(r._m, ["price"]));
  const navRows   = rows.filter((r) => isIn(r._m, ["nav", "net_asset_value"]));

  // Shares: accept common names; EXCLUDE fully-diluted
  const sharesRows = rows.filter((r) => {
    const m = r._m;
    if (m.includes("fully") && m.includes("diluted")) return false;
    return isIn(m, [
      "number_of_shares_outstanding",
      "number_of_shares",
      "num_of_shares",
      "shares_outstanding",
      "shares"
    ]) || m.includes("number_of_shares");
  });

  if (!priceRows.length || !navRows.length || !sharesRows.length) {
    return show("Missing required inputs: Price, NAV, or Shares.");
  }

  // ---------- 4) EQ- ticker columns ----------
  const allCols = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => allCols.add(k)));
  const symbols = [...allCols].filter(
    (k) => k !== "date" && k !== "metric" && k !== "_m" && /^eq-/.test(k)
  );
  if (!symbols.length) return show("No EQ- ticker columns found.");

  // ---------- 5) compute mNAV per symbol ----------
  function buildMap(blockRows, sym) {
    const m = new Map(); // key: YYYY-MM-DD -> number
    for (const r of blockRows) {
      const dStr = trim(r.date);
      if (!dStr) continue;
      const y = parseNum(r[sym]);
      if (Number.isFinite(y)) m.set(dStr, y);
    }
    return m;
  }

  const bySymbol = {};
  const stats = {}; // for badges

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
        if (Number.isFinite(v)) lastShares = v; // ffill shares
      }
      const price = pMap.get(dStr);
      const nav   = nMap.get(dStr);

      if (Number.isFinite(price) && Number.isFinite(nav) && nav !== 0 && Number.isFinite(lastShares)) {
        raw.push({ x: ts, y: (price * lastShares) / nav });
      }
    }

    // de-dupe by calendar day (keep last)
    raw.sort((a, b) => a.x - b.x);
    const series = [];
    let lastKey = -1;
    for (const pt of raw) {
      const key = new Date(pt.x).toISOString().slice(0, 10);
      if (series.length && key === new Date(series[series.length - 1].x).toISOString().slice(0, 10)) {
        series[series.length - 1] = pt;
      } else {
        series.push(pt);
      }
    }

    bySymbol[sym] = series;
    if (series.length) {
      const last = series[series.length - 1];
      stats[sym] = {
        points: series.length,
        lastDate: new Date(last.x).toISOString().slice(0, 10),
        lastVal: last.y
      };
    } else {
      stats[sym] = { points: 0 };
    }
  }

  // ---------- 6) render ----------
  container.innerHTML = "";
  const palette = ["#79c0ff","#ff7b72","#a5d6ff","#d2a8ff","#ffa657","#56d364","#1f6feb","#e3b341","#ffa198","#7ee787"];
  let i = 0; const nextColor = () => palette[(i++) % palette.length];

  let plotted = 0;
  for (const sym of symbols) {
    const series = bySymbol[sym];
    if (!series || series.length < 2) continue;

    const card = document.createElement("div"); card.className = "card";
    const top = document.createElement("div"); top.style.display = "flex"; top.style.justifyContent = "space-between"; top.style.alignItems = "baseline";
    const h2 = document.createElement("h2"); h2.textContent = sym.toUpperCase();
    const badge = document.createElement("div");
    const s = stats[sym] || {};
    badge.style.fontSize = "12px"; badge.style.opacity = "0.8";
    badge.textContent = s.points ? `${s.points} pts · ${s.lastDate} · ${s.lastVal.toFixed(2)}` : "0 pts";
    top.appendChild(h2); top.appendChild(badge); card.appendChild(top);

    const wrap = document.createElement("div"); wrap.className = "canvas-wrap";
    const canvas = document.createElement("canvas"); wrap.appendChild(canvas);
    card.appendChild(wrap); container.appendChild(card);

    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        datasets: [{
          label: "mNAV",
          data: series,         // [{x: timestamp(ms), y: number}]
          parsing: false,
          pointRadius: 0,
          borderWidth: 1.5,
          tension: 0.2,
          borderColor: nextColor(),
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
            mode: "index", intersect: false,
            callbacks: {
              title: (items) => items?.[0]?.parsed?.x
                ? new Date(items[0].parsed.x).toISOString().slice(0,10) : "",
              label: (ctx) => `mNAV: ${Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(ctx.parsed.y)}`
            }
          }
        }
      }
    });

    plotted++;
  }

  if (!plotted) {
    // If we still plot nothing, tell you exactly what we saw so you can copy from console.
    console.warn("No plottable series. Symbols:", symbols);
    console.warn("Stats per symbol:", stats);
    show("No plottable mNAV series (hover the console for details).");
  }
})();
