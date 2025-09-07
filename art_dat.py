"""
Digital Asset Treasuries (equities) → one wide CSV for many UI metrics.

Policy:
- Only locally computed metric: mNAV = (Price * NUM_OF_SHARES) / NAV  [shares ffilled; price/nav not ffilled]
- Everything else must come directly from the Artemis API.
  * "MC / Nav": API-only composite (e.g., M_NAV/MC_NAV/MC/NAV...). No local MC÷NAV.
  * "FDMC / NAV": API-only composite (e.g., FDM_NAV/FDMC_NAV...). No local FDMC÷NAV.
  * Singles (Price, NAV, NUM_OF_SHARES, FDMC, FD Shares, Volume, Debts, etc.): API-only.

Outputs:
  ./docs/data/dat_data.csv
  ./docs/data/dat_data_mapping.json

Run:
  /Users/angelogoepel/td_v2/.venv/bin/python /Users/angelogoepel/td_v2/dat_data.py
"""

import os, sys, csv, json, re
from datetime import date
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from dotenv import load_dotenv

# ------------------ EDIT ME ------------------
EQUITIES = ["SBET", "MSTR", "DFDV", "UPXI", "MTPLF", "BMNR"]  # with or without EQ-
UI_LABELS = [
    "mNAV",                    # computed (only local calc)
    "MC / Nav",                # API-only composite
    "FDMC / NAV",              # API-only composite
    "Net Asset Value",
    "Fully Diluted Market Cap",
    "Fully Diluted Shares",
    "Number of Shares Outstanding",
    "Price",
    "Stock Trading Volume",
    "Convertible Debt",
    "Convertible Debt Shares",
    "Non-Convertible Debt",
    "Historical Volatility",
    "Number of Tokens Held",
    "Token Per Share",
    "Warrants",
]
# ---------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
ENV_PATH   = SCRIPT_DIR / ".env"
OUT_DIR    = SCRIPT_DIR / "docs" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)
CSV_PATH   = OUT_DIR / "dat_data.csv"
MAP_PATH   = OUT_DIR / "dat_data_mapping.json"
OLD_MAP    = OUT_DIR / "dat_equities_mapping.json"  # merged if present

load_dotenv(ENV_PATH)
API_KEY = os.getenv("ARTEMIS_API_KEY")
if not API_KEY:
    print(f"ERROR: Missing ARTEMIS_API_KEY in {ENV_PATH}", file=sys.stderr)
    sys.exit(1)

# Artemis SDK
try:
    from artemis import Artemis
except Exception as e:
    print("ERROR: Could not import Artemis SDK. Install:\n"
          "  pip install artemis python-dotenv\n"
          f"Import error: {e}", file=sys.stderr)
    sys.exit(1)

client = Artemis(api_key=API_KEY)

# ---------------- utilities ----------------
def ensure_eq_prefix(x: str) -> str:
    x = x.strip()
    return x if x.upper().startswith("EQ-") else f"EQ-{x.upper()}"

def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower()) if isinstance(s, str) else ""

# Quiet, robust payload extraction (avoids Pydantic warnings)
def payload_from_resp(resp) -> Dict[str, Any]:
    if resp is None:
        return {}
    data = getattr(resp, "data", None)
    if isinstance(data, dict):
        return data
    if hasattr(data, "model_dump"):  # pydantic v2
        try:
            return data.model_dump(mode="python", warnings=False)
        except Exception:
            pass
    if hasattr(data, "dict"):  # pydantic v1
        try:
            return data.dict()
        except Exception:
            pass
    if hasattr(resp, "model_dump"):
        try:
            d = resp.model_dump(mode="python", warnings=False)
            return d.get("data", d) if isinstance(d, dict) else {}
        except Exception:
            pass
    if hasattr(resp, "dict"):
        try:
            d = resp.dict()
            return d.get("data", d) if isinstance(d, dict) else {}
        except Exception:
            pass
    return {}

# Singles → preferred Artemis keys (Sheets-first) then common aliases
SINGLE_LABEL_KEYS: Dict[str, List[str]] = {
    "Net Asset Value": ["NAV", "netassetvalue"],
    "Fully Diluted Market Cap": ["FULLY_DILUTED_MARKET_CAP", "fullydilutedmarketcap", "fdmc"],
    "Fully Diluted Shares": ["FULLY_DILUTED_SHARES", "fullydilutedshares", "fdshares", "fds"],
    "Number of Shares Outstanding": ["NUM_OF_SHARES", "SHARES_OUTSTANDING", "OUTSTANDING_SHARES", "SHARES_OUT", "sharesoutstanding", "shares_outstanding"],
    "Price": ["PRICE", "equityprice", "stockprice"],
    "Stock Trading Volume": ["SHARE_VOLUME", "stocktradingvolume", "equityvolume", "volume", "stockvolume", "tradingvolume"],
    "Convertible Debt": ["CONVERTIBLE_DEBT", "convertibledebt", "convdebt"],
    "Convertible Debt Shares": ["CONVERTIBLE_DEBT_SHARES", "convertibledebtshares", "convdebtshares"],
    "Non-Convertible Debt": ["NON_CONVERTIBLE_DEBT", "non_convertible_debt", "nonconvertibledebt", "nonconvdebt"],
    "Historical Volatility": ["HISTORICAL_VOLATILITY", "historicalvolatility", "volatility", "hv"],
    "Number of Tokens Held": ["NUM_OF_TOKENS", "numberoftokensheld", "tokensheld", "assetsholding", "tokenheld", "coinsheld"],
    "Token Per Share": ["TOKEN_PER_SHARE", "tokenpershare", "assetpershare", "coinpershare"],
    "Warrants": ["WARRENTS", "warrants", "warrents", "warrantcount"],  # API uses WARRENTS
}

# Composites → API-only keys (NO derivation)
COMPOSITE_LABEL_KEYS: Dict[str, List[str]] = {
    "MC / Nav":   ["M_NAV", "MC_NAV", "MC/NAV", "MARKET_CAP_NAV", "market_cap_nav", "mcnav", "mnav"],
    "FDMC / NAV": ["FDM_NAV", "FDMC_NAV", "FDMC/NAV", "FDMC_NAV_RATIO", "fdmcnav", "fdmnav"],
}

def list_supported_metrics(symbol: str) -> List[str]:
    """Return metric keys for a symbol if allowed; else []."""
    try:
        resp = client.asset.list_supported_metrics(symbol=symbol)
        d = payload_from_resp(resp)
        items = d.get("metrics") or d.get("data", {}).get("metrics") or []
        keys: List[str] = []
        for item in items:
            if isinstance(item, dict):
                keys.extend([str(k) for k in item.keys()])
            elif isinstance(item, str):
                keys.append(item)
        return keys
    except Exception:
        return []

def fetch_series(metric_key: str, symbols_csv: str, start: str, end: str) -> Dict[str, List[Dict[str, Any]]]:
    """Fetch {SYMBOL: [{date,val},...]} for a metric across symbols."""
    try:
        resp = client.fetch_metrics(metric_names=metric_key, symbols=symbols_csv,
                                    startDate=start, endDate=end)
    except TypeError:
        resp = client.fetch_metrics(metric_names=metric_key, symbols=symbols_csv,
                                    start_date=start, end_date=end)
    d = payload_from_resp(resp)
    symbols = d.get("symbols", {})
    out: Dict[str, List[Dict[str, Any]]] = {}
    for sym, subtree in symbols.items():
        series = subtree.get(metric_key, [])
        rows = []
        if isinstance(series, list):
            for pt in series:
                dd, vv = pt.get("date"), pt.get("val")
                if dd is not None and vv is not None:
                    rows.append({"date": str(dd), "val": float(vv)})
        out[str(sym).upper()] = rows
    return out

# ---- CSV helpers (wide: date, metric, EQ-...) ----
def read_table(path: Path) -> Tuple[Dict[Tuple[str,str], Dict[str,float]], List[str]]:
    table: Dict[Tuple[str,str], Dict[str,float]] = {}
    cols: List[str] = []
    if not path.exists(): return table, cols
    with path.open("r", newline="") as f:
        rdr = csv.DictReader(f)
        cols = [c for c in (rdr.fieldnames or []) if c not in ("date","metric")]
        for row in rdr:
            d = row.get("date"); m = row.get("metric")
            if not d or not m: continue
            key = (d, m)
            cell = table.get(key, {})
            for c in cols:
                val = row.get(c)
                if val not in (None, "", "NaN"):
                    try: cell[c] = float(val)
                    except: pass
            table[key] = cell
    return table, cols

def write_table(path: Path, table: Dict[Tuple[str,str], Dict[str,float]], symbols: List[str]) -> None:
    existing = set()
    for _, row in table.items():
        existing.update(row.keys())
    extras = sorted([s for s in existing if s not in symbols])
    header_syms = symbols + extras
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["date","metric"] + header_syms)
        for (d, m) in sorted(table.keys(), key=lambda x: (x[0], x[1])):
            row = [d, m]
            cells = table[(d, m)]
            for s in header_syms:
                v = cells.get(s)
                row.append("" if v is None else f"{v:.10f}")
            w.writerow(row)

# ---------------- main flow ----------------
def main() -> None:
    symbols = [ensure_eq_prefix(s) for s in EQUITIES]
    symbol_csv = ",".join(symbols)

    # Merge prior mappings (keep manual edits)
    prior_map: Dict[str, Dict[str, Optional[str]]] = {}
    for p in (OLD_MAP, MAP_PATH):
        if p.exists():
            try:
                d = json.loads(p.read_text())
                if isinstance(d, dict):
                    for sym, labmap in d.items():
                        prior_map.setdefault(sym, {}).update(labmap)
            except Exception:
                pass

    # Enumerate available keys (if allowed)
    available_by_sym = {sym: list_supported_metrics(sym) for sym in symbols}
    available_norm_by_sym = {sym: {norm(k): k for k in (available_by_sym.get(sym) or [])} for sym in symbols}

    mapping: Dict[str, Dict[str, Optional[str]]] = {sym: {} for sym in symbols}

    def choose_key_from_candidates(sym: str, candidates: List[str], prior: Optional[str]) -> Optional[str]:
        avail_norm = available_norm_by_sym.get(sym) or {}
        # keep prior if still available
        if prior and norm(prior) in avail_norm:
            return avail_norm[norm(prior)]
        # first available candidate
        for cand in candidates:
            nk = norm(cand)
            if nk in avail_norm:
                return avail_norm[nk]
        # otherwise return first candidate (we'll try to fetch)
        return candidates[0] if candidates else None

    # Decide mapping for composites and singles
    for sym in symbols:
        # API-only composites
        for label in ("MC / Nav", "FDMC / NAV"):
            prior = (prior_map.get(sym) or {}).get(label)
            key = choose_key_from_candidates(sym, COMPOSITE_LABEL_KEYS[label], prior)
            mapping[sym][label] = key  # may be None → we won't derive/fill

        # Singles
        for label, cand_list in SINGLE_LABEL_KEYS.items():
            prior = (prior_map.get(sym) or {}).get(label)
            mapping[sym][label] = choose_key_from_candidates(sym, cand_list, prior)

        # mNAV is always computed (record intent)
        mapping[sym]["mNAV"] = "DERIVED(PRICE*NUM_OF_SHARES/NAV)"

    # ---- Fetch data ----
    table, _ = read_table(CSV_PATH)
    start = "1970-01-01"
    today = date.today().isoformat()

    direct_keys: Dict[str, List[str]] = {}
    def add_key_for_symbols(key: str, sym_list: List[str]):
        if not key: return
        direct_keys.setdefault(key, [])
        for s in sym_list:
            if s not in direct_keys[key]:
                direct_keys[key].append(s)

    # Add mapped keys for all non-derived labels (singles + composites that exist)
    for sym in symbols:
        for label in UI_LABELS:
            if label == "mNAV":
                continue
            mk = mapping[sym].get(label)
            if mk:  # API-only: only fetch if we have a concrete key
                add_key_for_symbols(mk, [sym])

        # Ensure bases for mNAV are fetched
        for base_label in ("Price", "Number of Shares Outstanding", "Net Asset Value"):
            mk = mapping[sym].get(base_label)
            if mk:
                add_key_for_symbols(mk, [sym])

    # Fetch all direct keys
    for metric_key, syms in direct_keys.items():
        series_map = fetch_series(metric_key, ",".join(sorted(set(syms))), start, today)
        for symU, series in series_map.items():
            for pt in series:
                row_key = (pt["date"], metric_key)  # temp keyed by raw metric key
                row = table.get(row_key, {})
                row[symU] = pt["val"]
                table[row_key] = row

    # Build final rows (labels), including computed mNAV
    final_rows: Dict[Tuple[str,str], Dict[str,float]] = {}
    all_dates = sorted({d for (d, m) in table.keys()})

    def get_cell(d: str, key: Optional[str], sym: str) -> Optional[float]:
        if not key:
            return None
        r = table.get((d, key), {})
        v = r.get(sym)
        return v if isinstance(v, float) else None

    # Precompute forward-filled shares per symbol for mNAV
    shares_key_by_sym = {s: mapping[s].get("Number of Shares Outstanding") for s in symbols}
    price_key_by_sym  = {s: mapping[s].get("Price") for s in symbols}
    nav_key_by_sym    = {s: mapping[s].get("Net Asset Value") for s in symbols}

    ffilled_shares: Dict[Tuple[str,str], Optional[float]] = {}
    for sym in symbols:
        skey = shares_key_by_sym.get(sym)
        last_val: Optional[float] = None
        for d in all_dates:
            cur = get_cell(d, skey, sym)
            if cur is not None:
                last_val = cur
            ffilled_shares[(d, sym)] = last_val  # may be None until first seen

    # 1) mNAV (computed)
    for d in all_dates:
        row = final_rows.get((d, "mNAV"), {})
        for sym in symbols:
            pkey, nkey = price_key_by_sym.get(sym), nav_key_by_sym.get(sym)
            price  = get_cell(d, pkey, sym)
            shares = ffilled_shares.get((d, sym))
            nav    = get_cell(d, nkey, sym)
            if (price is not None) and (shares is not None) and (nav not in (None, 0.0)):
                row[sym] = (price * shares) / nav
        if row:
            final_rows[(d, "mNAV")] = row

    # 2) API-only composites
    for label in ("MC / Nav", "FDMC / NAV"):
        for d in all_dates:
            row = final_rows.get((d, label), {})
            for sym in symbols:
                mapped = mapping.get(sym, {}).get(label)
                if mapped:
                    v = get_cell(d, mapped, sym)
                    if v is not None:
                        row[sym] = v
            if row:
                final_rows[(d, label)] = row

    # 3) Singles passthrough
    for label in UI_LABELS:
        if label in ("mNAV", "MC / Nav", "FDMC / NAV"):
            continue
        for d in all_dates:
            row = final_rows.get((d, label), {})
            for sym in symbols:
                mk = mapping.get(sym, {}).get(label)
                v = get_cell(d, mk, sym)
                if v is not None:
                    row[sym] = v
            if row:
                final_rows[(d, label)] = row

    # Write outputs
    write_table(CSV_PATH, final_rows, symbols)
    MAP_PATH.write_text(json.dumps(mapping, indent=2))
    print(f"Wrote -> {CSV_PATH}")
    print(f"Updated mapping -> {MAP_PATH}")

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(2)
