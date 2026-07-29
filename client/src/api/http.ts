import axios from 'axios';
import { resolveApiBaseUrl } from '../utils/runtime';

const runtimeProtocol = typeof window === 'undefined' ? '' : window.location.protocol;

export const http = axios.create({
  baseURL: resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL, runtimeProtocol),
  timeout: 130000,
  headers: { 'Content-Type': 'application/json' }
});

export function errorMessage(error: unknown): string {
  if (axios.isCancel(error)) return '请求已取消';
  if (error instanceof DOMException && error.name === 'AbortError') return '请求已取消';
  if (axios.isAxiosError(error)) {
    const message = error.response?.data?.message;
    if (typeof message === 'string' && message) return message;
    if (error.code === 'ECONNABORTED') return '请求超时';
    return error.message || '网络请求失败';
  }
  return error instanceof Error ? error.message : '操作失败';
}
