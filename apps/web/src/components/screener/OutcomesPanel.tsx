// Outcomes / backtest view — the interactive read of screener_outcomes.
//
// Pick a Group-by (catalyst direction / urgency / shelf / score bucket / entry
// extension / screen), a Horizon (1/3/5 trading days), and a Screen filter →
// see per-bucket N, avg change, avg peak (best case), avg drawdown (worst
// case), and win-rate. This is the "did the score/catalyst/shelf predict the
// move?" question turned into a UI (the psql breakdowns from the roadmap).
//
// IMPORTANT (by design): N is shown prominently and thin buckets are dimmed +
// a coverage banner warns while go-forward depth is shallow — early numbers are
// a direction check, not a verdict. Static query; refetches on control change.

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Table, Typography, Segmented, Select, Empty, Spin, Alert, Tooltip } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { screenerApi } from '../../api/screener';
import type {
  OutcomeSummaryBucket,
  OutcomesGroupBy,
  OutcomesHorizon,
  OutcomesScreen,
} from '../../api/types';

const { Text } = Typography;

// Below this N a bucket is statistically untrustworthy — dim it + tooltip.
const THIN_N = 10;
// Below this much horizon-ready coverage, show the "early data" banner.
const SHALLOW_READY = 200;

const GROUP_BY_OPTIONS: { value: OutcomesGroupBy; label: string }[] = [
  { value: 'catalyst_direction', label: 'Catalyst dir' },
  { value: 'catalyst_urgency', label: 'Catalyst urgency' },
  { value: 'shelf_level', label: 'Shelf' },
  { value: 'score_bucket', label: 'Score' },
  { value: 'extension_bucket', label: 'Entry ext.' },
  { value: 'screen', label: 'Screen' },
];

// Green for gains, red for losses; dimmed when null.
function pctColor(v: number | null): string {
  if (v == null) return '#8c8c8c';
  return v >= 0 ? '#52c41a' : '#ff4d4f';
}

function fmtSignedPct(v: number | null): string {
  if (v == null) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`;
}

export function OutcomesPanel() {
  const [groupBy, setGroupBy] = useState<OutcomesGroupBy>('catalyst_direction');
  const [horizon, setHorizon] = useState<OutcomesHorizon>(5);
  const [screen, setScreen] = useState<OutcomesScreen>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['outcomes-summary', groupBy, horizon, screen],
    queryFn: () => screenerApi.outcomesSummary(groupBy, horizon, screen),
    staleTime: 60_000,
  });

  const columns: ColumnsType<OutcomeSummaryBucket> = useMemo(
    () => [
      {
        title: GROUP_BY_OPTIONS.find((g) => g.value === groupBy)?.label ?? 'Bucket',
        dataIndex: 'bucket',
        key: 'bucket',
        render: (b: string, row) => (
          <span style={{ fontWeight: 600, color: row.n < THIN_N ? '#8c8c8c' : '#e0e0e0' }}>{b}</span>
        ),
      },
      {
        title: 'N',
        dataIndex: 'n',
        key: 'n',
        width: 70,
        align: 'right',
        sorter: (a, b) => a.n - b.n,
        render: (n: number) =>
          n < THIN_N ? (
            <Tooltip title={`Only ${n} samples — too thin to trust yet`}>
              <span style={{ color: '#faad14', fontWeight: 600 }}>{n} ⚠</span>
            </Tooltip>
          ) : (
            <span style={{ color: '#e0e0e0', fontWeight: 600 }}>{n}</span>
          ),
      },
      {
        title: `Avg ${horizon}d`,
        dataIndex: 'avg_chg',
        key: 'avg_chg',
        width: 90,
        align: 'right',
        defaultSortOrder: 'descend',
        sorter: (a, b) => (a.avg_chg ?? -Infinity) - (b.avg_chg ?? -Infinity),
        render: (v: number | null, row) => (
          <span style={{ color: pctColor(v), fontWeight: 700, opacity: row.n < THIN_N ? 0.5 : 1 }}>
            {fmtSignedPct(v)}
          </span>
        ),
      },
      {
        title: 'Avg peak',
        dataIndex: 'avg_peak',
        key: 'avg_peak',
        width: 90,
        align: 'right',
        sorter: (a, b) => (a.avg_peak ?? -Infinity) - (b.avg_peak ?? -Infinity),
        render: (v: number | null, row) => (
          <Tooltip title="Best case: avg peak over the 5 days after entry">
            <span style={{ color: '#73d13d', opacity: row.n < THIN_N ? 0.5 : 1 }}>{fmtSignedPct(v)}</span>
          </Tooltip>
        ),
      },
      {
        title: 'Avg DD',
        dataIndex: 'avg_drawdown',
        key: 'avg_drawdown',
        width: 90,
        align: 'right',
        sorter: (a, b) => (a.avg_drawdown ?? Infinity) - (b.avg_drawdown ?? Infinity),
        render: (v: number | null, row) => (
          <Tooltip title="Worst case: avg drawdown over the 5 days after entry">
            <span style={{ color: '#ff7875', opacity: row.n < THIN_N ? 0.5 : 1 }}>{fmtSignedPct(v)}</span>
          </Tooltip>
        ),
      },
      {
        title: 'Win %',
        dataIndex: 'win_rate',
        key: 'win_rate',
        width: 80,
        align: 'right',
        sorter: (a, b) => (a.win_rate ?? -1) - (b.win_rate ?? -1),
        render: (v: number | null, row) => (
          <Tooltip title={`% of bucket with a positive ${horizon}-day close`}>
            <span
              style={{
                color: v == null ? '#8c8c8c' : v >= 50 ? '#52c41a' : '#faad14',
                opacity: row.n < THIN_N ? 0.5 : 1,
              }}
            >
              {v == null ? '—' : `${v.toFixed(0)}%`}
            </span>
          </Tooltip>
        ),
      },
    ],
    [groupBy, horizon],
  );

  const coverage = data?.coverage;
  const shallow = coverage != null && coverage.ready < SHALLOW_READY;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      {/* Controls */}
      <div style={{ padding: '8px 10px', borderBottom: '1px solid #303030', display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>Group by</Text>
          <Select
            size="small"
            value={groupBy}
            onChange={setGroupBy}
            options={GROUP_BY_OPTIONS}
            style={{ width: 140 }}
          />
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>Horizon</Text>
          <Segmented
            size="small"
            value={String(horizon)}
            onChange={(v) => setHorizon(Number(v) as OutcomesHorizon)}
            options={[
              { label: '1d', value: '1' },
              { label: '3d', value: '3' },
              { label: '5d', value: '5' },
            ]}
          />
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Text type="secondary" style={{ fontSize: 11 }}>Screen</Text>
          <Segmented
            size="small"
            value={screen}
            onChange={(v) => setScreen(v as OutcomesScreen)}
            options={[
              { label: 'All', value: 'all' },
              { label: 'Mom', value: 'momentum' },
              { label: 'Ign', value: 'ignition' },
              { label: 'Swing', value: 'swing' },
            ]}
          />
        </span>
        {coverage && (
          <Text type="secondary" style={{ fontSize: 11, marginLeft: 'auto' }}>
            {coverage.ready} / {coverage.total} ready ({horizon}d)
          </Text>
        )}
      </div>

      {shallow && (
        <Alert
          type="warning"
          showIcon
          banner
          message={
            <Text style={{ fontSize: 11 }}>
              Early data — only {coverage?.ready ?? 0} rows have a full {horizon}-day horizon. Treat these as a
              direction check, not a verdict; samples are small and overlap across screens. Let ~2 weeks of
              go-forward data accrue before retuning.
            </Text>
          }
          style={{ padding: '4px 10px' }}
        />
      )}

      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
        {isLoading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spin /></div>
        ) : !data || data.buckets.length === 0 ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={
                <Text type="secondary" style={{ fontSize: 12, maxWidth: 340, display: 'inline-block' }}>
                  No outcome data for this horizon yet. Rows need {horizon} forward trading days of daily bars
                  before they appear; the job fills them in over the days after each detection.
                </Text>
              }
            />
          </div>
        ) : (
          <Table<OutcomeSummaryBucket>
            rowKey="bucket"
            size="small"
            columns={columns}
            dataSource={data.buckets}
            pagination={false}
            sticky
          />
        )}
      </div>
    </div>
  );
}
