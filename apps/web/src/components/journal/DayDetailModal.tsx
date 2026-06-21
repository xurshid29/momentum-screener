import { Modal, Table, Typography, Tag, Space, type TableColumnsType } from 'antd';
import dayjs from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import { tradesApi } from '../../api/trades';
import type { MatchedTrade } from '../../api/types';
import { money, pnlColor } from './format';

const { Text } = Typography;

function timeOf(s: string): string {
  // s is 'YYYY-MM-DD HH:MM:SS' (ET wall clock)
  return s.slice(11, 16);
}

export function DayDetailModal({ date, onClose }: { date: string | null; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['trade-day', date],
    queryFn: () => tradesApi.day(date!),
    enabled: !!date,
  });

  const cols: TableColumnsType<MatchedTrade> = [
    { title: 'Symbol', dataIndex: 'symbol', width: 80, render: (v: string) => <Text strong>{v}</Text> },
    {
      title: 'Side', dataIndex: 'side', width: 64,
      render: (v: 'long' | 'short') => <Tag color={v === 'long' ? 'green' : 'volcano'}>{v}</Tag>,
    },
    { title: 'Qty', dataIndex: 'quantity', width: 70, align: 'right' },
    {
      title: 'Entry', key: 'entry', width: 110, align: 'right',
      render: (_, r) => (
        <span>{r.avg_entry != null ? `$${r.avg_entry}` : '—'}{' '}
          <Text type="secondary" style={{ fontSize: 11 }}>{timeOf(r.entry_at)}</Text>
        </span>
      ),
    },
    {
      title: 'Exit', key: 'exit', width: 110, align: 'right',
      render: (_, r) => (
        <span>{r.avg_exit != null ? `$${r.avg_exit}` : '—'}{' '}
          <Text type="secondary" style={{ fontSize: 11 }}>{timeOf(r.exit_at)}</Text>
        </span>
      ),
    },
    { title: 'Gross', dataIndex: 'gross_pnl', width: 90, align: 'right', render: (v: number) => <span style={{ color: pnlColor(v) }}>{money(v, true)}</span> },
    { title: 'Comm', dataIndex: 'commission', width: 80, align: 'right', render: (v: number) => <Text type="secondary">{money(v)}</Text> },
    { title: 'Net', dataIndex: 'net_pnl', width: 90, align: 'right', render: (v: number) => <span style={{ color: pnlColor(v), fontWeight: 600 }}>{money(v, true)}</span> },
  ];

  const s = q.data?.summary;

  return (
    <Modal
      title={date ? dayjs(date).format('dddd, MMM D, YYYY') : ''}
      open={!!date}
      onCancel={onClose}
      footer={null}
      width={760}
    >
      {s && (
        <Space size="large" style={{ marginBottom: 12 }}>
          <Stat label="Net P&L" value={money(s.net_pnl, true)} color={pnlColor(s.net_pnl)} />
          <Stat label="Gross" value={money(s.gross_pnl, true)} color={pnlColor(s.gross_pnl)} />
          <Stat label="Commission" value={money(s.commission)} />
          <Stat label="Trades" value={String(s.trade_count)} />
          <Stat label="Win rate" value={s.win_rate != null ? `${s.win_rate}%` : '—'} />
        </Space>
      )}
      <Table
        rowKey={(r) => `${r.symbol}-${r.exit_at}`}
        size="small"
        columns={cols}
        dataSource={q.data?.trades ?? []}
        loading={q.isLoading}
        pagination={false}
        scroll={{ y: 360 }}
      />
    </Modal>
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
