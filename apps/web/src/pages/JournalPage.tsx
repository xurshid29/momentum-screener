import { useState } from 'react';
import { Button, DatePicker, Segmented, Space, Typography, Spin, Empty } from 'antd';
import { LeftOutlined, RightOutlined, ImportOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { tradesApi } from '../api/trades';
import { PnlCalendar } from '../components/journal/PnlCalendar';
import { ImportTradesModal } from '../components/journal/ImportTradesModal';
import { DayDetailModal } from '../components/journal/DayDetailModal';
import { money, pnlColor } from '../components/journal/format';

const { Title, Text } = Typography;

export function JournalPage() {
  const [month, setMonth] = useState<Dayjs>(dayjs());
  const [mode, setMode] = useState<'net' | 'gross'>('net');
  const [importOpen, setImportOpen] = useState(false);
  const [day, setDay] = useState<string | null>(null);

  const from = month.startOf('month').format('YYYY-MM-DD');
  const to = month.endOf('month').format('YYYY-MM-DD');

  const calQ = useQuery({
    queryKey: ['trade-calendar', from, to],
    queryFn: () => tradesApi.calendar(from, to),
    staleTime: 60_000,
  });

  const summary = calQ.data?.summary;
  const monthlyPnl = summary ? (mode === 'net' ? summary.net_pnl : summary.gross_pnl) : 0;
  const empty = !calQ.isLoading && summary != null && summary.trade_count === 0;

  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16, background: '#0a0a0a' }}>
      {/* header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <Space size="middle" align="center">
          <Title level={4} style={{ margin: 0 }}>Trade Journal</Title>
          <Space.Compact>
            <Button icon={<LeftOutlined />} onClick={() => setMonth((m) => m.subtract(1, 'month'))} />
            <DatePicker
              picker="month"
              value={month}
              allowClear={false}
              format="MMMM YYYY"
              onChange={(v) => v && setMonth(v)}
              style={{ width: 160 }}
            />
            <Button icon={<RightOutlined />} onClick={() => setMonth((m) => m.add(1, 'month'))} />
          </Space.Compact>
          <Button size="small" onClick={() => setMonth(dayjs())}>Today</Button>
        </Space>

        <Space size="large" align="center">
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: '#8c8c8c' }}>Monthly P&L ({mode})</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: pnlColor(monthlyPnl) }}>
              {money(monthlyPnl, true)}
            </div>
          </div>
          <Segmented
            value={mode}
            onChange={(v) => setMode(v as 'net' | 'gross')}
            options={[{ label: 'Net', value: 'net' }, { label: 'Gross', value: 'gross' }]}
          />
          <Button type="primary" icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>
            Import Trades
          </Button>
        </Space>
      </div>

      {/* month summary strip */}
      {summary && summary.trade_count > 0 && (
        <Space size="large" style={{ marginBottom: 16 }}>
          <Stat label="Trades" value={String(summary.trade_count)} />
          <Stat label="Win rate" value={summary.win_rate != null ? `${summary.win_rate}%` : '—'} />
          <Stat label="Winners / Losers" value={`${summary.win_count} / ${summary.loss_count}`} />
          <Stat label="Commission" value={money(summary.commission)} />
          {mode === 'net' ? (
            <Stat label="Gross" value={money(summary.gross_pnl, true)} color={pnlColor(summary.gross_pnl)} />
          ) : (
            <Stat label="Net" value={money(summary.net_pnl, true)} color={pnlColor(summary.net_pnl)} />
          )}
        </Space>
      )}

      {calQ.isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 64 }}><Spin /></div>
      ) : empty ? (
        <Empty
          style={{ padding: 48 }}
          description={
            <span>
              No trades for {month.format('MMMM YYYY')}.{' '}
              <Text type="secondary">Import an IBKR TradeLog (.tlg) to populate the calendar.</Text>
            </span>
          }
        >
          <Button type="primary" icon={<ImportOutlined />} onClick={() => setImportOpen(true)}>Import Trades</Button>
        </Empty>
      ) : (
        <PnlCalendar month={month} days={calQ.data?.days ?? []} mode={mode} onDayClick={setDay} />
      )}

      <ImportTradesModal open={importOpen} onClose={() => setImportOpen(false)} />
      <DayDetailModal date={day} onClose={() => setDay(null)} />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#8c8c8c' }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: color ?? '#e0e0e0' }}>{value}</div>
    </div>
  );
}
