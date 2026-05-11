import { useState } from 'react';
import { Popover, Spin, Tag, Typography } from 'antd';
import { newsApi } from '../../api/news';
import type { NewsClassification } from '../../api/types';

const { Text } = Typography;

interface Props {
  articleId: string;
  initial: NewsClassification | null;
  size?: number;       // px font-size for the icon
}

// Per-row catalyst analysis button. Three visual states:
//   • 🤖 grey  — no classification yet, click triggers a POST
//   • tiered  — already classified, click shows cached result
//   • spinner — POST in flight
// Idempotent on the server: re-clicking a classified article returns the
// cached row without spending a new OpenAI call.
export function CatalystAnalyzeButton({ articleId, initial, size = 14 }: Props) {
  const [data, setData] = useState<NewsClassification | null>(initial);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) return;
    if (data) return; // already have a classification — popover renders it
    setLoading(true);
    setError(null);
    try {
      const result = await newsApi.classify(articleId);
      // ClassifyArticleResponse is a superset of NewsClassification (has `cached`).
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'classification failed');
    } finally {
      setLoading(false);
    }
  }

  const icon = data ? tierIcon(data.impact_score) : '🤖';
  const opacity = data ? 1 : 0.55;

  return (
    <Popover
      open={open}
      onOpenChange={handleOpenChange}
      trigger="click"
      placement="left"
      content={
        loading ? (
          <Spin size="small" />
        ) : error ? (
          <Text type="danger" style={{ fontSize: 12 }}>{error}</Text>
        ) : data ? (
          <CatalystContent c={data} />
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>Click to analyze</Text>
        )
      }
    >
      <button
        type="button"
        title={data ? `Catalyst: ${data.impact_score}` : 'Analyze with AI'}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          margin: 0,
          font: 'inherit',
          color: 'inherit',
          opacity,
          fontSize: size,
          lineHeight: 1,
        }}
      >
        {loading ? <Spin size="small" /> : icon}
      </button>
    </Popover>
  );
}

function tierIcon(score: number): string {
  if (score >= 70) return '🔥';
  if (score >= 40) return '⚡';
  if (score >= 15) return '🧊';
  return '·';
}

function tierColor(score: number): string {
  if (score >= 70) return 'volcano';
  if (score >= 40) return 'gold';
  if (score >= 15) return 'blue';
  return 'default';
}

function urgencyColor(u: NewsClassification['urgency']): string {
  switch (u) {
    case 'major': return 'red';
    case 'strong': return 'volcano';
    case 'watch': return 'gold';
    default: return 'default';
  }
}

function CatalystContent({ c }: { c: NewsClassification }) {
  return (
    <div style={{ maxWidth: 280, fontSize: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 16 }}>{tierIcon(c.impact_score)}</span>
        <Tag color={tierColor(c.impact_score)} style={{ margin: 0, fontWeight: 600 }}>
          {c.impact_score}
        </Tag>
        <Tag color={urgencyColor(c.urgency)} style={{ margin: 0 }}>{c.urgency.toUpperCase()}</Tag>
        <Tag style={{ margin: 0 }}>{c.catalyst_type}</Tag>
      </div>
      <div style={{ color: '#bfbfbf', marginBottom: 4 }}>
        {c.direction} · confidence {c.confidence.toFixed(2)}
      </div>
      {c.reason && (
        <div style={{ color: '#e0e0e0', marginBottom: 6, whiteSpace: 'pre-wrap' }}>{c.reason}</div>
      )}
      {c.risk_flags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 6 }}>
          {c.risk_flags.map((f) => (
            <Tag key={f} color="warning" style={{ margin: 0, fontSize: 10 }}>{f}</Tag>
          ))}
        </div>
      )}
      <div style={{ color: '#888', fontSize: 10 }}>
        classifier: {c.classifier}
      </div>
    </div>
  );
}
