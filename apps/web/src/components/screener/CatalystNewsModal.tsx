// Modal popped from a screener row's fire / catalyst badge — shows that
// ticker's catalyst verdict and its news articles without leaving the screener.

import { Modal, Spin, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { newsApi } from '../../api/news';
import { FireBadge } from '../common/FireBadge';
import { TickerNewsList } from '../news/TickerNewsList';
import type { CatalystDirection, CatalystInfo, NewsArticle } from '../../api/types';

const { Text } = Typography;

const DIR_COLOR: Record<CatalystDirection, string | undefined> = {
  bullish: 'green',
  bearish: 'red',
  mixed: 'gold',
  neutral: undefined,
};

interface Props {
  ticker: string | null;
  catalyst: CatalystInfo | null;
  onClose: () => void;
}

export function CatalystNewsModal({ ticker, catalyst, onClose }: Props) {
  // Same query key as the Quote Details panel — opening the modal for the
  // selected ticker is an instant cache hit.
  const { data: news, isLoading } = useQuery({
    queryKey: ['news', ticker],
    queryFn: () => (ticker ? newsApi.forTicker(ticker, 30) : Promise.resolve([] as NewsArticle[])),
    enabled: !!ticker,
    staleTime: 10_000,
  });

  return (
    <Modal
      open={ticker != null}
      onCancel={onClose}
      footer={null}
      width={560}
      title={
        ticker && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {catalyst != null && catalyst.score >= 15 && <FireBadge score={catalyst.score} size={16} />}
            <Text strong style={{ fontSize: 16 }}>{ticker}</Text>
            <Text type="secondary" style={{ fontSize: 13, fontWeight: 400 }}>catalyst &amp; news</Text>
          </span>
        )
      }
    >
      {catalyst && (
        <div style={{ marginBottom: 12, padding: '8px 10px', background: '#1f1f1f', borderRadius: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Text strong style={{ fontSize: 13 }}>Score {catalyst.score}</Text>
            {catalyst.type && <Tag style={{ margin: 0 }}>{catalyst.type}</Tag>}
            <Tag color={DIR_COLOR[catalyst.direction]} style={{ margin: 0 }}>{catalyst.direction}</Tag>
            <Text type="secondary" style={{ fontSize: 12 }}>{catalyst.urgency}</Text>
          </div>
          {catalyst.reason && (
            <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 4 }}>
              {catalyst.reason}
            </Text>
          )}
          {catalyst.risk_flags.length > 0 && (
            <div style={{ marginTop: 6, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {catalyst.risk_flags.map((f) => (
                <Tag key={f} color="warning" style={{ margin: 0, fontSize: 10 }}>{f}</Tag>
              ))}
            </div>
          )}
        </div>
      )}
      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 24 }}>
          <Spin />
        </div>
      ) : (
        <TickerNewsList news={news ?? []} max={20} />
      )}
    </Modal>
  );
}
