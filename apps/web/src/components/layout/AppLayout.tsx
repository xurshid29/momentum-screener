import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import { Layout, Dropdown, Space, Avatar, Typography, Segmented } from 'antd';
import { UserOutlined, LogoutOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useAuth } from '../../context/AuthContext';
import { AlertsToggle } from './AlertsToggle';
import { useLayout, type ChartCount } from '../../context/LayoutContext';

const { Header, Content } = Layout;
const { Text } = Typography;

export function AppLayout() {
  const { user, logout } = useAuth();
  const { chartCount, setChartCount } = useLayout();
  const navigate = useNavigate();
  const location = useLocation();
  const onDashboard = location.pathname.startsWith('/dashboard');
  const activePage = location.pathname.startsWith('/journal') ? 'journal' : 'dashboard';

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const menuItems: MenuProps['items'] = [
    { key: 'logout', icon: <LogoutOutlined />, label: 'Logout', onClick: handleLogout },
  ];

  return (
    <Layout style={{ height: '100vh', background: '#0a0a0a' }}>
      <Header
        style={{
          height: 36,
          lineHeight: '36px',
          padding: '0 12px',
          background: '#141414',
          borderBottom: '1px solid #303030',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Space size="middle" align="center">
          <Text strong style={{ color: '#e0e0e0', letterSpacing: 1 }}>PNL DASH</Text>
          <Segmented
            size="small"
            value={activePage}
            options={[{ label: 'Dashboard', value: 'dashboard' }, { label: 'Journal', value: 'journal' }]}
            onChange={(v) => navigate(v === 'journal' ? '/journal' : '/dashboard')}
          />
        </Space>
        <Space size="middle">
          {onDashboard && (
            <>
              <Space size={6}>
                <Text type="secondary" style={{ fontSize: 11 }}>Charts</Text>
                <Segmented<ChartCount>
                  size="small"
                  value={chartCount}
                  options={[0, 1, 2, 3, 4].map((v) => ({ label: String(v), value: v as ChartCount }))}
                  onChange={setChartCount}
                />
              </Space>
              <AlertsToggle />
            </>
          )}
          <Dropdown menu={{ items: menuItems }} placement="bottomRight" trigger={['click']}>
          <Space style={{ cursor: 'pointer', color: '#e0e0e0' }}>
            <Avatar size="small" icon={<UserOutlined />} />
            <span style={{ fontSize: 13 }}>{user?.username || 'User'}</span>
            </Space>
          </Dropdown>
        </Space>
      </Header>
      <Content style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <Outlet />
      </Content>
    </Layout>
  );
}
