# `screener-poll_breakout.sh` — small-float momentum scanner

Real-time terminal scanner for low-float momentum runners. Polls Finviz every 20s,
enriches with multi-source news, fires distinct audio alerts on actionable events,
and renders a clickable terminal table.

## Run

```bash
./screener-poll_breakout.sh    # Ctrl+C to stop. No CLI args.
```

Reads `.env` from the script's directory. Required env vars:
- `FINVIZ_API_TOKEN` — Finviz Elite key
- `BENZINGA_API_TOKEN` — Benzinga free/basic API key (optional; gracefully degrades if missing)

## Screener filter

Set via the `SCREEN_FILTER` constant near the top of the script. Current value:

```
ind_stocksonly,sh_float_u50,sh_price_1to25,sh_relvol_o5,ta_change_20to
```

| Filter | Meaning | Notes |
|--------|---------|-------|
| `ind_stocksonly` | Common stocks only (no ETFs) | |
| `sh_float_u50` | Float < 50M | Finviz only offers `u1/u5/u10/u20/u50/u100` buckets — we use `u50` and post-filter to <35M in Python via `FLOAT_MAX_M`. |
| `sh_price_1to25` | Price $1–$25 | |
| `sh_relvol_o5` | Relative volume > 5× | |
| `ta_change_20to` | Change % ≥ 20% (no upper bound) | |

Sort: `o=-change` (descending change %).

Two parallel screener calls per cycle, joined by ticker:
- `v=131` (Ownership view) — gives Float, MCap, Price, Change, Volume
- `v=110` (Overview) — gives Country (only field v=131 lacks)

No single Finviz view returns both Float AND Country. Both calls share the same filter, so they always return the same ticker set.

## News pipeline (per cycle)

Three sources merged into a single per-cycle `NEWS_DISPLAY_FILE` (ticker → headline) plus a separate `FRESH_BZ_FILE` (audio classification).

### 1. Finviz news (batch)
- Endpoint: `elite.finviz.com/news_export?v=3&t=TICKER1,TICKER2,...`
- One call per cycle for all filtered tickers (batch via comma-separated `t=`).
- Filtered to today's date in ET (`TODAY_ET` strict match on date prefix — Finviz dates are ET-local).
- Strong coverage of GlobeNewswire / PR Newswire / Business Wire press releases.

### 2. Yahoo Finance RSS (per-ticker, parallel)
- Endpoint: `feeds.finance.yahoo.com/rss/2.0/headline?s=TICKER&region=US&lang=en-US`
- One call per ticker (Yahoo doesn't support batch), fanned out via background jobs + `wait`.
- Filtered to today's date in ET (RFC 822 pubDate parsed with TZ awareness, converted to ET).
- Aggregates Bloomberg, MarketWatch, MotleyFool, etc. Fills gaps Finviz misses.
- **Yahoo overrides Finviz** for the same ticker (broader/fresher coverage).

### 3. Benzinga API (delta + cumulative cache)
- Endpoint: `api.benzinga.com/api/v2/news?updatedSince=...&displayOutput=headline`
- **Required header**: `Accept: application/json` (defaults to XML otherwise).
- Delta query: `updatedSince = stored_max_ts - 5` (5s overlap per Benzinga's recommended pattern).
- Strict dedup: an article counts as "fresh" only if `ts > stored_max_ts` (skips overlap window articles seen last cycle). **Each article fires audio at most once per script run.**
- Cumulative cache (`BZ_HEADLINE_CACHE`): persists across cycles so headlines remain visible long after the audio fired. Auto-clears at midnight ET.
- Filtered to today's date in ET at the parser, so the cache only stores today's news.
- **Benzinga overrides Yahoo + Finviz** in the display merge (latest known).

### Merge precedence
For the same ticker on the same cycle: Benzinga > Yahoo > Finviz. The display always reflects the freshest known headline.

## Visual indicators

### Per-row markers (next to ticker)
| Marker | Meaning |
|--------|---------|
| `🔥` | Ticker has a news catalyst today (any source) |
| `🚨` | Ticker has news that dropped THIS cycle (Benzinga delta hit) |
| (none) | No today-news for this ticker |

### Banners (above the table)
| Banner | Color | Trigger |
|--------|-------|---------|
| `🆕 NEW WITH CATALYST: TICKER...` | bold green | Any new screener entrant has news today |
| `🚨 FRESH NEWS: TICKER...` | bold yellow | Any ticker got fresh Benzinga news this cycle |

### Row colors
- **Bold yellow row** — ticker is in `FRESH_BZ_TICKERS` (urgent attention)
- Plain text — everything else

### URL append
Each row ends with `https://elite.finviz.com/quote?t=TICKER&ty=c&p=h&b=1`. iTerm2 / Terminal.app auto-detect URLs and make them cmd+clickable. Toggle via `BROWSER_LINKS` (1=on, 0=off).

OSC 8 hyperlinks were tried first but didn't render reliably across terminals — plain URLs always work.

## Status codes (STAT column)

| Code | Meaning |
|------|---------|
| `NEW` | Ticker just entered the screener (no `prev_change` recorded) |
| `ACC` | Change % jumped > `ACCEL_THRESHOLD` (default 2%) since last cycle |
| `UP`  | Change % rose by less than the ACC threshold |
| `NEWS` | Ticker had no movement classification but has news today (still surfaced) |

## Audio alerts

One sound per cycle, fired in priority order:

| # | Trigger | Sound | Voice phrase | Suppressed on first poll? |
|---|---------|-------|--------------|---------------------------|
| 1 | NEW + has news catalyst | `Funk.aiff` | "Catalyst on TICKER" | **No** — fires even on cycle 1 |
| 2 | NEW (plain, no news) | `Glass.aiff` | "New: TICKER" | Yes |
| 3 | ACC (price acceleration) | `Hero.aiff` | "TICKER accelerating" | Yes |
| 4 | FRESH_BZ (Benzinga delta) | `Submarine.aiff` | "Fresh news on TICKER" | Yes |

Voice lists tickers if 3 or fewer; otherwise announces a count.

The first-poll suppression for #2–#4 prevents flooding when `PREV_FILE` is empty (everything is "new" at startup). NEW+catalyst is exempt because catching the catalyst on script startup is the high-value moment.

## Configuration knobs (top of script)

| Constant | Default | Description |
|----------|---------|-------------|
| `INTERVAL` | `20` | Seconds between polls |
| `TOP_N` | `50` | Max rows returned from screener |
| `FLOAT_MAX_M` | `35` | Post-filter ceiling on shares float (millions) |
| `ACCEL_THRESHOLD` | `2.0` | Change % delta to trigger ACC alert |
| `BZ_LOOKBACK` | `1800` | Initial Benzinga lookback on first poll (seconds) |
| `BROWSER_LINKS` | `1` | 1 = append clickable Finviz URL to each row |
| `SCREEN_FILTER` | (see above) | Finviz filter expression |

## Persistent state files

All under `mktemp` (`/tmp/`), cleaned up on script exit via `trap`:

| Variable | Purpose |
|----------|---------|
| `PREV_FILE` | `TICKER=last_change%` lines for cross-cycle delta detection |
| `BZ_TS_FILE` | Stores actual max Benzinga `updated` timestamp (no -5s offset) for dedup |
| `BZ_HEADLINE_CACHE` | Persistent ticker → latest Benzinga headline. Auto-cleared at midnight ET. |
| `LAST_DATE_FILE` | Tracks `TODAY_ET` across cycles to detect midnight rollover |

Per-cycle tempfiles (created/deleted each iteration):
- `NEWS_DISPLAY_FILE` — final ticker → headline map for display
- `FRESH_BZ_FILE` — list of tickers whose Benzinga article was fresh this cycle (audio classification)

## Architecture (per-cycle data flow)

```
┌─ Finviz v=131 (Ownership) ──┐
│                             ├──join by ticker──> ROWS (filtered, post-filtered float<35M)
└─ Finviz v=110 (Overview) ───┘                          │
                                                         │
┌─ Finviz news_export ────────┐                          │
│  (batch, today only)        │                          │
├─ Yahoo RSS (per-ticker,     ├──merge by ticker──> NEWS_DISPLAY_FILE
│  parallel, today only)      │     (Benzinga > Yahoo > Finviz)
└─ Benzinga API delta ────────┤
   ↓                          │
   BZ_HEADLINE_CACHE ─────────┘
   (persistent across cycles)
   ↓
   FRESH_BZ_FILE (this cycle's truly-new articles only)
                                                         │
                                                         ↓
                                                  row-rendering loop
                                                  (classify NEW/ACC/UP/NEWS,
                                                   decorate with 🔥/🚨,
                                                   append URL, wrap colors)
                                                         ↓
                                                  audio alert + display
```

## Known limitations / coverage gaps

### BZ Wire content not in API
The free/basic Benzinga API tier excludes "Benzinga Wire" auto-generated content (LULD circuit-breaker halt notices, Movers feeds). Confirmed by direct ticker query returning 0 articles for tickers with visible Pro UI Wire content.

**Mitigation:** NASDAQ's free public halts RSS at `nasdaqtrader.com/rss.aspx?feed=tradehalts` is the upstream source for halt content. Adding it is the next planned source.

### Yahoo Finance RSS sparse for microcaps
Yahoo's per-ticker RSS aggregates major financial outlets but often misses small-cap PR releases that Finviz's GlobeNewswire / PR Newswire pipeline catches. The 3-source stack mitigates by treating each source as additive.

### Pre-market quietness
Finviz's `change >=20%` filter typically returns 0–3 rows pre-market. `[TIMESTAMP] No data returned` is normal before US market open.

## Gotchas / non-obvious behaviors

### Finviz `export.ashx` was deprecated
Finviz silently moved `elite.finviz.com/export.ashx` → `elite.finviz.com/export` (no `.ashx`) in early 2026. The old path now returns HTTP 301. **All curl calls in this repo use `-L` to follow redirects** as a future-proof safety net, regardless of which path is current.

### `${var//%/}` doesn't strip on macOS bash 3.2
macOS ships GPLv2 bash 3.2.57 which silently fails on unescaped `%` in parameter expansion. Always escape: `${var//\%/}`. Affected the original script's ACC/UP detection (silently broken until found).

### Benzinga API returns XML by default
`Accept: application/json` header is required. Without it, the response is XML and the JSON parser returns 0 articles silently.

### Finviz dates have no timezone
Finviz news dates like `2026-04-29 07:15:00` are ET-local but have no TZ suffix. Strict-today filtering does a prefix match (`date_str.startswith(today_et)`).

### `TODAY_ET=""` disables strict-today
If you want to revert to a rolling lookback (e.g., to catch overnight catalysts that drove premarket gaps), edit the line where `TODAY_ET` is computed and set it to `""`. All three parsers fall back to no date filter.

## Future enhancements (planned)

1. **NASDAQ trade-halts RSS as 4th source** — surfaces circuit-breaker halt notices (BZ-Wire-only content) for free. Probably uses a 🛑 marker distinct from 🔥/🚨.
2. **Article URLs in news suffix** — clickable headline → full article. Currently just the ticker links to Finviz quote page.

## Pricing context (when to upgrade)

Current cost: Finviz Elite (~$25/mo, screener + news) + free Benzinga API key.

If the free Benzinga key gets revoked when the Pro trial expires, OR if measurable catalyst gaps appear after running with the full 4-source stack:
- **Massive (formerly Polygon.io) Stocks Starter** ($29/mo) + **Benzinga partnership** ($99/mo) = $128/mo for full Benzinga firehose
- **Don't go Stocks Advanced** ($199/mo) — that's for real-time tick data, which isn't needed for this scanner
- **Don't cancel Finviz** — Massive sells raw API data, not a screener; replicating Finviz's filters would mean weeks of engineering

See `memory/benzinga-api.md` for more on the Pro vs API distinction.

## Related sibling scripts

- `screener-poll_1min_2percent.sh` — different filter, same polling pattern
- `screener-poll_2min_5percent.sh` — different filter, same polling pattern

The news pipeline + visual/audio system in this doc is specific to `screener-poll_breakout.sh`. Sibling scripts use the same Finviz polling pattern but lack news enrichment. They could be ported by lifting the news block + display code.
