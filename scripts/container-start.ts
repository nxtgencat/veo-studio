// Runs backend + web side by side. Exits non-zero if either dies.

export {};

const WEB_PORT = Number(process.env.PORT ?? 3000);
const API_PORT = Number(process.env.API_PORT ?? 8787);
const BACKEND_ENTRY = process.env.BACKEND_ENTRY ?? "/app/backend/api.js";
const WEB_ENTRY = process.env.WEB_ENTRY ?? "/app/server.js";

function spawnTagged(name: string, cmd: string[], env: Record<string, string>): Bun.Subprocess {
  const proc = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });
  console.log(`[supervisor] ${name} started (pid ${proc.pid})`);
  return proc;
}

async function waitForApi(): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/health`);
      if (res.ok) {
        console.log("[supervisor] backend healthy");
        return;
      }
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error("backend /health never became ready");
    await Bun.sleep(500);
  }
}

const api = spawnTagged("backend", ["bun", BACKEND_ENTRY], {
  PORT: String(API_PORT),
});
const web = spawnTagged("web", ["bun", WEB_ENTRY], {
  PORT: String(WEB_PORT),
  HOSTNAME: "0.0.0.0",
});

let stopping = false;
async function shutdown(signal: string, code: number): Promise<never> {
  if (stopping) process.exit(code);
  stopping = true;
  console.log(`[supervisor] ${signal} — stopping children`);
  api.kill("SIGTERM");
  web.kill("SIGTERM");
  await Promise.allSettled([api.exited, web.exited]);
  process.exit(code);
}

process.on("SIGTERM", () => shutdown("SIGTERM", 0));
process.on("SIGINT", () => shutdown("SIGINT", 0));

try {
  await waitForApi();
} catch (e) {
  console.error(`[supervisor] ${e}`);
  await shutdown("backend-unhealthy", 1);
}

const first = await Promise.race([
  api.exited.then((c) => ({ name: "backend", code: c }) as const),
  web.exited.then((c) => ({ name: "web", code: c }) as const),
]);
console.error(`[supervisor] ${first.name} exited with code ${first.code} — stopping`);
await shutdown(`${first.name}-exit`, first.code === 0 ? 1 : first.code);
