import type { ApiEnvelope, ImageGenerationInput, ImageGenerationResult } from '../types';
import { isStandaloneExtensionRuntime } from '../utils/runtime';
import { http } from './http';

const runtimeProtocol = typeof window === 'undefined' ? '' : window.location.protocol;
const standaloneExtension = isStandaloneExtensionRuntime(
  import.meta.env.VITE_BUILD_TARGET,
  runtimeProtocol,
  import.meta.env.VITE_EXTENSION_DATA_MODE
);

export async function generateImage(input: ImageGenerationInput, signal?: AbortSignal): Promise<ImageGenerationResult> {
  if (standaloneExtension) throw new Error('绘图功能需要在本地后端模式下运行');
  const count = input.count ?? 1;
  return (await http.post<ApiEnvelope<ImageGenerationResult>>('/images/generate', input, {
    signal,
    timeout: Math.max(210_000, count * 210_000),
    maxBodyLength: 12 * 1024 * 1024,
    maxContentLength: 64 * 1024 * 1024
  })).data.data;
}
