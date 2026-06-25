import { useEffect, useState } from 'react';
import { Modal, Form, InputNumber, Select, message, Switch, Typography, Divider } from 'antd';
import { screenerApi } from '../../api/screener';
import type { ScreenerFilterSnapshot } from '../../api/types';

const { Text } = Typography;

interface FiltersDialogProps {
  open: boolean;
  onClose: () => void;
  config: ScreenerFilterSnapshot | null; // current poller config (from latest payload)
}

interface FormValues {
  stocksOnly: boolean;
  priceMin: number;
  priceMax: number;
  changeMin: number;     // Finviz expects bucket values
  relVolMin: number;
  floatMaxM: number;     // post-filter ceiling
  topN: number;
}

const CHANGE_BUCKETS = [5, 10, 15, 20];                    // ta_change_<x>to
const RELVOL_BUCKETS = [1, 1.5, 2, 3, 5, 10];               // sh_relvol_o<x>

const DEFAULTS: FormValues = {
  stocksOnly: true,
  priceMin: 1,
  priceMax: 25,
  changeMin: 20,
  relVolMin: 5,
  floatMaxM: 35,
  topN: 50,
};

// Reverse-parse the saved filter expression back into form fields. Falls back
// to defaults for any token we can't read.
function parseFilter(filter: string, snapshot: ScreenerFilterSnapshot): FormValues {
  const get = (re: RegExp) => filter.match(re)?.[1];
  return {
    stocksOnly: filter.includes('ind_stocksonly'),
    priceMin: numOrDefault(get(/sh_price_([\d.]+)to/), DEFAULTS.priceMin),
    priceMax: numOrDefault(get(/sh_price_[\d.]+to([\d.]+)/), DEFAULTS.priceMax),
    changeMin: snapToBucket(numOrDefault(get(/ta_change_([\d.]+)to/), DEFAULTS.changeMin), CHANGE_BUCKETS),
    relVolMin: snapToBucket(numOrDefault(get(/sh_relvol_o([\d.]+)/), DEFAULTS.relVolMin), RELVOL_BUCKETS),
    floatMaxM: snapshot.float_max_m ?? DEFAULTS.floatMaxM,
    topN: snapshot.top_n ?? DEFAULTS.topN,
  };
}

function numOrDefault(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : fallback;
}

function snapToBucket(value: number, buckets: number[]): number {
  return buckets.reduce((closest, b) => (Math.abs(b - value) < Math.abs(closest - value) ? b : closest), buckets[0]);
}

function buildFilter(v: FormValues): string {
  // Deliberately NO sh_float token. Finviz's float "under" presets cap at 100M
  // (so a 150–200M name like ILLR was silently excluded), and setting sh_float
  // also makes Finviz drop null-float rows (legit nano-caps). The float ceiling
  // is enforced in code via float_max_m (finviz.ts post-filter), which can
  // express any value. See CLAUDE.md "Finviz avg_volume scale gotcha" §Float.
  const parts: string[] = [];
  if (v.stocksOnly) parts.push('ind_stocksonly');
  parts.push(`sh_price_${v.priceMin}to${v.priceMax}`);
  parts.push(`sh_relvol_o${v.relVolMin}`);
  parts.push(`ta_change_${v.changeMin}to`);
  return parts.join(',');
}

export function FiltersDialog({ open, onClose, config }: FiltersDialogProps) {
  const [form] = Form.useForm<FormValues>();
  const [submitting, setSubmitting] = useState(false);

  // Re-hydrate on each open so a subsequent open shows the latest poller state.
  useEffect(() => {
    if (!open) return;
    const initial = config ? parseFilter(config.filter, config) : DEFAULTS;
    form.setFieldsValue(initial);
  }, [open, config, form]);

  const onSubmit = async () => {
    let v: FormValues;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    if (v.priceMax <= v.priceMin) {
      message.error('Price max must be greater than price min');
      return;
    }
    setSubmitting(true);
    try {
      await screenerApi.patchConfig({
        filter: buildFilter(v),
        float_max_m: v.floatMaxM,
        top_n: v.topN,
      });
      message.success('Filter updated — applies on the next poll cycle');
      onClose();
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Failed to update filter');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="Screener Filters"
      open={open}
      onCancel={onClose}
      onOk={onSubmit}
      okText="Apply"
      confirmLoading={submitting}
      width={520}
      destroyOnHidden
    >
      <Form<FormValues> form={form} layout="vertical" initialValues={DEFAULTS}>
        <Form.Item label="Stocks only (no ETFs)" name="stocksOnly" valuePropName="checked">
          <Switch />
        </Form.Item>

        <Divider style={{ margin: '8px 0' }} />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Form.Item label="Price min ($)" name="priceMin" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.5} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Price max ($)" name="priceMax" rules={[{ required: true }]}>
            <InputNumber min={0} step={0.5} style={{ width: '100%' }} />
          </Form.Item>

          <Form.Item label="Min change %" name="changeMin" rules={[{ required: true }]}>
            <Select
              options={CHANGE_BUCKETS.map((b) => ({ label: `≥ ${b}%`, value: b }))}
            />
          </Form.Item>
          <Form.Item label="Min rel volume" name="relVolMin" rules={[{ required: true }]}>
            <Select
              options={RELVOL_BUCKETS.map((b) => ({ label: `≥ ${b}×`, value: b }))}
            />
          </Form.Item>

          <Form.Item
            label="Max float (M)"
            name="floatMaxM"
            rules={[{ required: true }]}
            extra="Enforced server-side — any value works (incl. >100M)."
          >
            <InputNumber min={0.1} step={1} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item label="Top N rows" name="topN" rules={[{ required: true }]}>
            <InputNumber min={1} max={200} step={5} style={{ width: '100%' }} />
          </Form.Item>
        </div>

        <Text type="secondary" style={{ fontSize: 11 }}>
          Min change %, rel volume, and float bucket get snapped to Finviz's available filter values.
          Float max is post-filtered to the exact number in the poller.
        </Text>
      </Form>
    </Modal>
  );
}
