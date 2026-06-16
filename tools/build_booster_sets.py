#!/usr/bin/env python3
"""Build booster-sets.json — every Magic set with >1 `is:booster game:paper` card.

Run this ONLY when you want to refresh the cached list (e.g. after a new set
releases). It queries Scryfall once per plausible set and writes the result to
booster-sets.json at the repo root, which the web app loads as a static file
(so the app never queries per-set booster status at runtime).

Usage:
    python tools/build_booster_sets.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

UA = "pullhelper-build/1.0 (https://github.com/dazeyama/pullhelper)"

# Set types that never carry draft boosters — skipped without a request.
DENY_TYPES = {
    "commander", "token", "memorabilia", "promo", "planechase", "archenemy",
    "vanguard", "alchemy", "minigame", "treasure_chest", "from_the_vault",
    "spellbook", "premium_deck", "duel_deck", "box", "arsenal",
}


# Returns (ok, data). ok is False only when the request truly failed (so the
# caller can retry it) rather than legitimately returning no cards (404).
def get(url):
    for attempt in range(8):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return True, json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return True, None  # genuinely zero matches
            if e.code in (429, 503):
                time.sleep(0.6 * (attempt + 1) + 0.4)
                continue
            time.sleep(0.5 * (attempt + 1))
        except Exception:
            time.sleep(0.5 * (attempt + 1))
    return False, None  # exhausted retries -> failed, retry later


# Query one set's paper `is:booster` count. Returns True/False, or None if it
# failed. `game:paper` excludes digital-only sets (e.g. Jumpstart: Historic
# Horizons) that have booster cards only on Arena/MTGO.
def booster_count_gt1(code):
    q = urllib.parse.quote(f"set:{code} is:booster game:paper")
    ok, sd = get(f"https://api.scryfall.com/cards/search?q={q}&unique=cards")
    if not ok:
        return None
    return (sd or {}).get("total_cards", 0) > 1


def main():
    ok, data = get("https://api.scryfall.com/sets")
    if not ok or not data:
        print("Failed to fetch /sets", file=sys.stderr)
        sys.exit(1)

    candidates = [
        (s["code"], s["name"])
        for s in data["data"]
        if s.get("card_count", 0) > 1 and s.get("set_type") not in DENY_TYPES
    ]

    booster = {}
    pending = candidates
    failed = []
    for pass_no in range(1, 5):  # initial pass + up to 3 retry passes
        failed = []
        for i, (code, name) in enumerate(pending):
            time.sleep(0.12)  # be polite to Scryfall
            res = booster_count_gt1(code)
            if res is None:
                failed.append((code, name))  # transient failure -> retry next pass
            elif res:
                booster[code] = name
            if (i + 1) % 25 == 0:
                print(f"  pass {pass_no}: checked {i + 1}/{len(pending)}, {len(booster)} booster so far...", file=sys.stderr)
        if not failed:
            break
        print(f"  pass {pass_no}: {len(failed)} sets failed, retrying...", file=sys.stderr)
        time.sleep(2)
        pending = failed
    if failed:
        print(f"WARNING: {len(failed)} sets still failed after retries: {[c for c, _ in failed]}", file=sys.stderr)

    out = {
        "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(booster),
        "sets": dict(sorted(booster.items())),
    }
    path = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "booster-sets.json"))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0)
    print(f"Wrote {len(booster)} booster sets to {path} (from {len(candidates)} candidate sets)", file=sys.stderr)


if __name__ == "__main__":
    main()
