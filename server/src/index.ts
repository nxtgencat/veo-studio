import { app } from "./routes.ts";
import { getDb } from "./db.ts";
import { recoverInterrupted } from "./jobs.ts";
import { logger } from "./logger.ts";

const port = Number(process.env.PORT ?? 8787);

// Ensure DB migrates at boot, then resume jobs killed by a previous crash.
getDb();
try {
  const rec = await recoverInterrupted();
  if (rec.resumed || rec.expired) {
    logger.info(rec, "crash recovery complete");
  }
} catch (e) {
  logger.error({ err: String(e) }, "crash recovery failed");
}

export default {
  port,
  fetch: app.fetch,
};

logger.info({ port }, "veo headless server listening");
