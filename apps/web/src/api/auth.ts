import { apiClient } from './client';
import type { LoginResponse, User } from './types';

export const authApi = {
  async login(username: string, password: string): Promise<LoginResponse> {
    const response = await apiClient.post<LoginResponse>('/api/auth/login', {
      username,
      password,
    });
    return response.data;
  },

  async register(username: string, password: string): Promise<LoginResponse> {
    const response = await apiClient.post<LoginResponse>('/api/auth/register', {
      username,
      password,
    });
    return response.data;
  },

  async me(): Promise<User> {
    const response = await apiClient.get<User>('/api/auth/me');
    return response.data;
  },
};
