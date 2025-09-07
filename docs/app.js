// app.js — diag build (v=diag-1): compute mNAV from Price, Shares (ffill), NAV
// and show a diagnostics panel (metrics found, tickers, point counts).

console.log("mNAV Pages app loaded: v=diag-1", new Date().toISOString());

(async function () {
  const container = document.getElementById("charts");
  const show = (msg) => { container.innerHTML = `<div class="loading">${msg}</div>`; };

  // Dark theme for Chart.js
  Chart.defaults.color = "#e6e6e6";
  Chart.defaults.borderColor = "#2a2d31";

  const url = "./data/dat_data.csv?ts=" + Date.now();

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
    const raw = String(s || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) { // avoid TZ shifts
      const d = new Date(raw + "T00:00:00Z");
      return isNaN(d) ? null : d;
    }
    const d = new Date(raw);
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

  // normalize headers & rows
  const headers = rows.columns.map(cleanHeader);
  const headerMap = {};
  rows.columns.forEach((orig, i) => (headerMap[orig] = headers[i]));
  rows = rows.map((r) => {
    const o = {};
    for (const k in r) o[headerMap[k]] = r[k];
    return o;
  });

  // metric blocks
  const priceRows  = rows.filter((r) => lc(r.metric) === "price");
  const navRows    = rows.filter((r) => ["net asset value","nav"].includes(lc(r.metric)));
  const sharesRows = rows.filter((r) => lc(r.metric).includes("number of shares"));

  // EQ- columns
  const allCols = new Set(); rows.forEach(r => Object.keys(r).forEach(k => allCols.add(k)));
  const symbols = [...allCols].filter(k => k !== "date" && k !== "metric" && /^eq-/i.test(k));

  // DIAGNOSTICS PANEL
  const diag = document.createElement("div");
  diag.className = "card";
  diag.innerHTML = `
    <h2>Diagnostics</h2>
    <div style="font-size:13px; line-height:1.5">
      <div>rows: <b>${rows.length}</b></div>
      <div>columns: <code>${headers.join(", ")}</code></div>
      <div>metrics found: <code>${[...new Set(rows.map(r => lc(r.metric)))].join(", ")}</code></div>
      <div>has Price: <b>${!!priceRows.length}</b>,
           has NAV: <b>${!!navRows.length}</b>,
           has Shares: <b>${!!sharesRows.length}</b></div>
      <div>EQ tickers: <code>${symbols.join(", ") || "(none)"}</code></div>
    </div>`;
  const top = document.getElementById("charts");
  top.parentNode.insertBefore(diag, top);

  if (!priceRows.length || !navRows.length || !sharesRows.length) {
    return show("Missing required inputs (see diagnostics above).");
  }
  if (!symbols.length) return show("No EQ- ticker columns found.");

  // per-metric maps
  function buildMap(blockRows, sym) {
    const m = new Map();
    for (const r of blockRows) {
      const dStr = String(r.date).trim();
      const y = parseNum(r[sym]);
      if (Number.isFinite(y) && dStr) m.set(dStr, y);
    }
    return m;
  }

  // 3) compute mNAV per symbol
  const bySymbol = {};
  const counts = {};
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

    // dedupe by day (keep last)
    const dedup = [];
    let lastKey = "";
    for (const pt of series) {
      const key = pt.x.toISOString().slice(0,10);
      if (dedup.length && key === lastKey) dedup[dedup.length - 1] = pt;
      else { dedup.push(pt); lastKey = key; }
    }

    bySymbol[sym] = dedup;
    counts[sym] = dedup.length;
  }

  // add counts to diagnostics
  const countsDiv = document.createElement("div");
  countsDiv.style.cssText = "font-size:13px; line-height:1.4; margin-top:8px;";
  countsDiv.innerHTML = "<div><b>mNAV points per ticker:</b></div>" +
    Object.entries(counts).sort().map(([k,v]) => `<div>${k}: ${v}</div>`).join("");
  diag.appendChild(countsDiv);

  // 4) draw charts
  container.innerHTML = "";

  const palette = ["#79c0ff","#ff7b72","#a5d6ff","#d2a8ff","#ffa657","#56d364","#1f6feb","#e3b341","#ffa198","#7ee787"];
  let colorIdx = 0; const nextColor = () => palette[(colorIdx++) % palette.length];

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

    new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        datasets: [{
          label: "mNAV",
          data: series,
          borderWidth: 1.5,
          pointRadius: 0,
          tension: 0.2,
          borderColor: nextColor()
        }]
      },
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
              title: (items) => items?.[0]?.parsed?.x
                ? new Date(items[0].parsed.x).toISOString().slice(0,10)
                : "",
              label: (ctx) => `mNAV: ${Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(ctx.parsed.y)}`
            }
          }
        }
      }
    });

    plotted++;
  }

  if (!plotted) show("No plottable mNAV series (see diagnostics above).");
})();
