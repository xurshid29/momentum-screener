import { theme as antTheme, type ThemeConfig } from 'antd';

export const theme: ThemeConfig = {
  algorithm: antTheme.darkAlgorithm,
  token: {
    colorPrimary: '#1890ff',
    colorSuccess: '#52c41a',
    colorWarning: '#faad14',
    colorError: '#ff4d4f',
    borderRadius: 4,
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    fontSize: 13,
    colorBgBase: '#0a0a0a',
    colorBgContainer: '#1a1a1a',
  },
  components: {
    Layout: {
      headerBg: '#141414',
    },
    Table: {
      headerBg: '#141414',
      rowHoverBg: '#222',
      cellPaddingBlockSM: 4,
      cellPaddingInlineSM: 6,
    },
  },
};
