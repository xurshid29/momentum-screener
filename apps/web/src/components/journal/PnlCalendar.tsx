import { useMemo } from 'react';
import dayjs, { type Dayjs } from 'dayjs';
import type { DayAggregate } from '../../api/types';
import { moneyCompact, pnlColor, pnlTint } from './format';

interface Props {
  month: Dayjs;                       // any day within the month to render
  days: DayAggregate[];               // aggregates for that month
  mode: 'net' | 'gross';
  onDayClick: (date: string) => void;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function PnlCalendar({ month, days, mode, onDayClick }: Props) {
  const byDate = useMemo(() => {
    const m = new Map<string, DayAggregate>();
    for (const d of days) m.set(d.et_date, d);
    return m;
  }, [days]);

  // Build the grid: whole weeks (Sun→Sat) spanning the month.
  const weeks = useMemo(() => {
    const start = month.startOf('month').startOf('week');
    const end = month.endOf('month').endOf('week');
    const out: Dayjs[][] = [];
    let cur = start;
    while (cur.isBefore(end) || cur.isSame(end, 'day')) {
      const week: Dayjs[] = [];
      for (let i = 0; i < 7; i++) {
        week.push(cur);
        cur = cur.add(1, 'day');
      }
      out.push(week);
    }
    return out;
  }, [month]);

  const val = (d: DayAggregate) => (mode === 'net' ? d.net_pnl : d.gross_pnl);
  const cellH = 92;

  return (
    <div style={{ width: '100%' }}>
      {/* weekday header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr) 1.1fr', gap: 4, marginBottom: 4 }}>
        {WEEKDAYS.map((w) => (
          <div key={w} style={{ textAlign: 'right', color: '#8c8c8c', fontSize: 11, padding: '0 6px' }}>{w}</div>
        ))}
        <div style={{ textAlign: 'right', color: '#8c8c8c', fontSize: 11, padding: '0 6px' }}>Total</div>
      </div>

      {weeks.map((week, wi) => {
        let weekPnl = 0;
        let weekTrades = 0;
        for (const day of week) {
          const d = byDate.get(day.format('YYYY-MM-DD'));
          if (d && day.month() === month.month()) {
            weekPnl += val(d);
            weekTrades += d.trade_count;
          }
        }
        return (
          <div
            key={wi}
            style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr) 1.1fr', gap: 4, marginBottom: 4 }}
          >
            {week.map((day) => {
              const inMonth = day.month() === month.month();
              const key = day.format('YYYY-MM-DD');
              const d = byDate.get(key);
              const has = !!d && inMonth && d.trade_count > 0;
              const v = d ? val(d) : 0;
              return (
                <div
                  key={key}
                  onClick={has ? () => onDayClick(key) : undefined}
                  style={{
                    height: cellH,
                    border: '1px solid #303030',
                    borderRadius: 4,
                    background: has ? pnlTint(v) : '#161616',
                    opacity: inMonth ? 1 : 0.35,
                    padding: 6,
                    cursor: has ? 'pointer' : 'default',
                    display: 'flex',
                    flexDirection: 'column',
                    justifyContent: 'space-between',
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ textAlign: 'right', fontSize: 12, color: inMonth ? '#bfbfbf' : '#595959' }}>
                    {day.date()}
                  </div>
                  {has && (
                    <div style={{ textAlign: 'right', lineHeight: 1.25 }}>
                      <div style={{ color: pnlColor(v), fontSize: 15, fontWeight: 600 }}>{moneyCompact(v)}</div>
                      <div style={{ color: '#8c8c8c', fontSize: 10 }}>
                        {d!.trade_count} trade{d!.trade_count === 1 ? '' : 's'}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* weekly total */}
            <div
              style={{
                height: cellH,
                border: '1px solid #303030',
                borderRadius: 4,
                background: '#1a1a1a',
                padding: 6,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
              }}
            >
              <div style={{ textAlign: 'right', fontSize: 11, color: '#8c8c8c' }}>Week {wi + 1}</div>
              {weekTrades > 0 ? (
                <div style={{ textAlign: 'right', lineHeight: 1.25 }}>
                  <div style={{ color: pnlColor(weekPnl), fontSize: 14, fontWeight: 600 }}>{moneyCompact(weekPnl)}</div>
                  <div style={{ color: '#8c8c8c', fontSize: 10 }}>
                    {weekTrades} trade{weekTrades === 1 ? '' : 's'}
                  </div>
                </div>
              ) : (
                <div style={{ textAlign: 'right', color: '#595959', fontSize: 12 }}>—</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// dayjs() re-export so the page and calendar agree on the week model.
export { dayjs };
