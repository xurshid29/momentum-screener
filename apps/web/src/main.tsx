import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App, ConfigProvider } from 'antd';
import { AuthProvider } from './context/AuthContext';
import { router } from './routes';
import { theme } from './theme/config';
import './index.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5 * 60 * 1000, // 5 minutes
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfigProvider theme={theme}>
        <App message={{ maxCount: 3 }}>
          <AuthProvider>
            <RouterProvider router={router} />
          </AuthProvider>
        </App>
      </ConfigProvider>
    </QueryClientProvider>
  </StrictMode>
);
