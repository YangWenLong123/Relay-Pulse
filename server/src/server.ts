import type { Server } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { PoolProxyService } from './services/pool-proxy-service.js';

let shuttingDown = false;

function closeServer(target: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    target.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function shutdown(signal: string, server: Server, pool: PoolProxyService): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在停止 Relay Pulse…`);
  await pool.close();
  await closeServer(server);
}

async function main(): Promise<void> {
  const app = await createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`Relay Pulse API: http://${config.host}:${config.port}`);
  });
  const pool = app.locals.pool as PoolProxyService;

  (['SIGINT', 'SIGTERM'] as const).forEach((signal) => {
    process.once(signal, () => {
      void shutdown(signal, server, pool)
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          console.error('Relay Pulse 关闭失败', error);
          process.exit(1);
        });
    });
  });
}

void main().catch((error: unknown) => {
  console.error('Relay Pulse 启动失败', error);
  process.exit(1);
});
