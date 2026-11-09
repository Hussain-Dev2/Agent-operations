import { buildHub } from "./app.js";
import { loadConfig } from "./config.js";
import { connectPostgres } from "./db/index.js";

const config = loadConfig();
const { db, close } = await connectPostgres(config.databaseUrl);
const { app, hub } = await buildHub(config, db);

await app.listen({ host: config.host, port: config.port });

if (await hub.auth.setupRequired()) {
  app.log.warn(`Owner setup is open. Setup token: ${hub.auth.setupToken}  (open ${config.publicWebUrl}/setup)`);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(close)
      .finally(() => process.exit(0));
  });
}
