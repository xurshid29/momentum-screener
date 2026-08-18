import { useState } from 'react';
import {
  App, Button, Empty, Form, Input, InputNumber, Modal, Popconfirm, Space,
  Switch, Table, Tag, Tooltip, Typography,
} from 'antd';
import {
  DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined,
} from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import type { EdgePhase, EdgePresetInput, EdgeSetup, EdgeSnapshot } from '../../api/types';
import { useSelection } from '../../context/SelectionContext';
import { useEdge } from '../../hooks/useEdge';
import { TickerLink } from '../common/TickerLink';

const { Text } = Typography;

const STATE: Record<EdgePhase, { color: string; label: string }> = {
  warming: { color: 'default', label: 'WARMING' },
  watching: { color: 'blue', label: 'WATCHING' },
  armed: { color: 'gold', label: 'ARMED' },
  entry: { color: 'green', label: 'ENTRY' },
  bailout: { color: 'red', label: 'BAILOUT' },
};

const SETUP: Record<EdgeSetup, string> = {
  ema_bounce: 'EMA bounce',
  vwap_bounce: 'VWAP bounce',
  ema_reclaim: 'EMA reclaim',
  vwap_reclaim: 'VWAP reclaim',
  vwap_ema_reclaim: 'VWAP + EMA reclaim',
};

type EditorValues = Omit<EdgePresetInput, 'active'> & { ticker: string };

function price(v: number | null): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return v >= 10 ? v.toFixed(2) : v >= 1 ? v.toFixed(3) : v.toFixed(4);
}

function age(iso: string | null): string {
  if (!iso) return '—';
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m`;
}

export function EdgePanel() {
  const { message } = App.useApp();
  const { selected, setSelected } = useSelection();
  const { rows, isLoading, save, saving, reset, remove } = useEdge();
  const [form] = Form.useForm<EditorValues>();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  const openEditor = (row?: EdgeSnapshot) => {
    const ticker = row?.ticker ?? selected ?? '';
    setEditing(row?.ticker ?? null);
    form.setFieldsValue(row ? {
      ticker: row.ticker,
      ema_fast: row.ema_fast,
      ema_slow: row.ema_slow,
      proximity_pct: row.proximity_pct,
      stop_buffer_pct: row.stop_buffer_pct,
      alert_armed: row.alert_armed,
      alert_entry: row.alert_entry,
      alert_bailout: row.alert_bailout,
      telegram_enabled: row.telegram_enabled,
    } : {
      ticker,
      ema_fast: 25,
      ema_slow: 65,
      proximity_pct: 0.75,
      stop_buffer_pct: 0.5,
      alert_armed: true,
      alert_entry: true,
      alert_bailout: true,
      telegram_enabled: true,
    });
    setOpen(true);
  };

  const submit = async () => {
    try {
      const values = await form.validateFields();
      const { ticker: rawTicker, ...valuesWithoutTicker } = values;
      const ticker = rawTicker.trim().toUpperCase();
      const preset: EdgePresetInput = { ...valuesWithoutTicker, active: true };
      await save({ ticker, preset });
      setOpen(false);
      message.success(`${ticker} Edge preset saved`);
    } catch (err) {
      // Ant Form validation errors already render inline; only surface real
      // request failures as a toast.
      if (err instanceof Error) message.error(err.message);
    }
  };

  const columns: ColumnsType<EdgeSnapshot> = [
    {
      title: 'Ticker', dataIndex: 'ticker', width: 92,
      render: (ticker: string) => <TickerLink ticker={ticker} onSelect={setSelected} stopPropagation style={{ color: '#fff', fontWeight: 700 }} />,
    },
    {
      title: 'State', dataIndex: 'state', width: 102,
      render: (state: EdgePhase, row) => (
        <Tooltip title={state === 'warming' ? `${row.warmup_remaining} more printed 1m bars needed` : row.state_at ? `Since ${new Date(row.state_at).toLocaleTimeString()}` : null}>
          <Tag color={STATE[state].color} style={{ margin: 0 }}>{STATE[state].label}</Tag>
        </Tooltip>
      ),
    },
    {
      title: 'Setup', dataIndex: 'setup', width: 145,
      render: (setup: EdgeSetup | null) => setup ? SETUP[setup] : <Text type="secondary">waiting</Text>,
    },
    { title: 'Price', dataIndex: 'price', width: 74, align: 'right', render: price },
    {
      title: <Tooltip title="04:00 ET session VWAP from feed-visible 1m HLC3 × volume. EQUS.MINI can differ from TradingView's consolidated tape; verify the exact chart level before execution.">VWAP</Tooltip>, dataIndex: 'vwap', width: 76, align: 'right',
      render: (v: number | null, row) => <Text style={{ color: row.price != null && v != null && row.price >= v ? '#52c41a' : '#fa8c16' }}>{price(v)}</Text>,
    },
    {
      title: 'Custom EMAs', key: 'emas', width: 180,
      render: (_v, row) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          <Text style={{ color: '#73d13d' }}>E{row.ema_fast} {price(row.ema_fast_value)}</Text>
          <Text type="secondary"> · </Text>
          <Text style={{ color: '#69c0ff' }}>E{row.ema_slow} {price(row.ema_slow_value)}</Text>
        </span>
      ),
    },
    {
      title: 'MACD 3/15/8', key: 'macd', width: 158,
      render: (_v, row) => row.macd == null || row.macd_signal == null ? '—' : (
        <Tooltip title={`Histogram ${row.macd_histogram?.toFixed(5) ?? '—'} · entry requires MACD and histogram both rising`}>
          <Text style={{ color: row.macd_rising && row.histogram_rising ? '#52c41a' : '#bfbfbf' }}>
            {row.macd.toFixed(4)} / {row.macd_signal.toFixed(4)} {row.macd_rising && row.histogram_rising ? '↗' : '—'}
          </Text>
        </Tooltip>
      ),
    },
    {
      title: 'Level → Bailout', key: 'risk', width: 180,
      render: (_v, row) => row.support_value == null ? '—' : (
        <Tooltip title={`${row.support_label ?? 'Support'} · bailout is ${row.stop_buffer_pct}% below the respected level`}>
          <span>{row.support_label} <Text strong>${price(row.support_value)}</Text> → <Text type="danger">${price(row.bailout_level)}</Text></span>
        </Tooltip>
      ),
    },
    {
      title: 'Alerts', key: 'alerts', width: 104,
      render: (_v, row) => (
        <Tooltip title={`Armed ${row.alert_armed ? 'ON' : 'off'} · Entry ${row.alert_entry ? 'ON' : 'off'} · Bailout ${row.alert_bailout ? 'ON' : 'off'} · Telegram ${row.telegram_enabled ? 'ON' : 'off'}`}>
          <Space size={3}>
            <Text style={{ color: row.alert_armed ? '#faad14' : '#595959' }}>A</Text>
            <Text style={{ color: row.alert_entry ? '#52c41a' : '#595959' }}>E</Text>
            <Text style={{ color: row.alert_bailout ? '#ff4d4f' : '#595959' }}>B</Text>
            <Text style={{ color: row.telegram_enabled ? '#69c0ff' : '#595959' }}>✈</Text>
          </Space>
        </Tooltip>
      ),
    },
    {
      title: 'Bar age', dataIndex: 'last_bar_at', width: 68, align: 'right', render: age,
    },
    {
      title: '', key: 'actions', width: 106, fixed: 'right',
      render: (_v, row) => (
        <Space size={2} onClick={(e) => e.stopPropagation()}>
          <Tooltip title="Reset after a completed breakout or bailout">
            <Button type="text" size="small" icon={<ReloadOutlined />} onClick={() => void reset(row.ticker)} />
          </Tooltip>
          <Tooltip title="Edit preset">
            <Button type="text" size="small" icon={<EditOutlined />} onClick={() => openEditor(row)} />
          </Tooltip>
          <Popconfirm title={`Remove ${row.ticker} from Edge?`} onConfirm={() => void remove(row.ticker)}>
            <Button type="text" danger size="small" icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: '7px 10px', borderBottom: '1px solid #303030', display: 'flex', alignItems: 'center', gap: 10 }}>
        <Button type="primary" size="small" icon={<PlusOutlined />} onClick={() => openEditor()}>
          {selected ? `Add ${selected}` : 'Add ticker'}
        </Button>
        <Text type="secondary" style={{ fontSize: 12 }}>
          1m · custom EMA pair · session VWAP · standard MACD 3/15/8 · completed-candle entry/bailout
        </Text>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <Table<EdgeSnapshot>
          rowKey="ticker"
          size="small"
          loading={isLoading}
          columns={columns}
          dataSource={rows}
          pagination={false}
          sticky
          scroll={{ x: 1350 }}
          locale={{
            emptyText: (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Select a Momentum ticker, then add its custom EMA pair to Edge"
              />
            ),
          }}
          onRow={(row) => ({
            onClick: () => setSelected(row.ticker),
            style: { cursor: 'pointer', background: row.ticker === selected ? '#15395b' : undefined },
          })}
        />
      </div>

      <Modal
        title={`${editing ? `Edit ${editing}` : 'Add'} Edge preset`}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="Save & track"
        confirmLoading={saving}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" requiredMark={false}>
          <Form.Item name="ticker" label="Ticker" rules={[{ required: true }, { pattern: /^[A-Za-z0-9.-]{1,12}$/, message: 'Enter a valid ticker' }]}>
            <Input disabled={!!editing} autoFocus={!editing} style={{ textTransform: 'uppercase' }} />
          </Form.Item>
          <Space align="start" size="middle">
            <Form.Item name="ema_fast" label="Fast EMA" rules={[{ required: true }]}>
              <InputNumber min={2} max={499} precision={0} />
            </Form.Item>
            <Form.Item name="ema_slow" label="Slow EMA" dependencies={['ema_fast']} rules={[
              { required: true },
              ({ getFieldValue }) => ({ validator: (_rule, value) => value > getFieldValue('ema_fast') ? Promise.resolve() : Promise.reject(new Error('Slow EMA must exceed fast EMA')) }),
            ]}>
              <InputNumber min={3} max={500} precision={0} />
            </Form.Item>
            <Form.Item name="proximity_pct" label="Arm within %" rules={[{ required: true }]}>
              <InputNumber min={0.05} max={10} step={0.05} precision={2} />
            </Form.Item>
            <Form.Item name="stop_buffer_pct" label="Bailout buffer %" rules={[{ required: true }]}>
              <InputNumber min={0} max={10} step={0.05} precision={2} />
            </Form.Item>
          </Space>
          <Space size="large" wrap>
            <Form.Item name="alert_armed" label="Armed alert" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="alert_entry" label="Entry alert" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="alert_bailout" label="Bailout alert" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="telegram_enabled" label="Telegram" valuePropName="checked"><Switch /></Form.Item>
          </Space>
          <Text type="secondary" style={{ fontSize: 12 }}>
            Armed is an early proximity warning. Entry and bailout require a completed 1-minute candle. Reset the row after the trade resolves to watch for another leg.
          </Text>
        </Form>
      </Modal>
    </div>
  );
}
