import { useState } from 'react';
import { Typography, Button, Empty, Tooltip, Popover, DatePicker } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useSelection } from '../../context/SelectionContext';
import { useWatchlist } from '../../hooks/useWatchlist';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import { WatchlistStar } from '../common/WatchlistStar';
import { CatalystBadge } from '../common/CatalystBadge';
import { CatalystNewsModal } from './CatalystNewsModal';
import type { CatalystInfo } from '../../api/types';
import type { WatchlistEntry } from '../../api/prefs';

const { Text } = Typography;

// Always-visible watchlist / favorites with an expiration date. Tickers are
// captured with a one-click ★ from any row surface (no form here). Each entry
// shows its most recent catalyst, a 🆕 dot when news landed after you added /
// last viewed it, and an editable expiry; clicking a row drives the shared
// selection (charts + Quote panel). Expired entries auto-remove server-side.
// Sits under the Ignition sidebar in the left rail.
export function WatchlistPanel() {
  const { selected, setSelected } = useSelection();
  const { entries, remove, setExpiry, markSeen } = useWatchlist();
  const [catalystModal, setCatalystModal] = useState<{ ticker: string; catalyst: CatalystInfo | null } | null>(null);

  const openNews = (e: WatchlistEntry) => {
    setCatalystModal({ ticker: e.ticker, catalyst: toCatalyst(e) });
    // Opening the news clears the "new news" dot for this entry.
    if (e.has_new_news) markSeen(e.ticker);
  };

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <CatalystNewsModal
        ticker={catalystModal?.ticker ?? null}
        catalyst={catalystModal?.catalyst ?? null}
        onClose={() => setCatalystModal(null)}
      />
      <div
        style={{
          padding: '6px 8px',
          borderBottom: '1px solid #303030',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>
          <Text strong style={{ color: '#e0e0e0', letterSpacing: 0.5, fontSize: 15 }}>★ Watchlist</Text>
          <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>{entries.length}</Text>
        </span>
      </div>

      {entries.length === 0 ? (
        <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text type="secondary" style={{ fontSize: 12 }}>
                Nothing watched. Click the ★ on any ticker to add it.
              </Text>
            }
          />
        </div>
      ) : (
        <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
          {entries.map((e) => (
            <WatchlistItem
              key={e.ticker}
              entry={e}
              selected={e.ticker === selected}
              onSelect={setSelected}
              onRemove={remove}
              onSetExpiry={(expires_at) => setExpiry({ ticker: e.ticker, expires_at })}
              onOpenNews={() => openNews(e)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Build a CatalystInfo-shaped object from the entry's news fields so the shared
// CatalystNewsModal renders the verdict block. Null when nothing's classified.
function toCatalyst(e: WatchlistEntry): CatalystInfo | null {
  if (e.catalyst_score == null || !e.catalyst_direction || !e.catalyst_urgency || !e.catalyst_type) {
    return null;
  }
  return {
    score: e.catalyst_score,
    direction: e.catalyst_direction as CatalystInfo['direction'],
    urgency: e.catalyst_urgency as CatalystInfo['urgency'],
    type: e.catalyst_type,
    reason: e.catalyst_reason ?? '',
    risk_flags: [],
    classifier: 'rules',
  };
}

function WatchlistItem({
  entry,
  selected,
  onSelect,
  onRemove,
  onSetExpiry,
  onOpenNews,
}: {
  entry: WatchlistEntry;
  selected: boolean;
  onSelect: (t: string) => void;
  onRemove: (t: string) => void;
  onSetExpiry: (expires_at: string) => void;
  onOpenNews: () => void;
}) {
  const exp = dayjs(entry.expires_at);
  const daysLeft = exp.startOf('day').diff(dayjs().startOf('day'), 'day');
  const expColor = daysLeft <= 0 ? '#ff7875' : daysLeft <= 1 ? '#faad14' : daysLeft <= 3 ? '#faad14' : '#8c8c8c';
  const expText = daysLeft <= 0 ? 'today' : `${daysLeft}d`;
  const hasNews = entry.news_title != null;

  return (
    <div
      onClick={() => onSelect(entry.ticker)}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: '1px solid #2a2a2a',
        cursor: 'pointer',
        background: selected ? '#15395b' : undefined,
      }}
    >
      <div style={{ flex: '1 1 auto', minWidth: 0, padding: '6px 8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <WatchlistStar ticker={entry.ticker} size={13} />
            <TickerLink
              ticker={entry.ticker}
              onSelect={onSelect}
              stopPropagation
              style={{ color: '#fff', fontWeight: 600, fontSize: 13 }}
            />
            {/* "New news since you added / last looked" dot. */}
            {entry.has_new_news && (
              <Tooltip title="New news since you added this">
                <span style={{ color: '#73d13d', fontSize: 10 }}>🆕</span>
              </Tooltip>
            )}
            {hasNews && (
              <CatalystBadge
                score={entry.catalyst_score}
                reason={entry.catalyst_reason ?? undefined}
                type={entry.catalyst_type ?? undefined}
                onOpen={onOpenNews}
                size={12}
              />
            )}
          </span>
          {/* Inline expiry editor — click the days-left chip to change it. */}
          <ExpiryEditor expires={exp} color={expColor} text={expText} onSet={onSetExpiry} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
          <TickerLinks ticker={entry.ticker} />
          {entry.news_title && (
            <Tooltip title={entry.news_title}>
              <span
                onClick={(e) => { e.stopPropagation(); onOpenNews(); }}
                style={{
                  fontSize: 10,
                  color: '#8c8c8c',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  cursor: 'pointer',
                }}
              >
                {entry.news_title}
              </span>
            </Tooltip>
          )}
        </div>
      </div>
      <Button
        type="text"
        size="small"
        icon={<CloseOutlined style={{ fontSize: 10, color: '#888' }} />}
        onClick={(e) => { e.stopPropagation(); onRemove(entry.ticker); }}
        style={{ width: 22, height: 22, padding: 0, alignSelf: 'center', marginRight: 2, flex: '0 0 auto' }}
      />
    </div>
  );
}

// Click the expiry chip → a Popover DatePicker to push/pull the expiration.
function ExpiryEditor({
  expires,
  color,
  text,
  onSet,
}: {
  expires: dayjs.Dayjs;
  color: string;
  text: string;
  onSet: (expires_at: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      content={
        <div onClick={(e) => e.stopPropagation()}>
          <DatePicker
            size="small"
            value={expires}
            allowClear={false}
            format="MMM D"
            disabledDate={(d) => d.isBefore(dayjs(), 'day')}
            onChange={(d) => {
              if (d) {
                onSet(d.format('YYYY-MM-DD'));
                setOpen(false);
              }
            }}
          />
        </div>
      }
    >
      <Tooltip title={`Expires ${expires.format('MMM D')} — click to change`}>
        <span
          onClick={(e) => e.stopPropagation()}
          style={{ color, fontSize: 10, flex: '0 0 auto', cursor: 'pointer', border: '1px solid #333', borderRadius: 3, padding: '0 4px' }}
        >
          {text}
        </span>
      </Tooltip>
    </Popover>
  );
}
