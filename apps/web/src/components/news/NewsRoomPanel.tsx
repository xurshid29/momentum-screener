import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Typography, List, Tag } from 'antd';
import { newsApi } from '../../api/news';
import { useSelection } from '../../context/SelectionContext';
import type { CyclePayload } from '../../api/types';

const { Text } = Typography;

const SOURCE_COLOR: Record<string, string> = {
  benzinga: 'gold',
  yahoo: 'purple',
  finviz: 'blue',
};

interface NewsRoomPanelProps {
  payload: CyclePayload | null;
}

// News feed scoped to tickers currently in the screener. The ticker set is
// derived from the live payload; a stable sorted-and-joined string drives the
// query key so a refetch only happens when the set actually changes (not on
// every cycle when the same tickers are still in view).
export function NewsRoomPanel({ payload }: NewsRoomPanelProps) {
  const { setSelected } = useSelection();
  const qc = useQueryClient();

  const tickers = useMemo(
    () => (payload?.rows ?? []).map((r) => r.ticker),
    [payload?.rows],
  );
  const tickersKey = useMemo(() => [...tickers].sort().join(','), [tickers]);

  const { data } = useQuery({
    queryKey: ['news', 'feed', tickersKey],
    queryFn: () => newsApi.feed(50, tickers),
    enabled: tickers.length > 0,
    refetchInterval: 60_000,
  });

  // Whenever the SSE stream brings fresh news, invalidate the current key so
  // we refetch with the same ticker set.
  useEffect(() => {
    if (payload?.fresh_news?.length) {
      qc.invalidateQueries({ queryKey: ['news', 'feed', tickersKey] });
    }
  }, [payload?.cycle_id, payload?.fresh_news?.length, qc, tickersKey]);

  const emptyText = tickers.length === 0 ? 'Screener has no tickers yet' : 'No news for current tickers';

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '6px 8px', borderBottom: '1px solid #303030', display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text strong style={{ color: '#e0e0e0' }}>News Room</Text>
        <Text type="secondary" style={{ fontSize: 11 }}>
          {tickers.length > 0 ? `${tickers.length} tickers · ${data?.length ?? 0} headlines` : 'idle'}
        </Text>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: 8 }}>
        <List
          size="small"
          dataSource={data ?? []}
          locale={{ emptyText }}
          renderItem={(n) => (
            <List.Item style={{ padding: '6px 0', borderBottom: '1px solid #2a2a2a' }}>
              <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div>
                    {n.ticker && (
                      <a
                        onClick={(e) => {
                          e.preventDefault();
                          if (n.ticker) setSelected(n.ticker);
                        }}
                        style={{ color: '#1890ff', fontWeight: 600, marginRight: 6, cursor: 'pointer' }}
                      >
                        {n.ticker}
                      </a>
                    )}
                    <a href={n.url} target="_blank" rel="noopener noreferrer" style={{ color: '#e6e6e6', fontSize: 13 }}>
                      {n.title}
                    </a>
                  </div>
                  <Tag color={SOURCE_COLOR[n.source]} style={{ margin: 0, flex: '0 0 auto' }}>{n.source}</Tag>
                </div>
                {n.published_at && (
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    {new Date(n.published_at).toLocaleString()}
                  </Text>
                )}
              </div>
            </List.Item>
          )}
        />
      </div>
    </div>
  );
}
