import { loadConfig } from "./config";
import { createRuntime } from "./app";

const config = loadConfig();
const { server } = await createRuntime(config);

server.listen(config.port, config.host, () => {
  console.info(`同频 API 已启动：http://${config.host}:${config.port}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
