import { app } from "./routes.ts";
import { getDb } from "./db.ts";
import { logger } from "./logger.ts";

const port = Number(process.env.PORT ?? 8787);

// Ensure DB migrates at boot.
getDb();

export default {
  port,
  fetch: app.fetch,
};

logger.info({ port }, "veo headless server listening");
