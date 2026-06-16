import { useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Typography, List, Tag } from 'antd';
import { newsApi } from '../../api/news';
import { useSelection } from '../../context/SelectionContext';
import { CatalystAnalyzeButton } from './CatalystAnalyzeButton';
import { TickerLink } from '../common/TickerLink';
import type { CyclePayload, NewsArticle } from '../../api/types';

const { Text } = Typography;

const SOURCE_COLOR: Record<string, string> = {
  benzinga: 'gold',
  yahoo: 'purple',
  finviz: 'blue',
  sec: 'geekblue',
  halt: 'red',
};

interface NewsRoomPanelProps {
  payload: CyclePayload | null;
}

export function NewsRoomPanel({ payload }: NewsRoomPanelProps) {
  const tickers = useMemo(
    () => (payload?.rows ?? []).map((r) => r.ticker),
    [payload?.rows],
  );

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <ScreenerNewsTab payload={payload} tickers={tickers} />
    </div>
  );
}

// News scoped to tickers currently in the screener. The ticker set drives the
// query key so we only refetch when the set actually changes (not on every
// cycle when the same tickers are still in view). Fresh-news SSE deltas force
// a refetch via cache invalidation.
function ScreenerNewsTab({ payload, tickers }: { payload: CyclePayload | null; tickers: string[] }) {
  const qc = useQueryClient();
  const tickersKey = useMemo(() => [...tickers].sort().join(','), [tickers]);

  const { data } = useQuery({
    queryKey: ['news', 'feed', tickersKey],
    queryFn: () => newsApi.feed(50, tickers),
    enabled: tickers.length > 0,
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (payload?.fresh_news?.length) {
      qc.invalidateQueries({ queryKey: ['news', 'feed', tickersKey] });
    }
  }, [payload?.cycle_id, payload?.fresh_news?.length, qc, tickersKey]);

  const emptyText = tickers.length === 0 ? 'Screener has no tickers yet' : 'No news for current tickers';

  return (
    <NewsListPane
      headerRight={`${tickers.length} tickers · ${data?.length ?? 0} headlines`}
      items={data ?? []}
      emptyText={emptyText}
    />
  );
}

interface NewsListPaneProps {
  items: NewsArticle[];
  headerRight: string;
  emptyText: string;
}

function NewsListPane({ items, headerRight, emptyText }: NewsListPaneProps) {
  const { setSelected } = useSelection();
  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <div style={{ padding: '4px 8px', borderBottom: '1px solid #303030', display: 'flex', justifyContent: 'flex-end' }}>
        <Text type="secondary" style={{ fontSize: 11 }}>{headerRight}</Text>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: 8 }}>
        <List
          size="small"
          dataSource={items}
          locale={{ emptyText }}
          renderItem={(n) => (
            <List.Item style={{ padding: '6px 0', borderBottom: '1px solid #2a2a2a' }}>
              <div style={{ width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap' }}>
                    <CatalystAnalyzeButton articleId={n.id} initial={n.classification} />
                    {n.tickers.slice(0, 6).map((t) => (
                      <TickerLink
                        key={t}
                        ticker={t}
                        onSelect={setSelected}
                        style={{ color: '#1890ff', fontWeight: 600 }}
                      />
                    ))}
                    {n.tickers.length > 6 && (
                      <Text type="secondary" style={{ fontSize: 11 }}>+{n.tickers.length - 6}</Text>
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
