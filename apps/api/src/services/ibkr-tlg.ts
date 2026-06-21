// IBKR TradeLog (.tlg) parser + round-trip trade matcher.
//
// The .tlg is a pipe-delimited statement. We care about STK_TRD lines (one per
// stock fill) and the ACT_INF header (account id/name). Each STK_TRD:
//
//   STK_TRD | execId | symbol | name | venue | ACTION | O/C | YYYYMMDD | HH:MM:SS
//          | ccy | qty(signed) | mult | price | amount(qty×price) | commission | …
//
// P&L convention (validated against Tradervue on a real statement):
//   gross = −Σ amount   (buy amount is +notional, sell is −notional)
//   net   = gross + Σ commission   (commission is stored ≤ 0, a cost)
//
// A "trade" is a flat-to-flat round trip in one symbol: it opens when the
// position leaves 0 and closes when it returns to 0. P&L and the trade itself
// are attributed to the EXIT date (the fill that flattens the position) — this
// reproduces Tradervue's calendar exactly, including overnight holds.

export interface ParsedExecution {
  exec_id: string;
  symbol: string;
  description: string | null;
  venue: string | null;
  side: 'buy' | 'sell';
  open_close: string | null;     // 'O' | 'C'
  action_raw: string | null;
  quantity: number;              // signed: + buy, − sell
  multiplier: number;
  price: number;
  amount: number;                // quantity × price, signed
  commission: number;            // ≤ 0
  currency: string;
  executed_at: string;           // 'YYYY-MM-DD HH:MM:SS' (ET wall clock)
  et_date: string;               // 'YYYY-MM-DD' (ET trading date)
}

export interface ParsedTlg {
  account: string | null;
  account_name: string | null;
  period_start: string | null;   // 'YYYY-MM-DD' (min et_date)
  period_end: string | null;     // 'YYYY-MM-DD' (max et_date)
  executions: ParsedExecution[];
  skipped: number;               // non-STK_TRD / unparseable trade-ish lines
}

export interface MatchedTrade {
  symbol: string;
  side: 'long' | 'short';
  quantity: number;              // total shares on the opening side (size)
  entry_at: string;              // first leg time
  exit_at: string;               // last (flattening) leg time
  et_date: string;               // ET date of the exit — the attribution day
  avg_entry: number | null;
  avg_exit: number | null;
  gross_pnl: number;
  commission: number;            // ≤ 0
  net_pnl: number;
  fills: number;                 // # of executions in the round trip
  is_open: boolean;              // true if still open at end of data (no exit)
}

export interface DayAggregate {
  et_date: string;
  gross_pnl: number;
  net_pnl: number;
  commission: number;
  trade_count: number;
  win_count: number;             // net_pnl > 0
  loss_count: number;            // net_pnl < 0
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// 'YYYYMMDD' → 'YYYY-MM-DD'
function isoDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** Parse a .tlg file's text into account info + the list of stock fills. */
export function parseTlg(content: string): ParsedTlg {
  const lines = content.split(/\r?\n/);
  let account: string | null = null;
  let account_name: string | null = null;
  const executions: ParsedExecution[] = [];
  let skipped = 0;

  for (const line of lines) {
    if (!line) continue;
    const f = line.split('|');
    const rec = f[0];

    if (rec === 'ACT_INF') {
      account = f[1] ?? null;
      account_name = f[2] ?? null;
      continue;
    }
    if (rec !== 'STK_TRD') continue;

    // Defensive: a malformed trade line shouldn't abort the whole import.
    const date = f[7];
    const time = f[8] ?? '00:00:00';
    const qty = Number(f[10]);
    const price = Number(f[12]);
    const amount = Number(f[13]);
    if (!f[1] || !f[2] || !date || !Number.isFinite(qty) || !Number.isFinite(price)) {
      skipped++;
      continue;
    }
    const action = (f[5] ?? '').toUpperCase();
    const side: 'buy' | 'sell' = action.startsWith('BUY') ? 'buy' : action.startsWith('SELL') ? 'sell' : qty >= 0 ? 'buy' : 'sell';

    executions.push({
      exec_id: f[1],
      symbol: f[2].toUpperCase(),
      description: f[3] || null,
      venue: f[4] || null,
      side,
      open_close: f[6] || null,
      action_raw: f[5] || null,
      quantity: qty,
      multiplier: Number(f[11]) || 1,
      price,
      amount: Number.isFinite(amount) ? amount : r2(qty * price),
      commission: Number(f[14]) || 0,
      currency: f[9] || 'USD',
      executed_at: `${isoDate(date)} ${time}`,
      et_date: isoDate(date),
    });
  }

  const dates = executions.map((e) => e.et_date).sort();
  return {
    account,
    account_name,
    period_start: dates[0] ?? null,
    period_end: dates[dates.length - 1] ?? null,
    executions,
    skipped,
  };
}

/**
 * Fold executions into flat-to-flat round trips per symbol. Pass the FULL set of
 * a user's executions (not a date-filtered slice) so an overnight trade that
 * opened before a window still matches; filter the resulting trades by exit date
 * afterwards. Order-independent on input (sorts internally).
 */
export function matchTrades(executions: ParsedExecution[]): MatchedTrade[] {
  const bySymbol = new Map<string, ParsedExecution[]>();
  for (const e of executions) {
    const arr = bySymbol.get(e.symbol);
    if (arr) arr.push(e);
    else bySymbol.set(e.symbol, [e]);
  }

  const trades: MatchedTrade[] = [];
  const EPS = 1e-6;

  for (const [symbol, legs] of bySymbol) {
    legs.sort((a, b) => (a.executed_at < b.executed_at ? -1 : a.executed_at > b.executed_at ? 1 : 0));

    let position = 0;
    let openSide: 'long' | 'short' = 'long';
    let group: ParsedExecution[] = [];

    const flush = (isOpen: boolean) => {
      if (group.length === 0) return;
      let gross = 0;
      let commission = 0;
      let openQty = 0;
      let openNotional = 0;
      let closeQty = 0;
      let closeNotional = 0;
      for (const g of group) {
        gross += -g.amount;
        commission += g.commission;
        const opens = openSide === 'long' ? g.quantity > 0 : g.quantity < 0;
        if (opens) {
          openQty += Math.abs(g.quantity);
          openNotional += Math.abs(g.amount);
        } else {
          closeQty += Math.abs(g.quantity);
          closeNotional += Math.abs(g.amount);
        }
      }
      trades.push({
        symbol,
        side: openSide,
        quantity: r2(openQty),
        entry_at: group[0].executed_at,
        exit_at: group[group.length - 1].executed_at,
        et_date: group[group.length - 1].et_date,
        avg_entry: openQty > EPS ? r2(openNotional / openQty) : null,
        avg_exit: closeQty > EPS ? r2(closeNotional / closeQty) : null,
        gross_pnl: r2(gross),
        commission: r2(commission),
        net_pnl: r2(gross + commission),
        fills: group.length,
        is_open: isOpen,
      });
      group = [];
    };

    for (const e of legs) {
      if (Math.abs(position) < EPS) {
        // Opening a fresh round trip — its direction is set by the first leg.
        openSide = e.quantity >= 0 ? 'long' : 'short';
      }
      group.push(e);
      position += e.quantity;
      if (Math.abs(position) < EPS) flush(false); // back to flat → trade closed
    }
    if (Math.abs(position) >= EPS) flush(true);    // leftover open position
  }

  trades.sort((a, b) => (a.exit_at < b.exit_at ? -1 : a.exit_at > b.exit_at ? 1 : 0));
  return trades;
}

/** Roll matched trades up to per-ET-day totals (the calendar cells). Open trades
 *  carry no realized P&L and are excluded. */
export function aggregateByDay(trades: MatchedTrade[]): DayAggregate[] {
  const byDay = new Map<string, DayAggregate>();
  for (const t of trades) {
    if (t.is_open) continue;
    let d = byDay.get(t.et_date);
    if (!d) {
      d = { et_date: t.et_date, gross_pnl: 0, net_pnl: 0, commission: 0, trade_count: 0, win_count: 0, loss_count: 0 };
      byDay.set(t.et_date, d);
    }
    d.gross_pnl = r2(d.gross_pnl + t.gross_pnl);
    d.net_pnl = r2(d.net_pnl + t.net_pnl);
    d.commission = r2(d.commission + t.commission);
    d.trade_count++;
    if (t.net_pnl > 0) d.win_count++;
    else if (t.net_pnl < 0) d.loss_count++;
  }
  return Array.from(byDay.values()).sort((a, b) => (a.et_date < b.et_date ? -1 : 1));
}
