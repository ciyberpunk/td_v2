import re, sys
from pathlib import Path
import pandas as pd

WANT = ["MSTR","MTPLF","SBET","BMNR","DFDV","UPXI"]

def to_num(x):
    if x is None: return float('nan')
    if isinstance(x,(int,float)): return float(x)
    s = str(x).strip()
    if not s: return float('nan')
    s = s.replace("\u2212","-")
    if re.fullmatch(r"\(.*\)", s): s = "-" + s[1:-1]
    s = re.sub(r"[,$]", "", s).replace("%","")
    try: return float(s)
    except: return float('nan')

def is_price(name: str) -> bool:
    n = name.lower().strip()
    return bool(re.search(r"(?:^|[\s_-])(price|px|px\s*last|close|last)(?:$|[\s_-])", n))

def is_nav(name: str) -> bool:
    n = name.lower().strip()
    return bool(re.search(r"(?:^|[\s_-])(nav|nav\s*usd|net\s*asset\s*value)(?:$|[\s_-])", n))

EXCLUDE_SHARES = ["token","tokens","warrant","convertible","non-convertible","bond","debt"]
def is_shares(name: str) -> bool:
    n = name.lower().strip()
    if any(b in n for b in EXCLUDE_SHARES): return False
    return bool(
        re.search(r"(?:^|[\s_-])(?:num|number)\s*(?:of\s*)?shares(?:$|[\s_-])", n) or
        re.search(r"shares?\s*[_\s-]*outstanding", n) or
        re.search(r"basic\s*[_\s-]*shares?\s*[_\s-]*out", n) or
        re.search(r"diluted\s*[_\s-]*shares?\s*[_\s-]*out", n) or
        re.search(r"share\s*[_\s-]*count", n) or
        re.search(r"shs\s*[_\s-]*out", n)
    )

def col_to_ticker(col: str):
    lc = col.lower()
    for w in WANT:
        if w.lower() in lc: return w
    m = re.search(r"(mstr|mtplf|sbet|bmnr|dfdv|upxi)", lc)
    return m.group(1).upper() if m else None

ROOT = Path.cwd()
src = next((p for p in [
    ROOT/"docs/data/dat_data.csv",
    ROOT/"docs/Data/dat_data.csv",
    ROOT/"data/dat_data.csv"
] if p.exists()), None)

if not src:
    print("ERROR: dat_data.csv not found in docs/data or Data/", file=sys.stderr)
    sys.exit(1)

orig = pd.read_csv(src, dtype=str, keep_default_na=False)
orig_cols = list(orig.columns)
df = orig.copy()
df.columns = [c.strip().lower() for c in df.columns]

if "date" not in df.columns or "metric" not in df.columns:
    print("ERROR: expected 'date' and 'metric' columns.", file=sys.stderr)
    sys.exit(1)

ticker_cols = []
for c in df.columns:
    if c in ("date","metric"): continue
    t = col_to_ticker(c)
    if t in WANT:
        ticker_cols.append((c, t))
if not ticker_cols:
    print("ERROR: no per-ticker columns found.", file=sys.stderr)
    sys.exit(1)

def metric_block(pred):
    sub = df[df["metric"].apply(lambda s: pred(str(s)))]
    if sub.empty:
        return pd.DataFrame(index=pd.Index([], name="date"), columns=[t for _,t in ticker_cols])
    keep = ["date"] + [c for c,_ in ticker_cols]
    sub = sub[keep].copy()
    for c,_ in ticker_cols:
        sub[c] = sub[c].map(to_num)
    sub = sub.groupby("date").last()
    sub.columns = [t for _,t in ticker_cols]
    return sub

price  = metric_block(is_price)
shares = metric_block(is_shares)
nav    = metric_block(is_nav)

idx = price.index.union(shares.index).union(nav.index)
price  = price.reindex(idx)
shares = shares.reindex(idx)
nav    = nav.reindex(idx)

mnav = (price * shares) / nav
mnav = mnav.dropna(how="all")

out_rows = []
col_map = {t: c for (c,t) in ticker_cols}  # ticker -> original eq-* column
for date_str, row in mnav.iterrows():
    rec = {c: "" for c in df.columns}
    rec["date"] = date_str
    rec["metric"] = "mnav"
    any_val = False
    for t in WANT:
        if t in row and pd.notna(row[t]):
            rec[col_map[t]] = f"{row[t]:.12g}"
            any_val = True
    if any_val:
        out_rows.append(rec)

add = pd.DataFrame(out_rows, columns=df.columns)
no_old = df[~df["metric"].str.lower().eq("mnav")].copy()
new_df = pd.concat([no_old, add], ignore_index=True)

lower_to_orig = {c.lower(): c for c in orig_cols}
ordered_cols = [lower_to_orig.get(c, c) for c in df.columns]
final = new_df.copy()
final.columns = ordered_cols
final = final[ordered_cols]

final.to_csv(src, index=False)
print(f"Updated -> {src}")
print("mNAV counts:", {t:int(pd.to_numeric(mnav[t], errors='coerce').notna().sum()) if t in mnav.columns else 0 for t in WANT})
