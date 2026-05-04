#!/usr/bin/env bash
# Polls Finviz for top gainers every 15s, detects breakouts in top 50
# Alerts on: new entrants (climbed into top 50) + acceleration (change% jumping)
# Filters: stocks only (no ETFs). Sub-$1 stocks and nano-caps are KEPT.
# Usage: ./screener-poll_breakout.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/.env"

# Finviz only offers float buckets at u1/u5/u10/u20/u50/u100 — we use u50 and post-filter to <35M in Python.
# Two calls per cycle: v=131 has float (no country), v=110 has country (no float). Same filter, joined by ticker.
SCREEN_FILTER="ind_stocksonly,sh_float_u50,sh_price_1to25,sh_relvol_o5,ta_change_20to"
URL_OWNERSHIP="https://elite.finviz.com/export?v=131&f=${SCREEN_FILTER}&o=-change&auth=${FINVIZ_API_TOKEN}"
URL_OVERVIEW="https://elite.finviz.com/export?v=110&f=${SCREEN_FILTER}&o=-change&auth=${FINVIZ_API_TOKEN}"
FLOAT_MAX_M=35   # post-filter: drop rows with shares float >= 35M
INTERVAL=20
TOP_N=50
ACCEL_THRESHOLD=2.0  # change% jump in one poll to trigger acceleration alert
BZ_LOOKBACK=1800     # initial Benzinga news lookback on first poll (seconds)
BROWSER_LINKS=1      # 1 = wrap tickers with OSC 8 hyperlinks (cmd+click → Finviz quote page)

PREV_FILE=$(mktemp)
BZ_TS_FILE=$(mktemp)
BZ_HEADLINE_CACHE=$(mktemp)   # persistent across cycles: ticker -> latest Benzinga headline
LAST_DATE_FILE=$(mktemp)      # tracks TODAY_ET across cycles to auto-clear cache at midnight ET
trap 'rm -f "$PREV_FILE" "$BZ_TS_FILE" "$BZ_HEADLINE_CACHE" "$LAST_DATE_FILE"' EXIT
echo "" > "$LAST_DATE_FILE"
# BZ_TS_FILE stores the ACTUAL max `updated` timestamp seen so far (no overlap subtraction).
# We query updatedSince = stored - 5 to absorb race conditions, but dedup audio alerts
# against the strict stored value so each article fires at most once.
echo $(($(date +%s) - BZ_LOOKBACK)) > "$BZ_TS_FILE"
FIRST_POLL=1

# ANSI codes for visual emphasis.
ESC=$'\033'
C_FRESH="${ESC}[1;33m"     # bold yellow — fresh Benzinga delta this cycle
C_NEW_NEWS="${ESC}[1;32m"  # bold green — new top-gainer entrant with catalyst (best entry signal)
C_RESET="${ESC}[0m"

if [[ -z "${BENZINGA_API_TOKEN:-}" ]]; then
  echo "WARN: BENZINGA_API_TOKEN not set in .env — news flagging disabled"
fi

echo "=== Finviz Breakout Scanner (every ${INTERVAL}s, top ${TOP_N}) ==="
echo "Filters: stocks only, float <${FLOAT_MAX_M}M, price \$1-\$25, rel vol >5x, change >=20%, sorted desc"
echo "Alerts: NEW entrants + ACC (change% jumps >${ACCEL_THRESHOLD}%) + 🔥 today's news (Finviz/Yahoo/Benzinga) + 🚨 fresh news this cycle (Benzinga delta)"
echo "Press Ctrl+C to stop"
echo ""

while true; do
  TIMESTAMP=$(date '+%H:%M:%S')
  # Today's calendar date in US Eastern time. News sources are filtered to this date only;
  # change to "" to disable strict-today and revert to a rolling lookback in the parsers.
  TODAY_ET=$(TZ='America/New_York' date '+%Y-%m-%d')
  # Detect midnight ET rollover and clear the persistent Benzinga cache (yesterday's news
  # would otherwise linger and confuse the strict-today filter).
  if [[ "$(cat "$LAST_DATE_FILE")" != "$TODAY_ET" ]]; then
    : > "$BZ_HEADLINE_CACHE"
    echo "$TODAY_ET" > "$LAST_DATE_FILE"
  fi
  DATA_OWN=$(curl -sL -A "Mozilla/5.0" "$URL_OWNERSHIP" 2>/dev/null || true)
  DATA_OVR=$(curl -sL -A "Mozilla/5.0" "$URL_OVERVIEW"  2>/dev/null || true)

  if [[ -z "$DATA_OWN" ]]; then
    echo "[$TIMESTAMP] No data (empty response, retrying...)"
    sleep "$INTERVAL"
    continue
  fi

  # v=131 (ownership) columns: 0=No, 1=Ticker, 2=MCap, 3=SharesOutstanding, 4=SharesFloat,
  #   5=InsiderOwn, 6=InsiderTrans, 7=InstOwn, 8=InstTrans, 9=ShortFloat, 10=ShortRatio,
  #   11=AvgVolume, 12=Price, 13=Change, 14=Volume.  MCap & Float are in millions.
  # v=110 (overview)  columns: 0=No, 1=Ticker, 2=Company, 3=Sector, 4=Industry, 5=Country,
  #   6=MCap, 7=P/E, 8=Price, 9=Change, 10=Volume.
  # We join by ticker to add Country, then post-filter float < FLOAT_MAX_M.
  OVERVIEW_FILE=$(mktemp); echo "$DATA_OVR" > "$OVERVIEW_FILE"
  ROWS=$(echo "$DATA_OWN" | FLOAT_MAX_M=$FLOAT_MAX_M TOP_N=$TOP_N OVERVIEW_FILE=$OVERVIEW_FILE python3 -c "
import csv, sys, os
float_max = float(os.environ['FLOAT_MAX_M'])
top_n = int(os.environ['TOP_N'])

# Build ticker -> country map from overview CSV.
country_by_ticker = {}
try:
    with open(os.environ['OVERVIEW_FILE']) as fh:
        for r in list(csv.reader(fh))[1:]:
            if len(r) >= 6: country_by_ticker[r[1]] = r[5][:14]
except Exception: pass

rows = list(csv.reader(sys.stdin))[1:]
emitted = 0
for row in rows:
    if emitted >= top_n: break
    if len(row) < 15: continue
    ticker = row[1]
    try: f = float(row[4] or 0)
    except: f = 0
    if f <= 0 or f >= float_max: continue
    floatfmt = f'{f:.1f}M' if f>=1 else f'{f*1000:.0f}K'
    try: m = float(row[2] or 0)
    except: m = 0
    mcapfmt = f'{m/1000:.1f}B' if m>=1000 else f'{m:.0f}M' if m>0 else '-'
    price, change = row[12], row[13]
    try:
        v = float(row[14] or 0)
        volfmt = f'{v/1e9:.1f}B' if v>=1e9 else f'{v/1e6:.1f}M' if v>=1e6 else f'{v/1e3:.0f}K' if v>=1e3 else str(int(v))
    except: volfmt = row[14]
    country = country_by_ticker.get(ticker, '-')
    print(f'{ticker}\t{change}\t{floatfmt}\t{price}\t{volfmt}\t{mcapfmt}\t{country}')
    emitted += 1
")
  rm -f "$OVERVIEW_FILE"

  COUNT=$(echo "$ROWS" | grep -c . || true)
  if [[ "$COUNT" -eq 0 ]]; then
    echo "[$TIMESTAMP] No data returned"
    sleep "$INTERVAL"
    continue
  fi

  # NEWS PIPELINE — two distinct sources, two distinct files:
  #   NEWS_DISPLAY_FILE = Finviz today's news (broad coverage incl. wire releases like
  #     GlobeNewswire/PR Newswire) UNION Benzinga delta. Drives the 🔥 + headline display.
  #   FRESH_BZ_FILE    = Benzinga delta only (articles since last cycle's watermark).
  #     Drives audio alerts — we only beep on genuinely-fresh news, not stale catalysts.
  NEWS_DISPLAY_FILE=$(mktemp)
  FRESH_BZ_FILE=$(mktemp)

  # 1) Finviz news for filtered tickers (batch, last 24h). One call regardless of N tickers.
  TICKER_LIST=$(echo "$ROWS" | cut -f1 | sort -u | tr '\n' ',' | sed 's/,$//')
  if [[ -n "$TICKER_LIST" ]]; then
    FINVIZ_NEWS_CSV=$(curl -sL -A "Mozilla/5.0" \
      "https://elite.finviz.com/news_export?v=3&t=${TICKER_LIST}&auth=${FINVIZ_API_TOKEN}" \
      2>/dev/null || true)
    echo "$FINVIZ_NEWS_CSV" | NEWS_DISPLAY_FILE=$NEWS_DISPLAY_FILE TODAY_ET=$TODAY_ET python3 -c "
import csv, sys, os, time, calendar
today_et = os.environ.get('TODAY_ET', '')
news_by_ticker = {}
for r in csv.reader(sys.stdin):
    if len(r) < 6: continue
    title, source, date_str, url, cat, ticker = r[0], r[1], r[2], r[3], r[4], r[5]
    if title == 'Title': continue
    # Finviz dates are ET-local — strict today match by prefix.
    if today_et and not date_str.startswith(today_et): continue
    try: ts = calendar.timegm(time.strptime(date_str, '%Y-%m-%d %H:%M:%S'))
    except: continue
    title = title.replace('\t',' ').replace('\n',' ').strip()
    prev = news_by_ticker.get(ticker)
    if not prev or ts > prev[0]:
        news_by_ticker[ticker] = (ts, title)
with open(os.environ['NEWS_DISPLAY_FILE'], 'w') as f:
    for tk, (ts, title) in news_by_ticker.items():
        f.write(f'{tk}\t{title}\n')
" 2>/dev/null || true
  fi

  # 1b) Yahoo Finance RSS — broader aggregator (Bloomberg, MarketWatch, MotleyFool, etc.).
  # Per-ticker fetch (no batch endpoint), parallel fan-out via background jobs.
  # Yahoo overrides Finviz when both have a headline (Yahoo's coverage tends to be fresher).
  if [[ -n "$TICKER_LIST" ]]; then
    YAHOO_RAW=$(mktemp)
    for tk in $(echo "$TICKER_LIST" | tr ',' ' '); do
      (
        curl -sL -A "Mozilla/5.0" --max-time 5 \
          "https://feeds.finance.yahoo.com/rss/2.0/headline?s=${tk}&region=US&lang=en-US" \
          2>/dev/null | TICKER="$tk" TODAY_ET="$TODAY_ET" python3 -c "
import sys, os
import xml.etree.ElementTree as ETree
from datetime import datetime, timezone
try:
    from zoneinfo import ZoneInfo
    ET_TZ = ZoneInfo('America/New_York')
except ImportError:
    from datetime import timedelta
    ET_TZ = timezone(timedelta(hours=-4))
ticker = os.environ['TICKER']
today_et = os.environ.get('TODAY_ET', '')
try:
    items = ETree.parse(sys.stdin).findall('.//item')
except Exception:
    items = []
best = None
for it in items:
    pub_full = (it.findtext('pubDate') or '').strip()
    title = (it.findtext('title') or '').strip()
    if not pub_full: continue
    # Try RFC 822 with explicit TZ first, then fallback assuming UTC.
    dt = None
    for fmt in ('%a, %d %b %Y %H:%M:%S %z', '%a, %d %b %Y %H:%M:%S %Z'):
        try:
            dt = datetime.strptime(pub_full, fmt); break
        except: pass
    if dt is None:
        try:
            dt = datetime.strptime(pub_full[:25], '%a, %d %b %Y %H:%M:%S').replace(tzinfo=timezone.utc)
        except: continue
    art_date_et = dt.astimezone(ET_TZ).strftime('%Y-%m-%d')
    if today_et and art_date_et != today_et: continue
    ts = int(dt.timestamp())
    title = title.replace('\t',' ').replace('\n',' ')
    if best is None or ts > best[0]:
        best = (ts, title)
if best:
    print(f'{ticker}\t{best[1]}')
" 2>/dev/null
      ) >> "$YAHOO_RAW" &
    done
    wait
    # Merge: Yahoo entry overrides any existing Finviz entry for the same ticker.
    while IFS=$'\t' read -r y_ticker y_title; do
      [[ -z "$y_ticker" ]] && continue
      grep -v "^${y_ticker}	" "$NEWS_DISPLAY_FILE" > "${NEWS_DISPLAY_FILE}.tmp" 2>/dev/null || true
      mv "${NEWS_DISPLAY_FILE}.tmp" "$NEWS_DISPLAY_FILE"
      echo -e "${y_ticker}\t${y_title}" >> "$NEWS_DISPLAY_FILE"
    done < "$YAHOO_RAW"
    rm -f "$YAHOO_RAW"
  fi

  # 2) Benzinga delta — query with a 5s overlap for race-safety, but classify articles
  #    as truly fresh (audio-worthy) ONLY if their timestamp exceeds the stored watermark.
  #    All seen articles update BZ_HEADLINE_CACHE, which persists across cycles so
  #    headlines remain visible long after the audio alert fired.
  if [[ -n "${BENZINGA_API_TOKEN:-}" ]]; then
    LAST_BZ_TS=$(cat "$BZ_TS_FILE")
    QUERY_SINCE=$((LAST_BZ_TS - 5))
    NEWS_JSON=$(curl -s -A "Mozilla/5.0" -H "Accept: application/json" \
      "https://api.benzinga.com/api/v2/news?pageSize=100&updatedSince=${QUERY_SINCE}&displayOutput=headline&token=${BENZINGA_API_TOKEN}" \
      2>/dev/null || echo "[]")
    BZ_RESULT=$(echo "$NEWS_JSON" | LAST_BZ_TS=$LAST_BZ_TS BZ_HEADLINE_CACHE=$BZ_HEADLINE_CACHE TODAY_ET=$TODAY_ET python3 -c "
import json, sys, time, calendar, os
from datetime import datetime, timezone
try:
    from zoneinfo import ZoneInfo
    ET_TZ = ZoneInfo('America/New_York')
except ImportError:
    from datetime import timedelta
    ET_TZ = timezone(timedelta(hours=-4))

cache_path = os.environ['BZ_HEADLINE_CACHE']
last_max = int(os.environ.get('LAST_BZ_TS', '0'))
today_et = os.environ.get('TODAY_ET', '')

# Load persistent cache (ticker -> headline).
cache = {}
if os.path.exists(cache_path) and os.path.getsize(cache_path) > 0:
    with open(cache_path) as fh:
        for line in fh:
            parts = line.rstrip('\n').split('\t', 1)
            if len(parts) == 2: cache[parts[0]] = parts[1]

try: items = json.loads(sys.stdin.read())
except: items = []

new_max = last_max
fresh = set()
for it in items:
    raw = it.get('updated','')
    try: ts = calendar.timegm(time.strptime(raw[:25], '%a, %d %b %Y %H:%M:%S'))
    except: continue
    if ts > new_max: new_max = ts
    is_fresh = ts > last_max
    # Strict today-in-ET filter: skip the article entirely if not today.
    if today_et:
        try:
            dt = datetime.strptime(raw, '%a, %d %b %Y %H:%M:%S %z')
        except ValueError:
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        if dt.astimezone(ET_TZ).strftime('%Y-%m-%d') != today_et:
            continue
    title = (it.get('title') or '').replace('\t',' ').replace('\n',' ').strip()
    for s in it.get('stocks', []) or []:
        tk = (s.get('name') or '').strip().upper()
        if not tk: continue
        cache[tk] = title
        if is_fresh: fresh.add(tk)

with open(cache_path, 'w') as fh:
    for tk, title in cache.items():
        fh.write(f'{tk}\t{title}\n')

print(new_max)
for tk in fresh: print(f'FRESH\t{tk}')
" 2>/dev/null || echo 0)
    NEW_BZ_TS=$(echo "$BZ_RESULT" | head -1)
    # grep exits 1 with no matches; absorb it under set -e + pipefail.
    echo "$BZ_RESULT" | { grep '^FRESH	' || true; } | cut -f2 > "$FRESH_BZ_FILE"
    if [[ -n "$NEW_BZ_TS" && "$NEW_BZ_TS" != "0" ]]; then
      echo "$NEW_BZ_TS" > "$BZ_TS_FILE"   # actual max — no -5s offset
    fi
  fi

  # 3) Union the cumulative Benzinga cache into the per-cycle display map. Benzinga
  #    overrides Finviz for the same ticker (Benzinga's editorial headlines are the
  #    most recent known per ticker; Finviz contributes broader wire-release coverage).
  if [[ -s "$BZ_HEADLINE_CACHE" ]]; then
    while IFS=$'\t' read -r bz_ticker bz_title; do
      [[ -z "$bz_ticker" ]] && continue
      grep -v "^${bz_ticker}	" "$NEWS_DISPLAY_FILE" > "${NEWS_DISPLAY_FILE}.tmp" 2>/dev/null || true
      mv "${NEWS_DISPLAY_FILE}.tmp" "$NEWS_DISPLAY_FILE"
      echo -e "${bz_ticker}\t${bz_title}" >> "$NEWS_DISPLAY_FILE"
    done < "$BZ_HEADLINE_CACHE"
  fi

  NEW_TICKERS=()
  NEW_WITH_NEWS_TICKERS=()   # new entrants AND have a news catalyst — top audio priority
  ACCEL_TICKERS=()
  NEWS_TICKERS=()
  FRESH_BZ_TICKERS=()
  UPDATED_LINES=()

  while IFS=$'\t' read -r ticker change float_str price volume mcap country; do
    prev_change=$(grep "^${ticker}=" "$PREV_FILE" 2>/dev/null | cut -d'=' -f2 || true)

    # Display headline (any source, today). Audio classification (Benzinga delta only).
    news_title=$(grep "^${ticker}	" "$NEWS_DISPLAY_FILE" 2>/dev/null | head -1 | cut -f2- || true)
    is_fresh=0
    if grep -qx "$ticker" "$FRESH_BZ_FILE" 2>/dev/null; then
      FRESH_BZ_TICKERS+=("$ticker")
      is_fresh=1
    fi
    if [[ -n "$news_title" ]]; then
      # 🚨 = news dropped THIS cycle (urgent), 🔥 = today's catalyst (informational).
      if [[ "$is_fresh" -eq 1 ]]; then
        ticker_disp="${ticker} 🚨"
      else
        ticker_disp="${ticker} 🔥"
      fi
      news_suffix=$(printf "  %s" "${news_title:0:70}")
    else
      ticker_disp="$ticker"
      news_suffix=""
    fi

    # Bold-yellow wrap for fresh-news rows; no-op otherwise.
    if [[ "$is_fresh" -eq 1 ]]; then
      row_pre="$C_FRESH"; row_post="$C_RESET"
    else
      row_pre=""; row_post=""
    fi

    # Plain Finviz URL appended to each row — iTerm2 / Terminal.app auto-detect URLs
    # and make them cmd+clickable. Simpler & more reliable than OSC 8 hyperlinks.
    if [[ "$BROWSER_LINKS" -eq 1 ]]; then
      url_suffix="  https://elite.finviz.com/quote?t=${ticker}&ty=c&p=h&b=1"
    else
      url_suffix=""
    fi

    emitted=0
    if [[ -z "$prev_change" ]]; then
      NEW_TICKERS+=("$ticker")
      [[ -n "$news_title" ]] && NEW_WITH_NEWS_TICKERS+=("$ticker")
      line=$(printf "  %-4s  %-10s %8s %8s %8s %10s %8s  %-14s" "NEW" "$ticker_disp" "$change" "$float_str" "$price" "$volume" "$mcap" "$country")
      UPDATED_LINES+=("${row_pre}${line}${news_suffix}${url_suffix}${row_post}")
      emitted=1
    elif [[ "$prev_change" != "$change" ]]; then
      cur_num=${change//\%/}
      prev_num=${prev_change//\%/}
      delta=$(awk "BEGIN{printf \"%.2f\", $cur_num - $prev_num}")
      if awk "BEGIN{exit !($delta > $ACCEL_THRESHOLD)}"; then
        ACCEL_TICKERS+=("$ticker")
        line=$(printf "  %-4s  %-10s %8s %8s %8s %10s %8s  %-14s  (+%s%%)" "ACC" "$ticker_disp" "$change" "$float_str" "$price" "$volume" "$mcap" "$country" "$delta")
        UPDATED_LINES+=("${row_pre}${line}${news_suffix}${url_suffix}${row_post}")
        emitted=1
      elif awk "BEGIN{exit !($delta > 0)}"; then
        line=$(printf "  %-4s  %-10s %8s %8s %8s %10s %8s  %-14s  (+%s%%)" "UP" "$ticker_disp" "$change" "$float_str" "$price" "$volume" "$mcap" "$country" "$delta")
        UPDATED_LINES+=("${row_pre}${line}${news_suffix}${url_suffix}${row_post}")
        emitted=1
      fi
    fi

    # No movement-driven row emitted but news dropped this cycle — surface it.
    if [[ "$emitted" -eq 0 && -n "$news_title" ]]; then
      NEWS_TICKERS+=("$ticker")
      line=$(printf "  %-4s  %-10s %8s %8s %8s %10s %8s  %-14s" "NEWS" "$ticker_disp" "$change" "$float_str" "$price" "$volume" "$mcap" "$country")
      UPDATED_LINES+=("${row_pre}${line}${news_suffix}${url_suffix}${row_post}")
    fi
  done <<< "$ROWS"

  # Update per-ticker state (keep history across polls so tickers dropping out/back in aren't "new")
  while IFS=$'\t' read -r tk chg _ _ _ _; do
    if grep -q "^${tk}=" "$PREV_FILE" 2>/dev/null; then
      sed -i '' "s|^${tk}=.*|${tk}=${chg}|" "$PREV_FILE"
    else
      echo "${tk}=${chg}" >> "$PREV_FILE"
    fi
  done <<< "$ROWS"

  # Sound alerts — priority: NEW+news (catalyst + fresh entrant — highest)
  # > NEW (plain new entrant) > ACC (price acceleration) > FRESH_BZ (Benzinga delta).
  # Rationale: discovering a new top-gainer is more actionable than a known ticker
  # accelerating, so plain NEW now beats ACC.
  # NEW+news fires even on FIRST_POLL because catching the catalyst on script startup
  # is the high-value moment we don't want to miss. Other categories stay suppressed
  # on first poll to avoid a flood when PREV_FILE is empty (everything is "new").
  fired=0
  if [[ ${#NEW_WITH_NEWS_TICKERS[@]} -gt 0 ]]; then
    afplay /System/Library/Sounds/Funk.aiff &
    if [[ ${#NEW_WITH_NEWS_TICKERS[@]} -le 3 ]]; then
      catalyst_list=$(IFS=', '; echo "${NEW_WITH_NEWS_TICKERS[*]}")
      say "Catalyst on ${catalyst_list}" &
    else
      say "${#NEW_WITH_NEWS_TICKERS[@]} new gainers with catalysts" &
    fi
    fired=1
  fi
  if [[ "$fired" -eq 0 && "$FIRST_POLL" -eq 0 ]]; then
    if [[ ${#NEW_TICKERS[@]} -gt 0 ]]; then
      afplay /System/Library/Sounds/Glass.aiff &
      if [[ ${#NEW_TICKERS[@]} -le 3 ]]; then
        new_list=$(IFS=', '; echo "${NEW_TICKERS[*]}")
        say "New: ${new_list}" &
      else
        say "${#NEW_TICKERS[@]} new stocks in top ${TOP_N}" &
      fi
    elif [[ ${#ACCEL_TICKERS[@]} -gt 0 ]]; then
      afplay /System/Library/Sounds/Hero.aiff &
      if [[ ${#ACCEL_TICKERS[@]} -le 3 ]]; then
        accel_list=$(IFS=', '; echo "${ACCEL_TICKERS[*]}")
        say "${accel_list} accelerating" &
      else
        say "${#ACCEL_TICKERS[@]} stocks accelerating" &
      fi
    elif [[ ${#FRESH_BZ_TICKERS[@]} -gt 0 ]]; then
      afplay /System/Library/Sounds/Submarine.aiff &
      if [[ ${#FRESH_BZ_TICKERS[@]} -le 3 ]]; then
        news_list=$(IFS=', '; echo "${FRESH_BZ_TICKERS[*]}")
        say "Fresh news on ${news_list}" &
      else
        say "Fresh news on ${#FRESH_BZ_TICKERS[@]} stocks" &
      fi
    fi
  fi
  FIRST_POLL=0

  # Display
  if [[ ${#UPDATED_LINES[@]} -gt 0 ]]; then
    echo "[$TIMESTAMP] Top ${TOP_N} — ${#NEW_TICKERS[@]} new (${#NEW_WITH_NEWS_TICKERS[@]} w/news), ${#ACCEL_TICKERS[@]} accelerating, ${#NEWS_TICKERS[@]} news (${#FRESH_BZ_TICKERS[@]} fresh)"
    if [[ ${#NEW_WITH_NEWS_TICKERS[@]} -gt 0 ]]; then
      catalyst_csv=$(IFS=', '; echo "${NEW_WITH_NEWS_TICKERS[*]}")
      echo "${C_NEW_NEWS}══════════ 🆕 NEW WITH CATALYST: ${catalyst_csv} ══════════${C_RESET}"
    fi
    if [[ ${#FRESH_BZ_TICKERS[@]} -gt 0 ]]; then
      fresh_csv=$(IFS=', '; echo "${FRESH_BZ_TICKERS[*]}")
      echo "${C_FRESH}══════════ 🚨 FRESH NEWS: ${fresh_csv} ══════════${C_RESET}"
    fi
    printf "  %-4s  %-10s %8s %8s %8s %10s %8s  %-14s\n" "STAT" "TICKER" "CHG%" "FLOAT" "PRICE" "VOLUME" "MCAP" "COUNTRY"
    printf "  %-4s  %-10s %8s %8s %8s %10s %8s  %-14s\n" "----" "------" "----" "-----" "-----" "------" "----" "-------"
    for line in "${UPDATED_LINES[@]}"; do
      echo "$line"
    done
    echo ""
  else
    echo "[$TIMESTAMP] Top ${TOP_N} — no significant moves"
  fi

  rm -f "$NEWS_DISPLAY_FILE" "$FRESH_BZ_FILE"
  sleep "$INTERVAL"
done
