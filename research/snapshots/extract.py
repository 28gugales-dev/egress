"""Keyless ACS extraction from the Census table-based summary files.

api.census.gov now requires a key for data queries (302 -> missing_key.html), but
the bulk summary files on www2.census.gov are keyless and carry the same
estimates. We stream-filter by GEO_ID prefix so a 60 MB table costs no disk.

GEO_ID prefix 1500000US<state><county> selects block groups (summary level 150).
"""
import json, sys, urllib.request

YEAR = 2022
BASE = f"https://www2.census.gov/programs-surveys/acs/summary_file/{YEAR}/table-based-SF/data/5YRData"

# table -> {outputField: columnName}
TABLES = {
    "b25044": {"occupiedHouseholds": "B25044_E001", "noVehOwner": "B25044_E003", "noVehRenter": "B25044_E010"},
    "b01003": {"population": "B01003_E001"},
    "b11001": {"households": "B11001_E001"},
    "c16002": {"lepTotal": "C16002_E001", "lepSpanish": "C16002_E004", "lepIndoEuro": "C16002_E007",
               "lepAsian": "C16002_E010", "lepOther": "C16002_E013"},
    "b18101": {"disabilityTotal": "B18101_E001"},
}

def extract(table: str, prefix: str) -> dict:
    url = f"{BASE}/acsdt5y{YEAR}-{table}.dat"
    fields = TABLES[table]
    out, hdr, idx = {}, None, None
    req = urllib.request.Request(url, headers={"User-Agent": "egress-research/0.1"})
    with urllib.request.urlopen(req, timeout=300) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace")
            if hdr is None:
                hdr = line.rstrip("\n").split("|")
                idx = {k: hdr.index(v) for k, v in fields.items() if v in hdr}
                missing = set(fields) - set(idx)
                if missing:
                    print(f"  !! {table}: columns not found: {sorted(missing)}", file=sys.stderr)
                continue
            if not line.startswith(prefix):
                continue
            p = line.rstrip("\n").split("|")
            geo = p[0].split("US")[-1]
            rec = {}
            for k, i in idx.items():
                try:
                    rec[k] = int(p[i])
                except (ValueError, IndexError):
                    rec[k] = 0
            out[geo] = rec
    return out

if __name__ == "__main__":
    county = sys.argv[1] if len(sys.argv) > 1 else "06007"   # Butte County CA
    label = sys.argv[2] if len(sys.argv) > 2 else "butte-ca"
    prefix = f"1500000US{county}"
    merged: dict[str, dict] = {}
    for table in TABLES:
        print(f"fetching {table} ...", flush=True)
        got = extract(table, prefix)
        print(f"  {len(got)} block groups", flush=True)
        for geo, rec in got.items():
            merged.setdefault(geo, {}).update(rec)
    for rec in merged.values():
        rec["noVehicleHouseholds"] = rec.pop("noVehOwner", 0) + rec.pop("noVehRenter", 0)
    path = f"research/snapshots/acs-{label}-{YEAR}.json"
    json.dump(merged, open(path, "w"), indent=0)
    tot = sum(r.get("occupiedHouseholds", 0) for r in merged.values())
    nov = sum(r.get("noVehicleHouseholds", 0) for r in merged.values())
    pop = sum(r.get("population", 0) for r in merged.values())
    print(f"\nwrote {path}")
    print(f"block groups {len(merged):,} | population {pop:,} | households {tot:,} | no-vehicle {nov:,} ({nov/max(tot,1)*100:.2f}%)")
