import { loadConfig } from "./config";
import { createRuntime } from "./app";

const config = loadConfig();
const { server, loraCollector } = await createRuntime(config, {
  startLoraCollector: true,
});

server.listen(config.port, config.host, () => {
  console.info(`同频 API 已启动：http://${config.host}:${config.port}`);
});

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await loraCollector.stop();
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
