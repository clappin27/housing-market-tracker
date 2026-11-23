#!/usr/bin/env python3
"""Refresh the website's housing data.

1. Downloads Zillow Research's public metro-level CSV files.
2. Reshapes them into small JSON files the website reads (site/data/).
3. Looks up a free-licensed photo of each metro's main city on
   Wikipedia / Wikimedia Commons, with author and license for the credit line.
4. Writes this month's market alerts (big moves, multi-year highs and lows,
   turning points) for the areas listed in config.json.

Only files whose contents changed are rewritten, so a run with nothing new
leaves the repository untouched. Uses only the Python standard library.

Usage:
    python3 scripts/update_data.py                 # normal run
    python3 scripts/update_data.py --no-photos     # skip the photo lookup
    python3 scripts/update_data.py --refresh-photos  # look every photo up again
    python3 scripts/update_data.py --alerts-markdown alerts.md  # also write alerts as Markdown
"""

import argparse
import csv
import html
import io
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "site", "data")
SERIES_DIR = os.path.join(DATA_DIR, "series")
CONFIG_PATH = os.path.join(ROOT, "config.json")
PHOTOS_PATH = os.path.join(DATA_DIR, "photos.json")

ZILLOW_BASE = "https://files.zillowstatic.com/research/public_csvs/"
ZILLOW_PAGE = "https://www.zillow.com/research/data/"
WIKI_API = "https://en.wikipedia.org/w/api.php"

# Wikimedia refuses API requests whose User-Agent has no contact link, so photo
# lookups send this repo's GitHub URL (set automatically in main()).
USER_AGENT = "housing-market-tracker/1.0 python-urllib"

DATASETS = [
    {
        "key": "zhvi",
        "path": "zhvi/Metro_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv",
        "label": "Typical home value",
        "unit": "usd",
        "note": "Zillow Home Value Index (ZHVI). Single-family homes and condos in the "
                "middle third of values, smoothed and seasonally adjusted.",
    },
    {
        "key": "zori",
        "path": "zori/Metro_zori_uc_sfrcondomfr_sm_month.csv",
        "label": "Typical rent",
        "unit": "usd_month",
        "note": "Zillow Observed Rent Index (ZORI). Asking rents for all homes and "
                "apartments, smoothed.",
    },
    {
        "key": "list_price",
        "path": "mlp/Metro_mlp_uc_sfrcondo_sm_month.csv",
        "label": "Median list price",
        "unit": "usd",
        "note": "Median asking price of single-family homes and condos listed for sale, smoothed.",
    },
    {
        "key": "sale_price",
        "path": "median_sale_price/Metro_median_sale_price_uc_sfrcondo_sm_month.csv",
        "label": "Median sale price",
        "unit": "usd",
        "note": "Median price single-family homes and condos sold for, smoothed.",
    },
    {
        "key": "inventory",
        "path": "invt_fs/Metro_invt_fs_uc_sfrcondo_sm_month.csv",
        "label": "Homes for sale",
        "unit": "count",
        "note": "Number of single-family homes and condos listed for sale during the month, smoothed.",
    },
    {
        "key": "days_pending",
        "path": "med_doz_pending/Metro_med_doz_pending_uc_sfrcondo_sm_month.csv",
        "label": "Median days to pending",
        "unit": "days",
        "note": "Median days from listing to an accepted offer, smoothed.",
    },
]

STATE_NAMES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California",
    "CO": "Colorado", "CT": "Connecticut", "DE": "Delaware", "DC": "District of Columbia",
    "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma",
    "OR": "Oregon", "PA": "Pennsylvania", "PR": "Puerto Rico", "RI": "Rhode Island",
    "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington",
    "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}

# Metro names whose Wikipedia article title isn't simply "City, State".
WIKI_TITLE_OVERRIDES = {
    "New York, NY": "New York City",
    "Washington, DC": "Washington, D.C.",
    "Urban Honolulu, HI": "Honolulu",
}
# Lead images that are flags, seals, maps or diagrams rather than photos.
NOT_A_PHOTO = re.compile(
    r"(flag|seal|logo|emblem|coat[_ ]of[_ ]arms|locator|location|map|montage[_ ]map|\.svg$|\.gif$|\.tiff?$)",
    re.IGNORECASE,
)
RETRY_MISSING_PHOTO_DAYS = 90
PHOTO_WIDTH = 960
CARD_PHOTO_WIDTH = 500

DATE_COLUMN = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def find_contact_url(config):
    """The repo's GitHub URL: config.json, then GitHub Actions, then the git remote."""
    url = str(config.get("contact_url") or "").strip()
    if url:
        return url
    repo = os.environ.get("GITHUB_REPOSITORY")
    if repo:
        return "https://github.com/" + repo
    try:
        remote = subprocess.run(["git", "-C", ROOT, "remote", "get-url", "origin"],
                                capture_output=True, text=True, timeout=10).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        remote = ""
    match = re.match(r"(?:https://|git@)github\.com[/:]([^/]+/[^/]+?)(?:\.git)?$", remote)
    return "https://github.com/" + match.group(1) if match else None


def fetch(url, params=None, tries=4):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except Exception as exc:  # network hiccups: back off and retry
            if attempt == tries - 1:
                raise
            wait = 3 * (2 ** attempt)
            log("  retrying in {}s ({})".format(wait, exc))
            time.sleep(wait)


def month_index(yyyy_mm):
    return int(yyyy_mm[:4]) * 12 + int(yyyy_mm[5:7]) - 1


def index_month(idx):
    return "{:04d}-{:02d}".format(idx // 12, idx % 12 + 1)


# --------------------------------------------------------------------------- Zillow


def load_dataset(ds):
    log("Downloading {} ...".format(ds["label"]))
    text = fetch(ZILLOW_BASE + ds["path"]).decode("utf-8-sig")
    reader = csv.reader(io.StringIO(text))
    header = next(reader)
    col = {name: i for i, name in enumerate(header)}
    for needed in ("RegionID", "SizeRank", "RegionName", "RegionType"):
        if needed not in col:
            raise RuntimeError("{}: column {} missing; Zillow may have changed the file".format(ds["path"], needed))
    date_cols = [(i, month_index(h[:7])) for i, h in enumerate(header) if DATE_COLUMN.match(h)]
    if not date_cols:
        raise RuntimeError("{}: no monthly columns found".format(ds["path"]))
    last = max(m for _, m in date_cols)

    rows = {}
    for row in reader:
        if not row:
            continue
        rtype = row[col["RegionType"]].strip().lower()
        if rtype not in ("msa", "country"):
            continue
        values = {}
        for i, m in date_cols:
            cell = row[i].strip() if i < len(row) else ""
            if cell:
                try:
                    values[m] = float(cell)
                except ValueError:
                    pass
        state_col = col.get("StateName")
        rows[row[col["RegionID"]]] = {
            "name": row[col["RegionName"]].strip(),
            "state": row[state_col].strip() if state_col is not None and state_col < len(row) else "",
            "rank": int(float(row[col["SizeRank"]] or 99999)),
            "type": "country" if rtype == "country" else "metro",
            "values": values,
        }
    log("  {} regions, data through {}".format(len(rows), index_month(last)))
    return {"last": last, "rows": rows}


def build_series(values, last):
    """Monthly values from the first reported month through `last` (nulls for gaps)."""
    if not values:
        return None
    start = min(values)
    out = []
    for m in range(start, last + 1):
        v = values.get(m)
        out.append(None if v is None else int(round(v)))
    while out and out[-1] is None and len(out) > 1:
        out.pop()
    return {"start": index_month(start), "values": out}


def latest_and_change(values, last):
    v = values.get(last)
    if v is None:
        return None
    prev = values.get(last - 12)
    change = round((v / prev - 1) * 100, 1) if prev else None
    return [int(round(v)), change]


# --------------------------------------------------------------------------- photos


def wiki_title_for(name, state):
    if name in WIKI_TITLE_OVERRIDES:
        return WIKI_TITLE_OVERRIDES[name]
    city = name.rsplit(",", 1)[0].strip()
    abbr = (state or name.rsplit(",", 1)[-1]).strip()[:2].upper()
    full = STATE_NAMES.get(abbr)
    return "{}, {}".format(city, full) if full else city


def chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i:i + size]


def wiki_query(params):
    base = {"action": "query", "format": "json", "formatversion": "2"}
    base.update(params)
    data = json.loads(fetch(WIKI_API, base).decode("utf-8"))
    time.sleep(0.5)  # be polite to Wikimedia
    return data.get("query", {})


def resolve_titles(query, titles):
    """Map each requested title to the final page title after normalizing and redirects."""
    normalized = {n["from"]: n["to"] for n in query.get("normalized", [])}
    redirects = {r["from"]: r["to"] for r in query.get("redirects", [])}
    out = {}
    for t in titles:
        final = normalized.get(t, t)
        for _ in range(3):
            if final in redirects:
                final = redirects[final]
        out[t] = final
    return out


def clean_html(value, limit=90):
    text = html.unescape(re.sub(r"<[^>]+>", " ", value or ""))
    text = re.sub(r"\s+", " ", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


# Some Commons files put license boilerplate in the author field. On those, the
# uploader is the copyright holder, so credit them by name instead.
BOILERPLATE_CREDIT = re.compile(r"copyright holder of this work|hereby publish", re.I)
FILE_PREFIX = re.compile(r"^(?:File|Image):[^:]+?\.(?:jpe?g|png|gif|tiff?|webp)\s*:\s*", re.I)


def photo_credit(artist_html, uploader):
    text = FILE_PREFIX.sub("", clean_html(artist_html, 500))
    if BOILERPLATE_CREDIT.search(text):
        text = uploader or ""
    return clean_html(text) or "Unknown author"


def card_url(thumb_url, thumb_width):
    if "/thumb/" in thumb_url and thumb_width and thumb_width > CARD_PHOTO_WIDTH:
        return re.sub(r"/\d+px-", "/{}px-".format(CARD_PHOTO_WIDTH), thumb_url, count=1)
    return thumb_url


def lookup_photos(metros):
    """metros: list of (id, name, state). Returns {id: photo dict or None}."""
    found = {}
    title_for = {mid: wiki_title_for(name, state) for mid, name, state in metros}
    titles = sorted(set(title_for.values()))

    page_of = {}
    for batch in chunks(titles, 50):
        q = wiki_query({
            "redirects": "1",
            "prop": "pageimages|pageprops",
            "piprop": "name",
            "pilicense": "free",
            "ppprop": "disambiguation",
            "titles": "|".join(batch),
        })
        final = resolve_titles(q, batch)
        pages = {p.get("title"): p for p in q.get("pages", [])}
        for t in batch:
            p = pages.get(final[t])
            if not p or p.get("missing") or "disambiguation" in (p.get("pageprops") or {}):
                continue
            image = p.get("pageimage")
            if image and not NOT_A_PHOTO.search(image):
                page_of[t] = {"page": p["title"], "file": image}

    files = sorted({v["file"] for v in page_of.values()})
    info_of = {}
    for batch in chunks(files, 50):
        requested = ["File:" + f for f in batch]
        q = wiki_query({
            "prop": "imageinfo",
            "iiprop": "url|extmetadata|user",
            "iiurlwidth": str(PHOTO_WIDTH),
            "iiextmetadatafilter": "Artist|LicenseShortName|LicenseUrl|UsageTerms",
            "titles": "|".join(requested),
        })
        final = resolve_titles(q, requested)
        pages = {p.get("title"): p for p in q.get("pages", [])}
        for f, t in zip(batch, requested):
            p = pages.get(final[t]) or {}
            ii = (p.get("imageinfo") or [None])[0]
            if not ii or not ii.get("thumburl"):
                continue
            meta = ii.get("extmetadata") or {}
            get = lambda k: (meta.get(k) or {}).get("value", "")
            license_name = clean_html(get("LicenseShortName") or get("UsageTerms"), 40)
            if not license_name:
                continue  # no license info means no proper credit line: skip it
            width = ii.get("thumbwidth")
            info_of[f] = {
                "src": ii["thumburl"],
                "card": card_url(ii["thumburl"], width),
                "width": width,
                "height": ii.get("thumbheight"),
                "credit": photo_credit(get("Artist"), ii.get("user")),
                "license": license_name,
                "license_url": clean_html(get("LicenseUrl"), 300) or None,
                "file_page": ii.get("descriptionurl"),
            }

    for mid, title in title_for.items():
        page = page_of.get(title)
        info = info_of.get(page["file"]) if page else None
        if info:
            photo = dict(info)
            photo["wiki_page"] = "https://en.wikipedia.org/wiki/" + urllib.parse.quote(page["page"].replace(" ", "_"))
            found[mid] = photo
        else:
            found[mid] = None
    return found


def refresh_photo_cache(metro_list, refresh_all):
    cache = read_json(PHOTOS_PATH) or {}
    today = date.today()
    todo = []
    for m in metro_list:
        if m["type"] != "metro":
            continue
        entry = cache.get(m["id"])
        if entry and not refresh_all:
            if entry.get("photo"):
                continue
            checked = entry.get("checked")
            if checked and (today - date.fromisoformat(checked)).days < RETRY_MISSING_PHOTO_DAYS:
                continue
        todo.append((m["id"], m["name"], m["state"]))
    if todo:
        log("Looking up photos for {} metro areas on Wikipedia ...".format(len(todo)))
        try:
            results = lookup_photos(todo)
        except Exception as exc:
            log("  photo lookup failed, keeping existing photos ({})".format(exc))
            results = {}
        stamp = today.isoformat()
        for mid, photo in results.items():
            old = cache.get(mid) or {}
            if photo == old.get("photo") and old.get("checked"):
                continue  # unchanged: keep the old stamp so the file doesn't churn
            cache[mid] = {"checked": stamp, "photo": photo}
        log("  {} photos found".format(sum(1 for p in results.values() if p)))
    return cache


# --------------------------------------------------------------------------- output


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def write_if_changed(path, text):
    try:
        with open(path, encoding="utf-8") as fh:
            if fh.read() == text:
                return False
    except OSError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    return True


def dumps(obj, pretty=False):
    if pretty:
        return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False) + "\n"


def latest_csv(metro_list, last_month_label):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow([
        "Region", "State", "Size rank", "Typical home value", "Home value change, 1 yr (%)",
        "Typical rent (monthly)", "Rent change, 1 yr (%)", "Gross rent yield (%)",
        "Median list price", "Median sale price", "Homes for sale", "Median days to pending",
        "Data month",
    ])
    for m in metro_list:
        L = m["latest"]
        val = lambda k, i=0: (L.get(k) or [None, None])[i]
        y = m.get("yield")
        w.writerow([
            m["name"], m["state"], m["rank"], val("zhvi"), val("zhvi", 1), val("zori"), val("zori", 1),
            y if y is not None else None, val("list_price"), val("sale_price"), val("inventory"),
            val("days_pending"), last_month_label,
        ])
    return buf.getvalue()


# --------------------------------------------------------------------------- alerts

# key: (name used in alert text, yearly change in % that counts as a big move,
#       whether a run of monthly declines is worth flagging). Only home values are
#       seasonally adjusted; rents dip every fall, so a run of rent declines isn't news.
ALERT_METRICS = {
    "zhvi": ("Typical home value", 5, True),
    "zori": ("Typical rent", 5, False),
    "list_price": ("Median list price", 8, False),
    "sale_price": ("Median sale price", 8, False),
    "inventory": ("Homes for sale", 20, False),
    "days_pending": ("Median days to pending", 25, False),
}
ALERTS_PER_AREA = 3
EXTREME_MIN_MONTHS = 36   # "highest since ..." only when it beats at least 3 years
RECORD_MIN_MONTHS = 60    # "record high" only with at least 5 years of data
STREAK_MIN = 3            # months in a row of declines
TURN_MIN_GAP = 6          # yearly change must have held its old direction this long
MOVER_POOL = 100          # biggest movers are picked from the largest N metros
MOVER_MIN_CHANGE = 1.0    # ...and only if they moved at least this much (%)
MIN_SCORE = 0.5           # drops continuing trends, like a new price record every month
MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
               "September", "October", "November", "December"]


def month_label(idx):
    return "{} {}".format(MONTH_NAMES[idx % 12], idx // 12)


def fmt_value(unit, v):
    if unit == "usd":
        if v < 100000:
            return "${:,.0f}".format(v)
        r = round(v, -(len(str(int(v))) - 3))  # 3 significant digits
        if r >= 1000000:
            return "${}M".format(("%.2f" % (r / 1e6)).rstrip("0").rstrip("."))
        return "${:,.0f}K".format(r / 1000)
    if unit == "usd_month":
        return "${:,.0f}/mo".format(v)
    if unit == "days":
        return "{:,.0f} days".format(v)
    return "{:,.0f}".format(v)


def fmt_pct(p, sign=True):
    mark = ("+" if p > 0 else "−" if p < 0 else "") if sign else ""
    return "{}{:.1f}%".format(mark, abs(p))


def yearly_change(vals, m):
    a, b = vals.get(m), vals.get(m - 12)
    return (a / b - 1) * 100 if a is not None and b else None


def last_match(vals, at, kind):
    """Latest month before `at` whose value was at least as high (or low). None if none."""
    v = vals[at]
    hits = [m for m in vals if m < at and (vals[m] >= v if kind == "high" else vals[m] <= v)]
    return max(hits) if hits else None


def metric_alerts(key, vals, last, unit):
    """Every alert one metric triggers for one area; the caller keeps the strongest."""
    noun, big, watch_streaks = ALERT_METRICS[key]
    v = vals.get(last)
    if v is None:
        return []
    shown = fmt_value(unit, v)
    first = min(vals)
    found = []

    # 1. Highest or lowest in years, or on record.
    for kind in ("high", "low"):
        word = "highest" if kind == "high" else "lowest"
        hit = last_match(vals, last, kind)
        if hit is not None:
            gap = last - hit
            if gap < EXTREME_MIN_MONTHS:
                continue
            text = "{}: {}, the {} since {}".format(noun, shown, word, month_label(hit))
            score = min(gap / 24, 2.5)
        else:
            if last - first < RECORD_MIN_MONTHS:
                continue
            text = "{}: {}, a record {} (data since {})".format(noun, shown, kind, first // 12)
            score = 2.5
        # If last month was already a multi-year extreme, this is a continuing trend, not news.
        if (last - 1) in vals and last - 1 > first:
            prev_hit = last_match(vals, last - 1, kind)
            if prev_hit is None or (last - 1) - prev_hit >= EXTREME_MIN_MONTHS:
                score *= 0.3
        if kind == "high" and key in ("zhvi", "zori"):
            score *= 0.6  # rising prices are the norm; highs matter less than lows
        found.append({"kind": "record" if hit is None else "extreme", "dir": "up" if kind == "high" else "down",
                      "text": text, "score": score})

    # 2. Yearly change flipped direction after holding for a while. Changes under
    #    0.1% count as flat and are skipped, so a slow crossing still registers.
    now = yearly_change(vals, last)

    def direction(m):
        c = yearly_change(vals, m)
        return 0 if c is None or abs(c) < 0.1 else (1 if c > 0 else -1)

    d_now = direction(last)
    if d_now:
        m = last - 1
        while m in vals and direction(m) == 0:
            m -= 1
        if m in vals and direction(m) == -d_now:
            while m in vals and direction(m) != d_now:
                m -= 1
            same = m if m in vals else None  # last month that pointed the same way as now
            if same is None or last - same >= TURN_MIN_GAP:
                since = "for the first time since {}".format(month_label(same)) if same else "for the first time on record"
                found.append({"kind": "turn", "dir": "up" if d_now > 0 else "down",
                              "text": "{} is now {} from a year ago ({}) {}".format(
                                  noun, "up" if d_now > 0 else "down", fmt_pct(now), since),
                              "score": 3.0 if key in ("zhvi", "zori") else 2.0})

    # 3. Several monthly declines in a row.
    if watch_streaks:
        n = 0
        while vals.get(last - n) is not None and vals.get(last - n - 1) is not None and vals[last - n] < vals[last - n - 1]:
            n += 1
        if n >= STREAK_MIN:
            start = vals[last - n]
            found.append({"kind": "streak", "dir": "down",
                          "text": "{} has fallen {} months in a row ({} since {}), now {}".format(
                              noun, n, fmt_pct((v / start - 1) * 100), month_label(last - n), shown),
                          "score": min(1.5 + n * 0.25, 3.0)})

    # 4. A big move over the past year.
    if now is not None and abs(now) >= big:
        found.append({"kind": "big", "dir": "up" if now > 0 else "down",
                      "text": "{} {} {} from a year ago, to {}".format(
                          noun, "up" if now > 0 else "down", fmt_pct(now, sign=False), shown),
                      "score": min(abs(now) / big, 3.0)})
    return found


def build_alerts(loaded, watch, metro_list, units):
    """watch: list of (id, name). Returns alerts sorted strongest first."""
    alerts = []
    main_last = loaded["zhvi"]["last"]
    for rid, name in watch:
        mine = []
        for key in ALERT_METRICS:
            row = loaded[key]["rows"].get(rid)
            if not row:
                continue
            last = loaded[key]["last"]
            for a in metric_alerts(key, row["values"], last, units[key]):
                if last != main_last:  # e.g. sale prices run a month behind
                    a["text"] = a["text"].replace(ALERT_METRICS[key][0],
                                                  "{} ({})".format(ALERT_METRICS[key][0], month_label(last)), 1)
                a.update({"id": rid, "name": name, "metric": key})
                mine.append(a)
        best = {}
        for a in sorted(mine, key=lambda a: -a["score"]):
            if a["score"] >= MIN_SCORE:
                best.setdefault(a["metric"], a)  # one alert per metric
        alerts.extend(sorted(best.values(), key=lambda a: -a["score"])[:ALERTS_PER_AREA])

    # Biggest yearly gain and drop in home values and rents among the largest metros.
    pool = [m for m in metro_list if m["type"] == "metro"][:MOVER_POOL]
    for key in ("zhvi", "zori"):
        noun = ALERT_METRICS[key][0].replace("Typical ", "")
        ranked = sorted((m for m in pool if (m["latest"].get(key) or [None, None])[1] is not None),
                        key=lambda m: m["latest"][key][1])
        if len(ranked) < 2:
            continue
        for m, word in ((ranked[-1], "gain"), (ranked[0], "drop")):
            value, change = m["latest"][key]
            if (word == "gain") != (change > 0) or abs(change) < MOVER_MIN_CHANGE:
                continue  # e.g. nothing really fell: skip "biggest drop"
            if any(a["id"] == m["id"] and a["metric"] == key for a in alerts):
                continue  # already covered by that area's own alert
            alerts.append({
                "id": m["id"], "name": m["name"], "metric": key, "kind": "mover",
                "dir": "up" if change > 0 else "down",
                "text": "Biggest yearly {} in {}s among the {} largest metros: {}, to {}".format(
                    word, noun, MOVER_POOL, fmt_pct(change), fmt_value(units[key], value)),
                "score": 2.2,
            })

    ranks = {m["id"]: m["rank"] for m in metro_list}
    alerts.sort(key=lambda a: (-round(a["score"], 3), ranks.get(a["id"], 99999)))
    for a in alerts:
        del a["score"]
    return alerts


def alerts_markdown(alerts, month_idx, site_url, owner):
    lines = ["New Zillow data for **{} {}** is on your site.".format(FULL_MONTHS[month_idx % 12], month_idx // 12), ""]
    if alerts:
        for a in alerts:
            link = "{}#/metro/{}".format(site_url, a["id"]) if site_url else None
            area = "[{}]({})".format(a["name"], link) if link else a["name"]
            lines.append("- {} **{}**: {}".format("▲" if a["dir"] == "up" else "▼", area, a["text"]))
    else:
        lines.append("Nothing unusual this month for the areas you follow.")
    if site_url:
        lines += ["", "Full site: {}".format(site_url)]
    lines += ["", "_Change which areas you get alerts for under `alerts` in config.json. "
                  "Close this issue whenever you like._"]
    if owner:
        lines += ["", "cc @" + owner]
    return "\n".join(lines) + "\n"


def set_action_output(**pairs):
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as fh:
        for k, v in pairs.items():
            fh.write("{}={}\n".format(k, v))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--no-photos", action="store_true", help="skip the Wikipedia photo lookup")
    ap.add_argument("--refresh-photos", action="store_true", help="look up every photo again")
    ap.add_argument("--alerts-markdown", metavar="PATH",
                    help="also write this month's alerts as Markdown (used for the GitHub issue)")
    args = ap.parse_args()

    config = read_json(CONFIG_PATH) or {}
    previous_month = (read_json(os.path.join(DATA_DIR, "meta.json")) or {}).get("latest_month")
    loaded = {ds["key"]: load_dataset(ds) for ds in DATASETS}

    # Every region in any dataset; name, state and size rank come from the first file that has it.
    regions = {}
    for ds in DATASETS:
        for rid, row in loaded[ds["key"]]["rows"].items():
            regions.setdefault(rid, {"id": rid, "name": row["name"], "state": row["state"],
                                     "rank": row["rank"], "type": row["type"]})

    changed = []
    metro_list = []
    series_files = set()
    for rid, reg in regions.items():
        series = {"id": rid, "name": reg["name"]}
        latest = {}
        for ds in DATASETS:
            k = ds["key"]
            row = loaded[k]["rows"].get(rid)
            if not row:
                continue
            s = build_series(row["values"], loaded[k]["last"])
            if s:
                series[k] = s
            lc = latest_and_change(row["values"], loaded[k]["last"])
            if lc:
                latest[k] = lc
        entry = dict(reg)
        entry["latest"] = latest
        if latest.get("zhvi") and latest.get("zori"):
            entry["yield"] = round(latest["zori"][0] * 12 / latest["zhvi"][0] * 100, 1)
        metro_list.append(entry)
        fname = "{}.json".format(rid)
        series_files.add(fname)
        if write_if_changed(os.path.join(SERIES_DIR, fname), dumps(series)):
            changed.append("series/" + fname)

    if os.path.isdir(SERIES_DIR):
        for fname in os.listdir(SERIES_DIR):
            if fname.endswith(".json") and fname not in series_files:
                os.remove(os.path.join(SERIES_DIR, fname))
                changed.append("removed series/" + fname)

    metro_list.sort(key=lambda m: (m["rank"], m["name"]))

    global USER_AGENT
    photos_enabled = (config.get("photos") or {}).get("enabled", True) and not args.no_photos
    photo_cache = read_json(PHOTOS_PATH) or {}
    contact = find_contact_url(config) if photos_enabled else None
    if photos_enabled and not contact:
        log("Skipping photo lookup: Wikimedia requires a contact link. Push this repo to GitHub "
            '(photos are fetched automatically there) or set "contact_url" in config.json.')
    elif photos_enabled:
        USER_AGENT = "housing-market-tracker/1.0 ({}) python-urllib".format(contact)
        photo_cache = refresh_photo_cache(metro_list, args.refresh_photos)
        if write_if_changed(PHOTOS_PATH, dumps(photo_cache, pretty=True)):
            changed.append("photos.json")
    for m in metro_list:
        cached = photo_cache.get(m["id"]) if photos_enabled else None
        m["photo"] = (cached or {}).get("photo")

    by_name = {m["name"].lower(): m for m in metro_list}
    by_id = {m["id"]: m for m in metro_list}

    def resolve(names, setting):
        ids = []
        for name in names or []:
            hit = by_name.get(str(name).strip().lower())
            if hit:
                ids.append(hit["id"])
            else:
                log('Warning: {}: metro "{}" not found. Use the exact name shown on the site, '
                    'e.g. "Boston, MA".'.format(setting, name))
        return ids

    # Featured metros: names from config, or the largest metros.
    featured = resolve(config.get("featured_metros"), "featured_metros")
    if not featured:
        n = int(config.get("featured_count") or 12)
        featured = [m["id"] for m in metro_list if m["type"] == "metro"][:n]

    zhvi_last = index_month(loaded["zhvi"]["last"])

    # Alerts: the U.S. plus the metros named in config (or the featured ones).
    alert_cfg = config.get("alerts") or {}
    watch_ids = resolve(alert_cfg.get("metros"), "alerts.metros") or featured
    watch = [(m["id"], m["name"]) for m in metro_list if m["type"] == "country"]
    watch += [(i, by_id[i]["name"]) for i in watch_ids if i in by_id]
    units = {ds["key"]: ds["unit"] for ds in DATASETS}
    alerts = build_alerts(loaded, watch, metro_list, units)
    alerts_doc = {"month": zhvi_last, "watching": len(watch), "mover_pool": MOVER_POOL, "alerts": alerts}
    if write_if_changed(os.path.join(DATA_DIR, "alerts.json"), dumps(alerts_doc, pretty=True)):
        changed.append("alerts.json")
    log("{} alert(s) for {} area(s).".format(len(alerts), len(watch)))

    if args.alerts_markdown:
        repo = os.environ.get("GITHUB_REPOSITORY", "")
        owner = os.environ.get("GITHUB_REPOSITORY_OWNER", "")
        site_url = str(alert_cfg.get("site_url") or "").strip()
        if not site_url and "/" in repo:
            name = repo.split("/", 1)[1]
            site_url = "https://{}.github.io/{}".format(owner.lower(), "" if name.lower() == owner.lower() + ".github.io" else name + "/")
        with open(args.alerts_markdown, "w", encoding="utf-8") as fh:
            fh.write(alerts_markdown(alerts, loaded["zhvi"]["last"], site_url, owner))
        idx = loaded["zhvi"]["last"]
        set_action_output(
            new_month=str(bool(previous_month) and previous_month != zhvi_last).lower(),
            notify=str(bool(alert_cfg.get("notify", True))).lower(),
            alerts_title="Housing alerts: {} {} data".format(FULL_MONTHS[idx % 12], idx // 12),
        )
    if write_if_changed(os.path.join(DATA_DIR, "metros.json"), dumps(metro_list)):
        changed.append("metros.json")
    if write_if_changed(os.path.join(DATA_DIR, "latest.csv"), latest_csv(metro_list, zhvi_last)):
        changed.append("latest.csv")

    meta = {
        "site_title": config.get("site_title") or "Housing Market Tracker",
        "source_page": ZILLOW_PAGE,
        "latest_month": zhvi_last,
        "metro_count": sum(1 for m in metro_list if m["type"] == "metro"),
        "featured": featured,
        "photos_enabled": bool(photos_enabled),
        "datasets": [
            {
                "key": ds["key"],
                "label": ds["label"],
                "unit": ds["unit"],
                "note": ds["note"],
                "latest_month": index_month(loaded[ds["key"]]["last"]),
                "source_url": ZILLOW_BASE + ds["path"],
            }
            for ds in DATASETS
        ],
    }
    meta_path = os.path.join(DATA_DIR, "meta.json")
    old_meta = read_json(meta_path) or {}
    old_updated = old_meta.pop("updated_at", None)
    if changed or old_meta != meta or not old_updated:
        meta["updated_at"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    else:
        meta["updated_at"] = old_updated
    if write_if_changed(meta_path, dumps(meta, pretty=True)):
        changed.append("meta.json")

    if changed:
        log("Updated {} file(s); data through {}.".format(len(changed), zhvi_last))
    else:
        log("No changes: Zillow hasn't published anything new since the last run.")


if __name__ == "__main__":
    main()
