import { Outlet, useNavigate } from 'react-router-dom';
import { Layout, Dropdown, Space, Avatar, Typography } from 'antd';
import { UserOutlined, LogoutOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { useAuth } from '../../context/AuthContext';
import { AlertsToggle } from './AlertsToggle';

const { Header, Content } = Layout;
const { Text } = Typography;

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

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
        <Text strong style={{ color: '#e0e0e0', letterSpacing: 1 }}>MOMENTUM SCREENER</Text>
        <Space size="middle">
          <AlertsToggle />
          <Dropdown menu={{ items: menuItems }} placement="bottomRight">
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
