import { useMemo, useState } from 'react';
import { Typography, Input, DatePicker, Button, Empty, Tooltip, App } from 'antd';
import { CloseOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs, { type Dayjs } from 'dayjs';
import { useSelection } from '../../context/SelectionContext';
import { useWatchlist } from '../../hooks/useWatchlist';
import { TickerLink } from '../common/TickerLink';
import { TickerLinks } from '../common/TickerLinks';
import type { WatchlistEntry } from '../../api/prefs';

const { Text } = Typography;

// Default expiry when adding — a week out covers the "park it over the weekend,
// act early next week" case without making the user pick every time.
const DEFAULT_EXPIRY_DAYS = 7;

// Always-visible watchlist / favorites with an expiration date. Add a ticker
// while the market's closed (a note for the thesis + when to stop caring),
// analyze it, click it to drive the charts + Quote panel, act at the open.
// Expired entries auto-remove server-side (ET-day cleanup), so the list stays
// to exactly what's still live. Sits under the Ignition sidebar in the left
// rail; both stay visible while you scan the screener tabs.
export function WatchlistPanel() {
  const { selected, setSelected } = useSelection();
  const { entries, add, adding, remove } = useWatchlist();

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
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
          <Text strong style={{ color: '#e0e0e0', letterSpacing: 0.5 }}>★ Watchlist</Text>
          <Text type="secondary" style={{ fontSize: 11, marginLeft: 6 }}>{entries.length}</Text>
        </span>
      </div>

      <AddForm
        prefillTicker={selected}
        adding={adding}
        onAdd={(e) => add(e)}
      />

      {entries.length === 0 ? (
        <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              <Text type="secondary" style={{ fontSize: 12 }}>
                Nothing watched. Add a ticker to plan a trade.
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AddForm({
  prefillTicker,
  adding,
  onAdd,
}: {
  prefillTicker: string | null;
  adding: boolean;
  onAdd: (e: { ticker: string; note?: string; expires_at: string }) => void;
}) {
  const { message } = App.useApp();
  const [ticker, setTicker] = useState('');
  const [note, setNote] = useState('');
  const [expiry, setExpiry] = useState<Dayjs>(() => dayjs().add(DEFAULT_EXPIRY_DAYS, 'day'));

  const submit = () => {
    const t = (ticker || prefillTicker || '').trim().toUpperCase();
    if (!t) {
      message.warning('Enter a ticker');
      return;
    }
    onAdd({
      ticker: t,
      note: note.trim() || undefined,
      expires_at: expiry.format('YYYY-MM-DD'),
    });
    setTicker('');
    setNote('');
    setExpiry(dayjs().add(DEFAULT_EXPIRY_DAYS, 'day'));
  };

  return (
    <div style={{ padding: '6px 8px', borderBottom: '1px solid #2a2a2a', display: 'flex', flexDirection: 'column', gap: 4 }}>
      <Input
        size="small"
        placeholder={prefillTicker ? `Ticker (${prefillTicker})` : 'Ticker'}
        value={ticker}
        onChange={(e) => setTicker(e.target.value)}
        onPressEnter={submit}
        style={{ textTransform: 'uppercase' }}
      />
      <Input
        size="small"
        placeholder="Note / thesis (optional)"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onPressEnter={submit}
      />
      <div style={{ display: 'flex', gap: 4 }}>
        <DatePicker
          size="small"
          value={expiry}
          onChange={(d) => d && setExpiry(d)}
          allowClear={false}
          format="MMM D"
          // Can't expire in the past — disable everything before today.
          disabledDate={(d) => d.isBefore(dayjs(), 'day')}
          style={{ flex: '1 1 auto' }}
        />
        <Button
          size="small"
          type="primary"
          icon={<PlusOutlined />}
          loading={adding}
          onClick={submit}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

function WatchlistItem({
  entry,
  selected,
  onSelect,
  onRemove,
}: {
  entry: WatchlistEntry;
  selected: boolean;
  onSelect: (t: string) => void;
  onRemove: (t: string) => void;
}) {
  const expiryLabel = useMemo(() => {
    const exp = dayjs(entry.expires_at);
    const days = exp.startOf('day').diff(dayjs().startOf('day'), 'day');
    const text = exp.format('MMM D');
    if (days <= 0) return { text: `${text} · today`, color: '#ff7875' };
    if (days === 1) return { text: `${text} · 1d left`, color: '#faad14' };
    if (days <= 3) return { text: `${text} · ${days}d left`, color: '#faad14' };
    return { text: `${text} · ${days}d left`, color: '#8c8c8c' };
  }, [entry.expires_at]);

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
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            <TickerLink
              ticker={entry.ticker}
              onSelect={onSelect}
              stopPropagation
              style={{ color: '#fff', fontWeight: 600, fontSize: 13 }}
            />
            <TickerLinks ticker={entry.ticker} />
          </span>
          <Text style={{ color: expiryLabel.color, fontSize: 10, flex: '0 0 auto' }}>
            {expiryLabel.text}
          </Text>
        </div>
        {entry.note && (
          <Tooltip title={entry.note}>
            <div
              style={{
                fontSize: 11,
                color: '#bfbfbf',
                marginTop: 1,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {entry.note}
            </div>
          </Tooltip>
        )}
      </div>
      <Button
        type="text"
        size="small"
        title="Remove"
        icon={<CloseOutlined style={{ fontSize: 10, color: '#888' }} />}
        onClick={(e) => { e.stopPropagation(); onRemove(entry.ticker); }}
        style={{ width: 22, height: 22, padding: 0, alignSelf: 'center', marginRight: 2, flex: '0 0 auto' }}
      />
    </div>
  );
}
