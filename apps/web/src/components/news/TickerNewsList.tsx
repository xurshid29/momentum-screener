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

// Timestamp label for a headline. The list spans several days now, so a
// bare time is ambiguous: show "HH:MM" for today, and "Mon DD · HH:MM" for
// any earlier day so a 2-day-old swing catalyst reads clearly.
function fmtNewsTs(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return time;
  const date = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return `${date} · ${time}`;
}

// Benzinga's auto-generated multi-ticker "why is it moving" blurbs carry a
// quote-page URL for ONE representative ticker (e.g. /quote/SKYQ on an
// article tagged to 20 oil names) — clicking that from another ticker's news
// list lands on the wrong symbol. In a single-ticker context, rewrite the
// quote-page URL to the ticker being viewed; real article URLs pass through.
function articleHref(url: string, ticker?: string): string {
  if (!ticker) return url;
  return url.replace(
    /^(https?:\/\/(?:www\.)?benzinga\.com\/quote\/)[^/?#]+/i,
    `$1${encodeURIComponent(ticker)}`,
  );
}

export function TickerNewsList({ news, max = 8, ticker }: { news: NewsArticle[]; max?: number; ticker?: string }) {
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
                href={articleHref(n.url, ticker)}
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
                ({fmtNewsTs(n.published_at)})
              </Text>
            )}
          </div>
        </List.Item>
      )}
    />
  );
}
