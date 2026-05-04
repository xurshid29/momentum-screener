import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Form, Input, Button, message, Tabs } from 'antd';
import { UserOutlined, LockOutlined } from '@ant-design/icons';
import { useAuth } from '../../context/AuthContext';
import { authApi } from '../../api/auth';

interface LoginFormValues {
  username: string;
  password: string;
}

export function LoginForm() {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('login');
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (values: LoginFormValues) => {
    setLoading(true);
    try {
      const response = activeTab === 'login'
        ? await authApi.login(values.username, values.password)
        : await authApi.register(values.username, values.password);

      login(response.token, response.user);
      message.success(activeTab === 'login' ? 'Login successful' : 'Registration successful');
      navigate('/dashboard');
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        centered
        items={[
          { key: 'login', label: 'Login' },
          { key: 'register', label: 'Register' },
        ]}
      />
      <Form
      form={form}
      onFinish={handleSubmit}
      layout="vertical"
      size="large"
    >
      <Form.Item
        name="username"
        rules={[
          { required: true, message: 'Please enter your username' },
          { min: 3, message: 'Username must be at least 3 characters' },
        ]}
      >
        <Input
          prefix={<UserOutlined />}
          placeholder="Username"
          autoComplete="username"
        />
      </Form.Item>

      <Form.Item
        name="password"
        rules={[
          { required: true, message: 'Please enter your password' },
          { min: 6, message: 'Password must be at least 6 characters' },
        ]}
      >
        <Input.Password
          prefix={<LockOutlined />}
          placeholder="Password"
          autoComplete={activeTab === 'login' ? 'current-password' : 'new-password'}
        />
      </Form.Item>

      <Form.Item>
        <Button type="primary" htmlType="submit" loading={loading} block>
          {activeTab === 'login' ? 'Login' : 'Register'}
        </Button>
      </Form.Item>
      </Form>
    </>
  );
}
