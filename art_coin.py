"""
Unified Artemis puller: one CSV with tokens as columns, metrics as rows.

Edit these lists (non-technical friendly):
  TOKENS  = ["ETH", "BTC", "USDT", "USDC"]
  METRICS = ["price"]   # later you can add: ["price", "mc", "circ_supply"]

Output (for GitHub Pages):
  ./docs/data/token_data.csv  with columns:
    date, metric, <TOKEN1>, <TOKEN2>, ...

Behavior:
- First run: backfills earliest->today (API trims to each token/metric's true start).
- Next runs: per metric, resumes from max saved date + 1 day.
- If you add a new token or metric later, it backfills that one automatically.

Usage (hourly-safe):
  /Users/angelogoepel/td_v2/.venv/bin/python /Users/angelogoepel/td_v2/token_data.py
"""

import os
import sys
import csv
import json
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from dotenv import load_dotenv

# -------------------- EDIT ME --------------------
TOKENS  = ["ETH", "BTC", "USDC"]     # add/remove tickers here
METRICS = ["price"]          # e.g., ["price", "mc", "circ_supply"]
# ------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
ENV_PATH   = SCRIPT_DIR / ".env"
OUT_DIR    = SCRIPT_DIR / "docs" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)
CSV_PATH   = OUT_DIR / "token_data.csv"

load_dotenv(ENV_PATH)
API_KEY = os.getenv("ARTEMIS_API_KEY")
if not API_KEY:
    print(f"ERROR: Missing ARTEMIS_API_KEY in {ENV_PATH}", file=sys.stderr)
    sys.exit(1)

# Artemis SDK
try:
    from artemis import Artemis
except Exception as e:
    print("ERROR: Could not import Artemis SDK. Install it:\n"
          "  pip install artemis python-dotenv\n"
          f"Import error: {e}", file=sys.stderr)
    sys.exit(1)

client = Artemis(api_key=API_KEY)

# ---------- Helpers ----------
def to_dict(obj: Any) -> Optional[dict]:
    """Pydantic model → dict (v2 .model_dump, v1 .dict), else JSON fallback."""
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "model_dump"):
        try:
            return obj.model_dump()
        except Exception:
            pass
    if hasattr(obj, "dict"):
        try:
            return obj.dict()
        except Exception:
            pass
    if hasattr(obj, "json"):
        try:
            return json.loads(obj.json())
        except Exception:
            pass
    return None

def chunk(lst: List[str], n: int) -> List[List[str]]:
    return [lst[i:i+n] for i in range(0, len(lst), n)]

def fetch_metric_for_tokens(metric: str, tokens: List[str], start: str, end: str) -> Dict[str, List[Dict[str, Any]]]:
    """
    Fetch timeseries for one metric across multiple tokens.
    Returns: { TOKEN_UPPER: [ {date, val}, ... ], ... }
    """
    series_by_token: Dict[str, List[Dict[str, Any]]] = {}
    if not tokens:
        return series_by_token

    for batch in chunk(tokens, 100):  # adjust if needed
        sym_csv = ",".join(batch)
        try:
            resp = client.fetch_metrics(metric_names=metric, symbols=sym_csv,
                                        startDate=start, endDate=end)
        except TypeError:
            resp = client.fetch_metrics(metric_names=metric, symbols=sym_csv,
                                        start_date=start, end_date=end)

        m = to_dict(resp) or to_dict(getattr(resp, "data", None))
        if not m:
            raise RuntimeError(f"[{metric}] Unable to serialize Artemis response to dict.")

        payload = m.get("data", m)
        symbols = payload.get("symbols", {})
        symbols_l = {str(k).lower(): v for k, v in symbols.items()}

        for tok in batch:
            key = tok.lower()
            asset = symbols_l.get(key)
            out: List[Dict[str, Any]] = []
            if isinstance(asset, dict):
                series = asset.get(metric)
                if isinstance(series, list):
                    for pt in series:
                        d = pt.get("date")
                        v = pt.get("val")
                        if d is not None and v is not None:
                            out.append({"date": str(d), "val": float(v)})
            series_by_token[tok.upper()] = out

    return series_by_token

# Table representation: {(date, metric): {TOKEN: value, ...}}
def read_existing_table(path: Path) -> Tuple[Dict[Tuple[str, str], Dict[str, float]], List[str]]:
    """
    Read existing CSV into:
      table[(date, metric)] = { TOKEN: value, ... }
    and return (table, existing_token_columns_in_order)
    """
    table: Dict[Tuple[str, str], Dict[str, float]] = {}
    token_cols: List[str] = []
    if not path.exists():
        return table, token_cols

    with path.open("r", newline="") as f:
        rdr = csv.DictReader(f)
        token_cols = [c for c in (rdr.fieldnames or []) if c not in ("date", "metric")]
        for row in rdr:
            d = row.get("date")
            m = row.get("metric")
            if not d or not m:
                continue
            key = (d, m)
            rowmap = table.get(key, {})
            for t in token_cols:
                val = row.get(t)
                if val not in (None, "", "NaN"):
                    try:
                        rowmap[t.upper()] = float(val)
                    except ValueError:
                        pass
            table[key] = rowmap
    return table, token_cols

def write_table(path: Path, table: Dict[Tuple[str, str], Dict[str, float]], tokens: List[str]) -> None:
    """Write the table sorted by date ASC, then metric (METRICS order first, then alpha)."""
    existing_tokens = set()
    for _, rowmap in table.items():
        existing_tokens.update(rowmap.keys())
    # Preserve user token order, then add any extras discovered from file
    extras = sorted([t for t in existing_tokens if t not in [x.upper() for x in tokens]])
    header_tokens = [t.upper() for t in tokens] + extras

    header = ["date", "metric"] + header_tokens

    metric_rank = {m: i for i, m in enumerate(METRICS)}
    def metric_key(m: str) -> Tuple[int, str]:
        return (metric_rank.get(m, len(METRICS)), m)

    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(header)
        for (d, m) in sorted(table.keys(), key=lambda x: (x[0], metric_key(x[1]))):
            row = [d, m]
            cells = table[(d, m)]
            for t in header_tokens:
                v = cells.get(t)
                row.append("" if v is None else f"{v:.10f}")
            w.writerow(row)

def metric_max_date(table: Dict[Tuple[str, str], Dict[str, float]], metric: str) -> Optional[str]:
    dates = [d for (d, m) in table.keys() if m == metric]
    return max(dates) if dates else None

def run() -> None:
    # Normalize tokens to uppercase for columns
    tokens_upper = [t.upper() for t in TOKENS]

    # Load existing (if any)
    table, _existing_cols = read_existing_table(CSV_PATH)

    today = date.today().isoformat()

    for metric in METRICS:
        existing_max = metric_max_date(table, metric)
        # If metric already present, resume +1 day; else start very early (API trims)
        start_default = "1970-01-01" if existing_max is None else (datetime.fromisoformat(existing_max) + timedelta(days=1)).date().isoformat()

        # If metric exists, but some requested tokens have no history yet, backfill them from earliest
        effective_start = start_default
        if existing_max is not None:
            tokens_missing = []
            for t in tokens_upper:
                has_any = any((m == metric and t in row and isinstance(row[t], float)) for (d, m), row in table.items())
                if not has_any:
                    tokens_missing.append(t)
            if tokens_missing:
                effective_start = "1970-01-01"

        series_by_token = fetch_metric_for_tokens(metric, tokens_upper, effective_start, today)

        # Merge
        for tok, series in series_by_token.items():
            for pt in series:
                key = (pt["date"], metric)
                rowmap = table.get(key, {})
                rowmap[tok] = pt["val"]
                table[key] = rowmap

    # Write out
    write_table(CSV_PATH, table, tokens_upper)

    # Quick summary
    counts = {m: sum(1 for (d, mm) in table.keys() if mm == m) for m in METRICS}
    print(f"Wrote table -> {CSV_PATH}")
    print("Row counts by metric:", counts)

if __name__ == "__main__":
    try:
        run()
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(2)
