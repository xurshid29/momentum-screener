import { useState } from 'react';
import {
  App, Modal, Upload, Typography, Table, Popconfirm, Button, Tag, Space, type TableColumnsType,
} from 'antd';
import { InboxOutlined, DeleteOutlined } from '@ant-design/icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { tradesApi } from '../../api/trades';
import type { BrokerImport, ImportResult } from '../../api/types';

const { Dragger } = Upload;
const { Text, Paragraph } = Typography;

export function ImportTradesModal(
  { open, onClose, onImported }: { open: boolean; onClose: () => void; onImported?: (periodEnd: string | null) => void },
) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [result, setResult] = useState<ImportResult | null>(null);

  const importsQ = useQuery({ queryKey: ['trade-imports'], queryFn: () => tradesApi.imports(), enabled: open });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['trade-imports'] });
    qc.invalidateQueries({ queryKey: ['trade-calendar'] });
    qc.invalidateQueries({ queryKey: ['trade-day'] });
    qc.invalidateQueries({ queryKey: ['trade-range'] });
  };

  const importMut = useMutation({
    mutationFn: ({ name, content }: { name: string; content: string }) => tradesApi.importTlg(name, content),
    onSuccess: (res) => {
      setResult(res);
      message.success(
        `Imported ${res.executions_imported} new fill${res.executions_imported === 1 ? '' : 's'}` +
          (res.duplicates ? ` · ${res.duplicates} already on file` : ''),
      );
      invalidate();
      // Jump the calendar to the imported statement's month so the data shows
      // immediately (the page otherwise sits on the current, possibly empty month).
      if (res.executions_imported > 0) onImported?.(res.period_end);
    },
    onError: (e: Error) => message.error(e.message || 'Import failed'),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => tradesApi.deleteImport(id),
    onSuccess: () => {
      message.success('Import removed');
      invalidate();
    },
    onError: (e: Error) => message.error(e.message || 'Failed to remove'),
  });

  const beforeUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => importMut.mutate({ name: file.name, content: String(reader.result ?? '') });
    reader.onerror = () => message.error('Could not read file');
    reader.readAsText(file);
    return false; // prevent antd's default auto-upload
  };

  const cols: TableColumnsType<BrokerImport> = [
    { title: 'File', dataIndex: 'filename', ellipsis: true, render: (v: string | null) => v || <Text type="secondary">—</Text> },
    { title: 'Account', dataIndex: 'account', width: 110, render: (v) => v || '—' },
    {
      title: 'Period', key: 'period', width: 180,
      render: (_, r) => (r.period_start ? `${r.period_start} → ${r.period_end}` : '—'),
    },
    {
      title: 'Fills', key: 'fills', width: 110, align: 'right',
      render: (_, r) => `${r.executions_imported}/${r.executions_seen}`,
    },
    {
      title: '', key: 'del', width: 40,
      render: (_, r) => (
        <Popconfirm
          title="Remove this import and its fills?"
          okText="Remove" okButtonProps={{ danger: true }}
          onConfirm={() => delMut.mutate(r.id)}
        >
          <Button type="text" size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ];

  return (
    <Modal
      title="Import Trades — Interactive Brokers"
      open={open}
      onCancel={() => { setResult(null); onClose(); }}
      footer={null}
      width={640}
    >
      <Dragger
        accept=".tlg,.txt,text/plain"
        beforeUpload={beforeUpload}
        showUploadList={false}
        disabled={importMut.isPending}
        style={{ background: '#141414' }}
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">Drop your IBKR TradeLog (.tlg) here, or click to choose</p>
        <p className="ant-upload-hint" style={{ fontSize: 12 }}>
          IBKR → Reports → Statements → Third-Party Downloads → TradeLog format. Re-importing an
          overlapping file is safe — duplicate fills are skipped automatically.
        </p>
      </Dragger>

      {result && (
        <div style={{ marginTop: 12, padding: 12, background: '#141414', border: '1px solid #303030', borderRadius: 4 }}>
          <Space size="small" wrap>
            <Tag color="green">{result.executions_imported} imported</Tag>
            {result.duplicates > 0 && <Tag>{result.duplicates} duplicates</Tag>}
            {result.skipped > 0 && <Tag color="orange">{result.skipped} skipped</Tag>}
            {result.account && <Text type="secondary">{result.account_name} · {result.account}</Text>}
          </Space>
          {result.period_start && (
            <Paragraph style={{ margin: '6px 0 0', fontSize: 12 }} type="secondary">
              {result.period_start} → {result.period_end}
            </Paragraph>
          )}
        </div>
      )}

      <Typography.Title level={5} style={{ marginTop: 20, marginBottom: 8 }}>Import history</Typography.Title>
      <Table
        rowKey="id"
        size="small"
        columns={cols}
        dataSource={importsQ.data ?? []}
        loading={importsQ.isLoading}
        pagination={false}
        locale={{ emptyText: 'No imports yet' }}
        scroll={{ y: 200 }}
      />
    </Modal>
  );
}
