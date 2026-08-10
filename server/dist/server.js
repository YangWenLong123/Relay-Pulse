import { createApp } from './app.js';
import { config } from './config.js';
let shuttingDown = false;
function closeServer(target) {
    return new Promise((resolve, reject) => {
        target.close((error) => {
            if (error)
                reject(error);
            else
                resolve();
        });
    });
}
async function shutdown(signal, server, pool, codexProxy) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    console.log(`收到 ${signal}，正在停止 Relay Pulse…`);
    await Promise.all([pool.close(), codexProxy.close()]);
    await closeServer(server);
}
async function main() {
    const app = await createApp();
    const server = app.listen(config.port, config.host, () => {
        console.log(`Relay Pulse API: http://${config.host}:${config.port}`);
    });
    const pool = app.locals.pool;
    const codexProxy = app.locals.codexProxy;
    ['SIGINT', 'SIGTERM'].forEach((signal) => {
        process.once(signal, () => {
            void shutdown(signal, server, pool, codexProxy)
                .then(() => process.exit(0))
                .catch((error) => {
                console.error('Relay Pulse 关闭失败', error);
                process.exit(1);
            });
        });
    });
}
void main().catch((error) => {
    console.error('Relay Pulse 启动失败', error);
    process.exit(1);
});
