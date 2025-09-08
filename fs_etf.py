# fs_etf.py — Farside ETF → single CSV (Principled; strict ETH/BTC tickers)
# Outputs (overwrite every run):
#   docs/data/etf_data.csv        (date, metric, BTC, ETH)
#   docs/data/etf_validation.csv  (date, asset, our_sum, site_total, diff)  [audit only]
#
# Behavior:
# - Sum ONLY the USD fund tickers listed below (detected anywhere in header tokens).
# - Ignore unit columns and "Total" in the site table.
# - Recompute cumulative from daily sums.
# - Robust fetch: cloudscraper → curl_cffi → hardened requests.
# - Atomic writes.

from __future__ import annotations
import io, os, re, tempfile
from pathlib import Path
from typing import List, Optional, Tuple

import pandas as pd
import requests
from bs4 import BeautifulSoup

# -------- Source pages (with alternates) --------
BTC_URLS = [
    "https://farside.co.uk/bitcoin-etf-flow-all-data/",
    "https://farside.co.uk/btc/",
]
ETH_URLS = [
    "https://farside.co.uk/ethereum-etf-flow-all-data/",
    "https://farside.co.uk/eth/",
]
ORIGIN = "https://farside.co.uk/"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

# -------- Strict USD fund ticker lists (authoritative) --------
BTC_TICKERS = ["IBIT","FBTC","BITB","ARKB","BTCO","EZBC","BRRR","HODL","BTCW","GBTC"]
ETH_TICKERS = ["ETHA","FETH","ETHW","TETH","ETHV","QETH","EZET","ETHE","ETH"]

# Never sum these labels (by exact lowercased match)
COMMON_EXCLUDE = {
    "date","total","btc","eth","average","maximum","minimum",
    "cumulative","cumulative_usd_millions"
}

REPO_ROOT = Path(__file__).resolve().parent
DOCS_DATA_DIR = REPO_ROOT / "docs" / "data"
DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)

VERBOSE = True
def log(msg: str):
    if VERBOSE:
        print(msg)

# -------- Robust fetch (anti-403) --------
HDRS = {
    "User-Agent": UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
    "Referer": ORIGIN,
    "Upgrade-Insecure-Requests": "1",
}

def get_html(urls: List[str]) -> str:
    def try_cloudscraper(url: str) -> Optional[str]:
        try:
            import cloudscraper
            s = cloudscraper.create_scraper(browser={"browser":"chrome","platform":"mac","mobile":False})
            r = s.get(url, headers=HDRS, timeout=30)
            log(f"[fetch] cloudscraper {url} -> {r.status_code}")
            if r.status_code == 200 and r.text: return r.text
        except Exception as e:
            log(f"[fetch] cloudscraper failed: {e}")
        return None

    def try_curl(url: str) -> Optional[str]:
        try:
            from curl_cffi import requests as cfr
            r = cfr.get(url, headers=HDRS, impersonate="chrome124", timeout=30)
            log(f"[fetch] curl_cffi {url} -> {r.status_code}")
            if r.status_code == 200 and r.text: return r.text
        except Exception as e:
            log(f"[fetch] curl_cffi failed: {e}")
        return None

    def try_requests(url: str) -> Optional[str]:
        s = requests.Session()
        s.headers.update(HDRS)
        try: s.get(ORIGIN, timeout=20)
        except Exception: pass
        try:
            r = s.get(url, timeout=30)
            log(f"[fetch] requests {url} -> {r.status_code}")
            if r.status_code == 200 and r.text: return r.text
        except Exception as e:
            log(f"[fetch] requests failed: {e}")
        return None

    for url in urls:
        for fn in (try_cloudscraper, try_curl, try_requests):
            html = fn(url)
            if html:
                log(f"[fetch] success via {fn.__name__} on {url}")
                return html
    raise RuntimeError("All fetch methods/URLs failed. Install `cloudscraper` and/or `curl_cffi`, or run on GitHub Actions.")

# -------- Parsing helpers --------
def norm(s: str) -> str:
    s = "" if s is None else str(s)
    s = s.replace("\xa0"," ").replace("\u2009"," ")
    return re.sub(r"\s+"," ", s).strip()

def clean_num(x):
    if pd.isna(x): return 0.0
    s = str(x).strip().replace(",", "").replace("\u2009","").replace("\xa0"," ")
    if s in {"","-","–","—"}: return 0.0
    if s.startswith("(") and s.endswith(")"): s = "-" + s[1:-1]
    s = s.replace("−","-")
    try: return float(s)
    except Exception: return 0.0

def parse_tables(html_fragment: str) -> List[pd.DataFrame]:
    dfs: List[pd.DataFrame] = []
    for flavor in ("lxml","html5lib"):
        try:
            found = pd.read_html(io.StringIO(html_fragment), flavor=flavor, thousands=",")
            for df in found:
                if isinstance(df.columns, pd.MultiIndex):
                    df.columns = [" ".join([str(x) for x in tup if str(x) != "nan"]).strip() for tup in df.columns]
                df.columns = [norm(c) for c in df.columns]
                dfs.append(df)
            if dfs: break
        except Exception:
            continue
    return dfs

def find_date_col(df: pd.DataFrame) -> Optional[str]:
    for c in df.columns:
        if c.strip().lower() == "date":
            return c
    best, ratio = None, 0.0
    for c in df.columns:
        ser = pd.to_datetime(df[c], dayfirst=True, errors="coerce")
        r = ser.notna().mean()
        if r > ratio: best, ratio = c, r
    return best if ratio > 0.6 else None

def score_table(df: pd.DataFrame) -> tuple[int,int]:
    n_rows = len(df); n_num = 0
    for c in df.columns:
        if c.strip().lower() == "date": continue
        try:
            vals = pd.Series(df[c]).map(clean_num)
            if (vals != 0).mean() > 0.2: n_num += 1
        except Exception: pass
    return n_rows, n_num

def pick_daily_table(soup: BeautifulSoup) -> Optional[pd.DataFrame]:
    best, best_score = None, (-1,-1)
    for tbl in soup.find_all("table"):
        for df in parse_tables(str(tbl)):
            if not find_date_col(df): continue
            sc = score_table(df)
            if sc > best_score: best, best_score = df, sc
    return best

def load_raw_table(urls: List[str]) -> pd.DataFrame:
    html = get_html(urls)
    soup = BeautifulSoup(html, "lxml")
    df = pick_daily_table(soup)
    if df is None:
        raise RuntimeError(f"Could not find the main daily table for {urls}")
    # drop duplicated columns if any (pandas can add .1 suffixes)
    df = df.loc[:, ~df.columns.duplicated()]
    return df

# -------- Column matching (strict tickers) --------
TOKEN_RE = re.compile(r"[A-Z0-9]+")
def header_tokens(h: str) -> List[str]:
    return TOKEN_RE.findall(h.upper())

def match_columns_by_tickers(df: pd.DataFrame, tickers: List[str]) -> List[str]:
    """
    Return a list of column names that correspond to the given tickers.
    A column qualifies if ANY token in its header equals the ticker (whole-token match).
    If multiple columns match one ticker, pick the first occurrence (avoid double counting).
    """
    chosen = []
    remaining = set(tickers)
    for c in df.columns:
        if c == "date": 
            continue
        if c.strip().lower() in COMMON_EXCLUDE:
            continue
        toks = set(header_tokens(c))
        matched = [t for t in list(remaining) if t in toks]
        if matched:
            # bind this column to the first still-unclaimed ticker it matches
            matched.sort(key=lambda t: tickers.index(t))
            t = matched[0]
            chosen.append(c)
            remaining.remove(t)
            if not remaining:
                break
    return chosen

def select_series_strict(df_raw: pd.DataFrame, asset: str) -> Tuple[pd.Series, pd.Series, pd.Series, List[str]]:
    """
    Returns (dates, our_sum, site_total, used_columns):
      - our_sum   : sum across columns mapped STRICTLY to known tickers
      - site_total: site 'Total' if present (for audit only)
      - used_columns: the dataframe column headers we summed
    """
    df = df_raw.copy()
    dcol = find_date_col(df)
    if not dcol:
        raise RuntimeError("Found table but couldn't detect a date column.")
    df["date"] = pd.to_datetime(df[dcol], dayfirst=True, errors="coerce")
    df = df[df["date"].notna()].drop(columns=[dcol])

    for c in list(df.columns):
        if c == "date": continue
        df[c] = pd.Series(df[c]).map(clean_num)

    tickers = BTC_TICKERS if asset.upper() == "BTC" else ETH_TICKERS
    used_cols = match_columns_by_tickers(df, tickers)

    # If a ticker wasn't found, log it (but continue with the others)
    missing = [t for t in tickers if t not in set().union(*[set(header_tokens(c)) for c in used_cols])]
    if missing:
        log(f"[warn][{asset}] Missing tickers (not found in column headers): {missing}")

    our_sum = df[used_cols].sum(axis=1) if used_cols else pd.Series([0.0]*len(df), index=df.index)

    # Site Total (if present) — for audit only
    site_total_col = next((c for c in df.columns if c.strip().lower() == "total"), None)
    if site_total_col is None:
        site_total_col = next((c for c in df.columns if "total" in c.strip().lower() and "cum" not in c.strip().lower()), None)
    site_total = df[site_total_col] if site_total_col is not None else pd.Series([float("nan")]*len(df), index=df.index)

    log(f"[columns][{asset}] Using {len(used_cols)} columns: {used_cols}")
    return df["date"], our_sum, site_total, used_cols

def daily_frame(dates: pd.Series, totals: pd.Series) -> pd.DataFrame:
    df = pd.DataFrame({"date": dates, "total": totals})
    full = pd.date_range(df["date"].min(), df["date"].max(), freq="D")
    df = (df.set_index("date").reindex(full).fillna(0.0).rename_axis("date").reset_index())
    return df

# -------- Build & write (atomic) --------
def atomic_write_csv(df: pd.DataFrame, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", delete=False, dir=str(path.parent), suffix=".tmp") as tmp:
        df.to_csv(tmp.name, index=False)
        tmp.flush()
        os.fsync(tmp.fileno())
        tmp_path = Path(tmp.name)
    tmp_path.replace(path)

def build_and_write():
    # Pull raw tables
    btc_raw = load_raw_table(BTC_URLS)
    eth_raw = load_raw_table(ETH_URLS)

    # Strict sums + capture site totals (audit)
    btc_dates, btc_our, btc_site, btc_cols = select_series_strict(btc_raw, "BTC")
    eth_dates, eth_our, eth_site, eth_cols = select_series_strict(eth_raw, "ETH")

    # Daily frames with continuous dates
    btc_daily = daily_frame(btc_dates, btc_our)  # date,total
    eth_daily = daily_frame(eth_dates, eth_our)  # date,total

    # Outer union of dates → fill 0.0
    full_dates = pd.date_range(
        min(btc_daily["date"].min(), eth_daily["date"].min()),
        max(btc_daily["date"].max(), eth_daily["date"].max()),
        freq="D"
    )
    btc_daily = btc_daily.set_index("date").reindex(full_dates).fillna(0.0).rename_axis("date").reset_index()
    eth_daily = eth_daily.set_index("date").reindex(full_dates).fillna(0.0).rename_axis("date").reset_index()

    # Assemble output (long format + cumulative from daily)
    daily = pd.DataFrame({
        "date": btc_daily["date"],
        "BTC":  btc_daily["total"],
        "ETH":  eth_daily["total"],
    }).sort_values("date")

    cum = daily.copy()
    cum["BTC"] = cum["BTC"].cumsum()
    cum["ETH"] = cum["ETH"].cumsum()

    # Round for readability
    daily_out = daily.copy()
    cum_out   = cum.copy()
    for col in ["BTC","ETH"]:
        daily_out[col] = daily_out[col].round(1)
        cum_out[col]   = cum_out[col].round(1)

    daily_out["metric"] = "etf_net_flow_usd_millions"
    cum_out["metric"]   = "etf_cumulative_net_flow_usd_millions"

    out = pd.concat(
        [daily_out[["date","metric","BTC","ETH"]], cum_out[["date","metric","BTC","ETH"]]],
        ignore_index=True
    ).sort_values(["date","metric"]).reset_index(drop=True)

    out["date"] = pd.to_datetime(out["date"]).dt.strftime("%Y-%m-%d")

    # Write main CSV
    etf_path = DOCS_DATA_DIR / "etf_data.csv"
    atomic_write_csv(out, etf_path)
    print(f"Wrote: {etf_path.relative_to(REPO_ROOT)}  (rows={len(out)})")

    # Validation CSV (if the site has a 'Total' column)
    btc_val = pd.DataFrame({"date": btc_dates, "asset": "BTC", "our_sum": btc_our, "site_total": btc_site})
    eth_val = pd.DataFrame({"date": eth_dates, "asset": "ETH", "our_sum": eth_our, "site_total": eth_site})
    val = pd.concat([btc_val, eth_val], ignore_index=True)
    val = val[pd.notna(val["site_total"])].copy()
    if not val.empty:
        val["date"] = pd.to_datetime(val["date"]).dt.strftime("%Y-%m-%d")
        val["diff"] = val["our_sum"] - val["site_total"]
        for c in ["our_sum","site_total","diff"]:
            val[c] = val[c].round(1)
        audit_path = DOCS_DATA_DIR / "etf_validation.csv"
        atomic_write_csv(val[["date","asset","our_sum","site_total","diff"]], audit_path)
        print(f"Wrote: {audit_path.relative_to(REPO_ROOT)}  (rows={len(val)})")
    else:
        print("No site total column detected; validation CSV not written.")

if __name__ == "__main__":
    build_and_write()
