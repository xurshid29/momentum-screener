# Finviz Elite API Documentation

## Authentication

All API requests require the `auth` parameter with your API token.

```
auth=YOUR_API_TOKEN
```

Store your token in an environment variable or `.env` file (never commit tokens to version control).

## Base URLs

- **Elite (authenticated)**: `https://elite.finviz.com`
- **Public**: `https://finviz.com`

Note: Elite subdomain requires authentication. Public version may have the same form fields for reference.

---

## API Summary (Tested ✅)

| API | Endpoint | Response Format | Status |
|-----|----------|-----------------|--------|
| Screener | `export.ashx` | CSV with headers | ✅ Working |
| Quote History | `quote_export.ashx` | CSV (Date, OHLCV) | ✅ Working |
| Latest Filings | `export/latest-filings` | CSV (SEC filings) | ✅ Working |
| News | `news_export.ashx` | CSV (Title, Source, Date, URL) | ✅ Working |

---

## Screener API

Scan stocks based on filters.

| Type | URL |
|------|-----|
| Form View | `https://elite.finviz.com/screener.ashx?v=111&ft=4` |
| Export | `https://elite.finviz.com/export.ashx?v=111&f={filters}&auth={token}` |

### Example Request

```
https://elite.finviz.com/export.ashx?v=111&f=sec_technology,cap_largeover&auth={token}
```

### Example Response (CSV)

```csv
"No.","Ticker","Company","Sector","Industry","Country","Market Cap","P/E","Price","Change","Volume"
1,"AAPL","Apple Inc","Technology","Consumer Electronics","USA",3755760.96,34.26,255.53,-1.04%,72142773
2,"MSFT","Microsoft Corporation","Technology","Software - Infrastructure","USA",3417852.98,36.89,459.86,0.70%,34246650
```

Columns vary based on view type (`v` parameter).

### URL Parameters

| Param | Description | Example |
|-------|-------------|---------|
| `v` | View/table type | `111` (Overview) |
| `f` | Filters, comma-separated | `fa_div_pos,sec_technology` |
| `ft` | Filter tab (use `4` to show all filters) | `4` |
| `o` | Sort order (prefix `-` for descending) | `-ticker`, `price` |
| `t` | Specific tickers | `AAPL,MSFT` |
| `s` | Signal filter | `ta_newhigh` |
| `c` | Custom columns | column IDs |

### View Types (`v` parameter)

| View | Code | Columns Returned |
|------|------|------------------|
| Overview | `111` | Ticker, Company, Sector, Industry, Country, Market Cap, P/E, Price, Change, Volume |
| Valuation | `121` | Ticker, Market Cap, P/E, Forward P/E, PEG, P/S, P/B, P/Cash, P/FCF, EPS Growth rates, Price, Change, Volume |
| Ownership | `131` | Ticker, Market Cap, Outstanding, Float, Insider Own/Trans, Inst Own/Trans, Short Float, Short Ratio, Price, Change, Volume |
| Performance | `141` | Ticker, Perf Week/Month/Quarter/Half/Year/YTD, Volatility, RSI, Price, Change, Volume |
| Custom | `152` | User-defined columns |
| Financial | `161` | Ticker, Market Cap, Dividend, ROA, ROE, ROI, Curr Ratio, Quick Ratio, LT Debt/Eq, Debt/Eq, Margins, Earnings, Price, Change, Volume |
| Technical | `171` | Ticker, Beta, ATR, SMA20/50/200, 52W High/Low, RSI, Price, Change, Change from Open, Gap, Volume |

### Filter Categories

Extracted from elite screener page (`resources/finviz/`):

#### Descriptive Filters
| Filter ID | Description |
|-----------|-------------|
| `exch` | Exchange (NASDAQ, NYSE, AMEX) |
| `idx` | Index (S&P 500, DJIA, Russell 2000) |
| `sec` | Sector |
| `ind` | Industry |
| `geo` | Country/Geography |
| `cap` | Market Cap |
| `earningsdate` | Earnings Date |
| `ipodate` | IPO Date |

#### Fundamental Filters (`fa_*`)
| Filter ID | Description |
|-----------|-------------|
| `fa_pe` | P/E Ratio |
| `fa_fpe` | Forward P/E |
| `fa_peg` | PEG Ratio |
| `fa_ps` | Price/Sales |
| `fa_pb` | Price/Book |
| `fa_pc` | Price/Cash |
| `fa_pfcf` | Price/Free Cash Flow |
| `fa_div` | Dividend Yield |
| `fa_divgrowth` | Dividend Growth |
| `fa_payoutratio` | Payout Ratio |
| `fa_eps5years` | EPS Growth Past 5 Years |
| `fa_eps3years` | EPS Growth Past 3 Years |
| `fa_epsyoy` | EPS Growth This Year |
| `fa_epsyoy1` | EPS Growth Next Year |
| `fa_epsqoq` | EPS Growth Q/Q |
| `fa_epsyoyttm` | EPS Growth TTM YoY |
| `fa_epsrev` | EPS Revisions |
| `fa_estltgrowth` | Est. Long-Term Growth |
| `fa_sales5years` | Sales Growth Past 5 Years |
| `fa_sales3years` | Sales Growth Past 3 Years |
| `fa_salesqoq` | Sales Growth Q/Q |
| `fa_salesyoyttm` | Sales Growth TTM YoY |
| `fa_roa` | Return on Assets |
| `fa_roe` | Return on Equity |
| `fa_roi` | Return on Investment |
| `fa_curratio` | Current Ratio |
| `fa_quickratio` | Quick Ratio |
| `fa_debteq` | Debt/Equity |
| `fa_ltdebteq` | LT Debt/Equity |
| `fa_grossmargin` | Gross Margin |
| `fa_opermargin` | Operating Margin |
| `fa_netmargin` | Net Profit Margin |
| `fa_evebitda` | EV/EBITDA |
| `fa_evsales` | EV/Sales |

#### Technical Filters (`ta_*`)
| Filter ID | Description |
|-----------|-------------|
| `ta_perf` | Performance |
| `ta_perf2` | Performance 2 |
| `ta_volatility` | Volatility |
| `ta_rsi` | RSI (14) |
| `ta_gap` | Gap |
| `ta_sma20` | 20-Day SMA |
| `ta_sma50` | 50-Day SMA |
| `ta_sma200` | 200-Day SMA |
| `ta_change` | Change |
| `ta_changeopen` | Change from Open |
| `ta_highlow20d` | 20-Day High/Low |
| `ta_highlow50d` | 50-Day High/Low |
| `ta_highlow52w` | 52-Week High/Low |
| `ta_pattern` | Chart Pattern |
| `ta_candlestick` | Candlestick Pattern |
| `ta_beta` | Beta |
| `ta_averagetruerange` | ATR |
| `ta_alltime` | All-Time High/Low |

#### Ownership Filters (`sh_*`)
| Filter ID | Description |
|-----------|-------------|
| `sh_outstanding` | Shares Outstanding |
| `sh_float` | Float |
| `sh_insiderown` | Insider Ownership |
| `sh_insidertrans` | Insider Transactions |
| `sh_instown` | Institutional Ownership |
| `sh_insttrans` | Institutional Transactions |
| `sh_short` | Short Float |
| `sh_avgvol` | Average Volume |
| `sh_relvol` | Relative Volume |
| `sh_curvol` | Current Volume |
| `sh_price` | Price |
| `sh_opt` | Optionable |
| `sh_trades` | Number of Trades |

#### Other Filters
| Filter ID | Description |
|-----------|-------------|
| `an_recom` | Analyst Recommendation |
| `targetprice` | Target Price |
| `ah_change` | After-Hours Change |
| `ah_close` | After-Hours Close |
| `news_date` | News Date |
| `theme` | Theme |
| `subtheme` | Sub-Theme |

#### ETF Filters (`etf_*`)
| Filter ID | Description |
|-----------|-------------|
| `etf_category` | ETF Category |
| `etf_etftype` | ETF Type |
| `etf_assettype` | Asset Type |
| `etf_mktcap` | Market Cap Focus |
| `etf_region` | Region |
| `etf_sectortheme` | Sector/Theme |
| `etf_growthvalue` | Growth/Value |
| `etf_netexpense` | Net Expense Ratio |
| `etf_nav` | NAV |
| `etf_fundflows` | Fund Flows |
| `etf_return` | Return |
| `etf_dividendtype` | Dividend Type |
| `etf_bondtype` | Bond Type |
| `etf_bondmaturity` | Bond Maturity |
| `etf_commoditytype` | Commodity Type |
| `etf_currency` | Currency |
| `etf_inverse` | Inverse/Leveraged |
| `etf_indexweight` | Index Weighting |
| `etf_quanttype` | Quant Type |
| `etf_esgtype` | ESG Type |
| `etf_structuretype` | Structure Type |
| `etf_sponsor` | Sponsor |
| `etf_developed` | Developed/Emerging |
| `etf_active` | Active/Passive |
| `etf_heldby` | Held By |
| `etf_tags` | Tags |

### Sectors

- Basic Materials
- Communication Services
- Consumer Cyclical
- Consumer Defensive
- Energy
- Financial
- Healthcare
- Industrials
- Real Estate
- Technology
- Utilities

### Filter Value Patterns

Common suffixes for filter values:
- `_o{n}` - Over n (e.g., `fa_pe_o10` = P/E over 10)
- `_u{n}` - Under n (e.g., `fa_pe_u5` = P/E under 5)
- `_pos` - Positive
- `_neg` - Negative
- `_high` - High
- `_low` - Low
- `_none` - None/zero
- `_pa` - Price above (for moving averages)
- `_pb` - Price below
- `_nh` - New high
- `_nl` - New low
- `_ob` - Overbought
- `_os` - Oversold

### Signal Filters (`s` parameter)

| Signal | Description |
|--------|-------------|
| `ta_topgainers` | Top Gainers |
| `ta_toplosers` | Top Losers |
| `ta_newhigh` | New High |
| `ta_newlow` | New Low |
| `ta_mostvolatile` | Most Volatile |
| `ta_mostactive` | Most Active |
| `ta_unusualvolume` | Unusual Volume |
| `ta_overbought` | Overbought |
| `ta_oversold` | Oversold |

Intraday signals (append timeframe):
- `ta_topgainers_1m`, `ta_topgainers_5m`, `ta_topgainers_15m`, `ta_topgainers_30m`, `ta_topgainers_1h`, `ta_topgainers_2h`, `ta_topgainers_4h`
- Same pattern for `ta_toplosers_*`

### Chart Patterns (`ta_pattern` / `ta_p_*`)

| Pattern | Code |
|---------|------|
| Channel | `ta_p_channel` |
| Channel Up | `ta_p_channelup` |
| Channel Down | `ta_p_channeldown` |
| Double Bottom | `ta_p_doublebottom` |
| Double Top | `ta_p_doubletop` |
| Head & Shoulders | `ta_p_headandshoulders` |
| Head & Shoulders Inverse | `ta_p_headandshouldersinv` |
| Horizontal S/R | `ta_p_horizontal` |
| Multiple Bottom | `ta_p_multiplebottom` |
| Multiple Top | `ta_p_multipletop` |
| TL Resistance | `ta_p_tlresistance` |
| TL Support | `ta_p_tlsupport` |
| Wedge | `ta_p_wedge` |
| Wedge Up | `ta_p_wedgeup` |
| Wedge Down | `ta_p_wedgedown` |
| Wedge Resistance | `ta_p_wedgeresistance` |
| Wedge Support | `ta_p_wedgesupport` |

---

## Quote API

Get historical price data for a specific ticker.

| Type | URL |
|------|-----|
| Details View | `https://elite.finviz.com/quote.ashx?t={ticker}&p=d` |
| Export | `https://elite.finviz.com/quote_export.ashx?t={ticker}&p=d&auth={token}` |

### Parameters

- `t` - Ticker symbol (e.g., `MSFT`)
- `p` - Period (`d` = daily)

### Example Request

```
https://elite.finviz.com/quote_export.ashx?t=AAPL&p=d&auth={token}
```

### Example Response (CSV)

```csv
Date,Open,High,Low,Close,Volume
01/07/2016,24.67,25.032,24.108,24.112,324377728
01/08/2016,24.638,24.778,24.19,24.24,283192064
01/11/2016,24.743,24.765,24.335,24.632,198957504
```

**Note:** Returns historical daily OHLCV data starting from 2016, not current quote snapshot. For current quote data, use the Screener API with specific tickers (`t=AAPL,MSFT`).

### Quote Page Fields (HTML view only)

The quote.ashx HTML page displays these fields (not available via export):

**Valuation**: P/E, Forward P/E, PEG, P/S, P/B, P/C, P/FCF

**Financial**: EPS, EPS this Y, EPS next Y, EPS next Q, EPS Q/Q, Sales Q/Q, ROA, ROE, ROI, Current Ratio, Quick Ratio, Debt/Eq, LT Debt/Eq, Gross Margin, Oper. Margin, Profit Margin, Payout

**Ownership**: Insider Own, Insider Trans, Inst Own, Inst Trans, Float, Short Float, Short Ratio

**Technical**: Price, Change, Prev Close, Open, High, Low, 52W High, 52W Low, SMA20, SMA50, SMA200, RSI, Beta, ATR, Volatility, Perf (various periods)

**Other**: Market Cap, Income, Sales, Book/sh, Cash/sh, Dividend, Employees, Optionable, Shortable, Recom, Target Price, Earnings, Volume, Avg Volume, Rel Volume

---

## Latest Filings API

Get SEC filings for a specific ticker.

| Type | URL |
|------|-----|
| Details View | `https://elite.finviz.com/quote.ashx?t={ticker}&p=d&ty=lf` |
| Export | `https://elite.finviz.com/export/latest-filings?t={ticker}&o={sort}&auth={token}` |

### Parameters

- `t` - Ticker symbol
- `ty` - Type (`lf` = latest filings)
- `o` - Sort order (e.g., `-filingDate` for descending by date)

### Example Request

```
https://elite.finviz.com/export/latest-filings?t=AAPL&o=-filingDate&auth={token}
```

### Example Response (CSV)

```csv
Filing Date,Report Date,Form,Description,Filing,Document
1/8/2026,2/24/2026,DEF 14A,"Proxy Statement Pursuant to Section 14(a)...","https://www.sec.gov/...","https://www.sec.gov/..."
1/2/2026,12/30/2025,8-K,"Current report","https://www.sec.gov/...","https://www.sec.gov/..."
10/31/2025,9/27/2025,10-K,"Annual report pursuant to Section 13 or 15(d)","https://www.sec.gov/...","https://www.sec.gov/..."
```

### Common SEC Form Types

| Form | Description |
|------|-------------|
| 10-K | Annual report |
| 10-Q | Quarterly report |
| 8-K | Current report (material events) |
| DEF 14A | Proxy statement |
| 4 | Insider trading (change in ownership) |
| 3 | Initial insider ownership |
| 144 | Proposed sale of securities |

---

## News API

Get latest market news.

| Type | URL |
|------|-----|
| List View | `https://elite.finviz.com/news.ashx` |
| Export | `https://elite.finviz.com/news_export.ashx?v=1&auth={token}` |

### Parameters

- `v` - Version/view type

### Example Request

```
https://elite.finviz.com/news_export.ashx?v=1&auth={token}
```

### Example Response (CSV)

```csv
"Title","Source","Date","Url","Category"
"Fed Turmoil Is Threatening Dollar Supremacy...","WSJ",2026-01-17 23:00:00,"https://www.wsj.com/...",Market
"Trump threatens to sue JPMorgan Chase...","CNBC",2026-01-17 13:59:13,"https://www.cnbc.com/...",Market
"China Rare-Earth Product Exports Fall...","Bloomberg",2026-01-18 00:17:06,"https://www.bloomberg.com/...",Market
```

### News Channel IDs

| ID | Source |
|----|--------|
| 1 | MarketWatch |
| 2 | WSJ |
| 3 | Reuters |
| 4 | Yahoo Finance |
| 5 | CNN |
| 6 | The New York Times |
| 7 | Bloomberg |
| 9 | BBC |
| 10 | CNBC |
| 11 | Fox Business |
| 114 | Seeking Alpha |
| 132 | Zero Hedge |
| 141 | Abnormal Returns |
| 142 | Calculated Risk |

---

## References

Unofficial libraries and documentation:
- [mariostoev/finviz](https://github.com/mariostoev/finviz) - Python library that dynamically parses filter codes
- [knicola/finviz-screener](https://github.com/knicola/finviz-screener) - Node.js library with API docs
- [lit26/finvizfinance](https://github.com/lit26/finvizfinance) - Python library with human-readable filter names
- [ppaanngggg/finviz-proxy](https://github.com/ppaanngggg/finviz-proxy) - Has `/params` endpoint returning all filters

---

## Local Resources

HTML pages saved in `resources/finviz/`:
- `view-source_https___elite.finviz.com_screener.ashx_v=111&ft=4.html` - Screener with all filters
- `view-source_https___elite.finviz.com_quote.ashx_t=MSFT&p=d.html` - Quote page example
- `view-source_https___elite.finviz.com_quote.ashx_t=MSFT&p=d&ty=lf.html` - Latest filings example
- `view-source_https___elite.finviz.com_news.ashx.html` - News page

Cleaned text versions:
- `resources/finviz/screener_clean.txt`
- `resources/finviz/quote_clean.txt`

---

## TODO

- [ ] Document all industry codes (`ind_*`) - need to extract from screener dropdown
- [ ] Document column IDs for custom view (`c` parameter)
- [ ] Document all country/geography codes (`geo_*`)
- [ ] Test additional period options for quote export (`p` parameter)
