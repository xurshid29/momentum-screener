import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Typography, List, Tag, Tabs } from 'antd';
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

// When the screener has at most this many rows we presume the user is in
// pre-market prep mode and auto-flip to the Universe tab. The choice is
// sticky once the user manually clicks a tab.
const AUTO_UNIVERSE_THRESHOLD = 3;

interface NewsRoomPanelProps {
  payload: CyclePayload | null;
}

type TabKey = 'screener' | 'universe';

export function NewsRoomPanel({ payload }: NewsRoomPanelProps) {
  const tickers = useMemo(
    () => (payload?.rows ?? []).map((r) => r.ticker),
    [payload?.rows],
  );

  const [activeTab, setActiveTab] = useState<TabKey>('screener');
  const userPickedRef = useRef(false);

  // Auto-switch to Universe when the screener is empty/sparse, until the user
  // explicitly picks a tab.
  useEffect(() => {
    if (userPickedRef.current) return;
    setActiveTab(tickers.length <= AUTO_UNIVERSE_THRESHOLD ? 'universe' : 'screener');
  }, [tickers.length]);

  const onTabChange = (k: string) => {
    userPickedRef.current = true;
    setActiveTab(k as TabKey);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Tabs
        activeKey={activeTab}
        onChange={onTabChange}
        size="small"
        className="tabs-fill-height"
        tabBarStyle={{ padding: '0 8px', margin: 0 }}
        items={[
          {
            key: 'screener',
            label: 'Screener News',
            children: <ScreenerNewsTab payload={payload} tickers={tickers} />,
          },
          {
            key: 'universe',
            label: 'Universe News',
            children: <UniverseNewsTab payload={payload} />,
          },
        ]}
      />
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

// News for the entire trading universe (structural filter, momentum stripped).
// Refetches on every screener cycle so fresh Benzinga deltas the poller just
// persisted show up here too — even when the article ticker isn't in the
// active screener.
function UniverseNewsTab({ payload }: { payload: CyclePayload | null }) {
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['news', 'universe'],
    queryFn: () => newsApi.feed(100, undefined, { universe: true, hours: 24 }),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (payload?.fresh_news?.length) {
      qc.invalidateQueries({ queryKey: ['news', 'universe'] });
    }
  }, [payload?.cycle_id, payload?.fresh_news?.length, qc]);

  const emptyText = isLoading ? 'Loading universe news…' : 'No universe news in the last 24h';

  return (
    <NewsListPane
      headerRight={`${data?.length ?? 0} headlines · last 24h`}
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
