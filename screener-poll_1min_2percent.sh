#!/usr/bin/env bash
# Polls Finviz screener every 10 seconds and outputs matching stocks
# Only displays stocks whose change% has updated since last poll
# Usage: ./screener-poll_1min_2percent.sh

set -euo pipefail

# Load env
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/.env"

URL="https://elite.finviz.com/export.ashx?v=141&f=ta_change_u10,ta_perf_2to-i1&ft=4&o=-change&pt=1&auth=${FINVIZ_API_TOKEN}"
INTERVAL=10

# Track per-ticker change% in a temp file (associative arrays don't survive subshells)
PREV_FILE=$(mktemp)
trap 'rm -f "$PREV_FILE"' EXIT

echo "=== Finviz Screener Poll (every ${INTERVAL}s) ==="
echo "Filters: Change up 10%, Perf 2% to -1%"
echo "Press Ctrl+C to stop"
echo ""

while true; do
  TIMESTAMP=$(date '+%H:%M:%S')
  DATA=$(curl -sL -A "Mozilla/5.0" "$URL" 2>/dev/null || true)

  if [[ -z "$DATA" ]]; then
    echo "[$TIMESTAMP] No data (empty response, retrying...)"
    sleep "$INTERVAL"
    continue
  fi

  # Columns: 1=No, 2=Ticker, 3-12=Perf(1m,2m,3m,5m,10m,15m,30m,1h,2h,4h),
  #          13=Vol(Week), 14=Vol(Month), 15=AvgVol, 16=RelVol, 17=Price, 18=Change, 19=Volume
  ROWS=$(echo "$DATA" | tail -n +2)
  COUNT=$(echo "$ROWS" | grep -c . || true)

  if [[ "$COUNT" -eq 0 ]]; then
    echo "[$TIMESTAMP] No matching stocks"
    sleep "$INTERVAL"
    continue
  fi

  # Build current ticker:change map and detect changes
  NEW_TICKERS=()
  RISING_TICKERS=()
  UPDATED_LINES=()
  ALL_LINES=()

  while IFS=',' read -r no ticker p1m p2m p3m p5m p10m p15m p30m p1h p2h p4h vw vm avgvol relvol price change vol; do
    ticker=$(echo "$ticker" | tr -d '"')
    change=$(echo "$change" | tr -d '"')
    p5m=$(echo "$p5m" | tr -d '"')
    p15m=$(echo "$p15m" | tr -d '"')
    p1h=$(echo "$p1h" | tr -d '"')
    relvol=$(echo "$relvol" | tr -d '"')
    price=$(echo "$price" | tr -d '"')

    line=$(printf "  %-8s %8s %8s %8s %8s %10s %10s" "$ticker" "$change" "$p5m" "$p15m" "$p1h" "$relvol" "$price")
    ALL_LINES+=("$line")

    # Check previous change% for this ticker
    prev_change=$(grep "^${ticker}=" "$PREV_FILE" 2>/dev/null | cut -d'=' -f2 || true)

    if [[ -z "$prev_change" ]]; then
      # New ticker
      NEW_TICKERS+=("$ticker")
      UPDATED_LINES+=("$line")
    elif [[ "$prev_change" != "$change" ]]; then
      # Change% updated — check if rising
      cur_num=${change//%/}
      prev_num=${prev_change//%/}
      if awk "BEGIN{exit !($cur_num > $prev_num)}"; then
        RISING_TICKERS+=("$ticker")
      fi
      UPDATED_LINES+=("$line")
    fi
  done <<< "$ROWS"

  # Update per-ticker state (don't overwrite — keep tickers that temporarily drop out)
  while IFS=',' read -r no tk _ _ _ _ _ _ _ _ _ _ _ _ _ _ _ chg _; do
    tk=$(echo "$tk" | tr -d '"')
    chg=$(echo "$chg" | tr -d '"')
    if grep -q "^${tk}=" "$PREV_FILE" 2>/dev/null; then
      sed -i '' "s/^${tk}=.*/${tk}=${chg}/" "$PREV_FILE"
    else
      echo "${tk}=${chg}" >> "$PREV_FILE"
    fi
  done <<< "$ROWS"

  # Sound alert for new tickers or rising change%
  if [[ ${#NEW_TICKERS[@]} -gt 0 ]]; then
    new_list=$(IFS=','; echo "${NEW_TICKERS[*]}")
    afplay /System/Library/Sounds/Glass.aiff &
    say "${#NEW_TICKERS[@]} new stocks: ${new_list}" &
  elif [[ ${#RISING_TICKERS[@]} -gt 0 ]]; then
    rising_list=$(IFS=','; echo "${RISING_TICKERS[*]}")
    afplay /System/Library/Sounds/Ping.aiff &
    say "${rising_list} rising" &
  fi

  # Display
  if [[ ${#UPDATED_LINES[@]} -gt 0 ]]; then
    if [[ ${#NEW_TICKERS[@]} -gt 0 ]]; then
      echo "[$TIMESTAMP] *** ${COUNT} stocks (${#NEW_TICKERS[@]} new, ${#UPDATED_LINES[@]} updated) ***"
    else
      echo "[$TIMESTAMP] ${COUNT} stocks (${#UPDATED_LINES[@]} updated)"
    fi
    printf "  %-8s %8s %8s %8s %8s %10s %10s\n" "TICKER" "CHG%" "5min" "15min" "1hr" "REL.VOL" "PRICE"
    printf "  %-8s %8s %8s %8s %8s %10s %10s\n" "------" "-----" "-----" "------" "----" "-------" "-----"
    for line in "${UPDATED_LINES[@]}"; do
      echo "$line"
    done
    echo ""
  else
    echo "[$TIMESTAMP] ${COUNT} stocks (no change)"
  fi

  sleep "$INTERVAL"
done
