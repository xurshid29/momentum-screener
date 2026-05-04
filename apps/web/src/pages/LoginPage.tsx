import { Card, Typography } from 'antd';
import { LoginForm } from '../components/auth/LoginForm';

const { Title } = Typography;

export function LoginPage() {
  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        background: '#f0f2f5',
      }}
    >
      <Card style={{ width: 400, padding: 24 }}>
        <Title level={2} style={{ textAlign: 'center', marginBottom: 32 }}>
          Trading App
        </Title>
        <LoginForm />
      </Card>
    </div>
  );
}
