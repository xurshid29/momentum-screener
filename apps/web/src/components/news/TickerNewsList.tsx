// Per-ticker news list — the deduped article feed for one ticker with the
// inline catalyst-analyze control. Shared by the Quote Details panel and the
// screener's catalyst modal so both render news identically.

import { List, Tag, Typography } from 'antd';
import { CatalystAnalyzeButton } from './CatalystAnalyzeButton';
import type { NewsArticle } from '../../api/types';

const { Text } = Typography;

const SOURCE_COLOR: Record<string, string> = {
  benzinga: 'gold',
  yahoo: 'purple',
  finviz: 'blue',
  sec: 'geekblue',
  halt: 'red',
};

export function TickerNewsList({ news, max = 8 }: { news: NewsArticle[]; max?: number }) {
  if (news.length === 0) {
    return (
      <Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
        No news yet
      </Text>
    );
  }
  return (
    <List
      size="small"
      dataSource={news.slice(0, max)}
      renderItem={(n) => (
        <List.Item style={{ padding: '6px 0', borderBottom: '1px solid #2a2a2a' }}>
          <div style={{ width: '100%' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <span style={{ flex: '0 0 auto' }}>
                <CatalystAnalyzeButton articleId={n.id} initial={n.classification} />
              </span>
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: '#e6e6e6', fontSize: 13, flex: '1 1 auto' }}
              >
                {n.title}
              </a>
              <Tag color={SOURCE_COLOR[n.source]} style={{ margin: 0, flex: '0 0 auto', fontSize: 10 }}>
                {n.source}
              </Tag>
            </div>
            {n.published_at && (
              <Text type="secondary" style={{ fontSize: 11, marginLeft: 22 }}>
                ({new Date(n.published_at).toLocaleTimeString([], { hour12: false })})
              </Text>
            )}
          </div>
        </List.Item>
      )}
    />
  );
}
