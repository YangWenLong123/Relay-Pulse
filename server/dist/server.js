import { createApp } from './app.js';
import { config } from './config.js';
const app = await createApp();
app.listen(config.port, config.host, () => {
    console.log(`Relay Pulse API: http://${config.host}:${config.port}`);
});
