// app.js — mobile-first mNAV dashboard (v=mobile-3)
// - Client-side compute: mNAV = (Price × Shares Outstanding) ÷ NAV
// - Shares forward-filled; Price & NAV NOT forward-filled
// - Per-chart 1M/3M toggles, hover tooltips, 1-col on mobile / 2-col on desktop
// - Small-screen tick density tuning + decimation for perf

console.log("mNAV Pages app loaded: v=mobile-3");

(async function () {
  const container = document.getElementById("charts");
  const show = (msg) => (container.innerHTML = `<div class="loading">${msg}</div>`);

  // Chart.js dark defaults
  Chart.defaults.color = "#e6e6e6";
  Chart.defaults.borderColor = "#2a2d31";

  const url = "./data/dat_data.csv?ts=" + Date.now(); // always fetch fresh CSV
  const DAY_MS = 24 * 60 * 60 * 1000;

  // Desired order (labels without EQ-)
  const ORDER = ["MSTR","MTPLF","SBET","BMNR","DFDV","UPXI"];

  // ---------- helpers ----------
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
  const toDayTS = (s) => {
    const raw = trim(s);
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const ms = Date.parse(raw + "T00:00:00Z"); // UTC midnight to avoid TZ drift
      return Number.isFinite(ms) ? ms : NaN;
    }
    const ms = Date.parse(raw);
    return Number.isFinite(ms) ? ms : NaN;
  };
  const tickerLabel = (sym) => sym.toUpperCase().replace(/^EQ-/, "");
  const isIn = (val, arr) => arr.includes(val);

  // ---------- 1) fetch CSV ----------
  let text;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return show(`Failed to load ${url} — HTTP ${res.status}`);
    text = await res.text();
  } catch (e) { return show(`Failed to fetch ${url}: ${e}`); }

  // ---------- 2) parse & normalize headers (lowercase keys) ----------
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
  const priceRows = rows.filter((r) => isIn(r._m, ["price"]));
  const navRows   = rows.filter((r) => isIn(r._m, ["nav","net_asset_value"]));
  const sharesRows = rows.filter((r) => {
    const m = r._m;
    if (m.includes("fully") && m.includes("diluted")) return false; // exclude FD shares
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

  // ---------- 4) EQ- ticker columns ----------
  const allCols = new Set();
  rows.forEach((r) => Object.keys(r).forEach((k) => allCols.add(k)));
  const allSymbols = [...allCols].filter(
    (k) => k !== "date" && k !== "metric" && k !== "_m" && /^eq-/.test(k)
  );
  if (!allSymbols.length) return show("No EQ- ticker columns found.");

  // Filter & order by ORDER list (skip missing)
  const present = new Map(allSymbols.map(sym => [tickerLabel(sym), sym])); // label -> symbol
  const symbols = ORDER.map(lbl => present.get(lbl)).filter(Boolean);
  if (!symbols.length) return show("Desired tickers not found in CSV.");

  // ---------- 5) compute FULL mNAV series per symbol ----------
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
    const pMap = buildMap(priceRows, sym);
    const nMap = buildMap(navRows,   sym);
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
      const key = new Date(pt.x).toISOString().slice(0,10);
      if (series.length && key === new Date(series[series.length - 1].x).toISOString().slice(0,10)) {
        series[series.length - 1] = pt;
      } else {
        series.push(pt);
      }
    }
    fullBySymbol[sym] = series;
  }

  // ---------- 6) render per chart (with 1M/3M toggles) ----------
  container.innerHTML = "";

  // simple palette
  const palette = ["#79c0ff","#ff7b72","#a5d6ff","#d2a8ff","#ffa657","#56d364","#1f6feb","#e3b341","#ffa198","#7ee787"];
  let colorIndex = 0;

  // adaptive tick density for mobile
  const maxTicks = (axis) => {
    const w = Math.max(320, Math.min(window.innerWidth, 1200));
    if (axis === "x") return w < 380 ? 4 : w < 768 ? 6 : 10;
    return 6;
  };

  const filterWindow = (series, days) => {
    if (!series || !series.length) return [];
    const maxX = series[series.length - 1].x;
    const cutoff = maxX - days * DAY_MS;
    return series.filter((pt) => pt.x >= cutoff);
  };

  for (const sym of symbols) {
    const fullSeries = fullBySymbol[sym];
    if (!fullSeries || fullSeries.length < 2) continue;

    const card = document.createElement("div"); card.className = "card";
    const header = document.createElement("div"); header.className = "card-header";

    const h2 = document.createElement("h2"); h2.textContent = tickerLabel(sym);
    header.appendChild(h2);

    const toggles = document.createElement("div"); toggles.className = "toggle-group";
    const btn1m = document.createElement("button"); btn1m.className = "toggle active"; btn1m.textContent = "1M"; btn1m.dataset.days = "30";
    const btn3m = document.createElement("button"); btn3m.className = "toggle";          btn3m.textContent = "3M"; btn3m.dataset.days = "90";
    toggles.appendChild(btn1m); toggles.appendChild(btn3m);
    header.appendChild(toggles);
    card.appendChild(header);

    const wrap = document.createElement("div"); wrap.className = "canvas-wrap";
    const canvas = document.createElement("canvas"); wrap.appendChild(canvas);
    card.appendChild(wrap);
    container.appendChild(card);

    const color = palette[(colorIndex++) % palette.length];
    let windowDays = 30;

    const chart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: { datasets: [{
        label: "mNAV",
        data: filterWindow(fullSeries, windowDays),
        parsing: false,
        pointRadius: 0,
        borderWidth: 1.5,
        tension: 0.2,
        borderColor: color,
        spanGaps: true
      }]},
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            type: "time",
            time: { unit: "day" },
            grid: { color: "#22252a" },
            ticks: { maxTicksLimit: maxTicks("x") }
          },
          y: {
            grid: { color: "#22252a" },
            ticks: {
              maxTicksLimit: maxTicks("y"),
              callback: (v) => Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v)
            }
          }
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
          },
          // Built-in decimation for smoother mobile rendering on long series
          decimation: {
            enabled: true,
            algorithm: "lttb",
            samples: 200
          }
        }
      }
    });

    // Per-card toggle behavior
    const setActive = (btn) => {
      btn1m.classList.remove("active");
      btn3m.classList.remove("active");
      btn.classList.add("active");
    };
    const updateWindow = (days) => {
      windowDays = days;
      chart.data.datasets[0].data = filterWindow(fullSeries, windowDays);
      chart.update("none");
    };

    btn1m.addEventListener("click", (e) => { e.preventDefault(); setActive(btn1m); updateWindow(30); });
    btn3m.addEventListener("click", (e) => { e.preventDefault(); setActive(btn3m); updateWindow(90); });

    // Re-tune ticks on resize/orientation changes
    window.addEventListener("resize", () => {
      chart.options.scales.x.ticks.maxTicksLimit = maxTicks("x");
      chart.options.scales.y.ticks.maxTicksLimit = maxTicks("y");
      chart.update("none");
    }, { passive: true });
  }

  if (!container.querySelector(".card")) {
    show("No plottable mNAV series for the selected tickers.");
  }
})();
