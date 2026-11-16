// The entry's life: bind an ephemeral port, tell the env where to find this
// forge, then wait until the env says the trial is over and leave quietly.
//
//   1. MAKEFUN_ENV_URL names the env. Without it there is nothing to register
//      with, so the process exits 1 at once.
//   2. The server listens on port 0: the kernel picks a free port. Port 8080
//      is never bound — the env owns it.
//   3. POST $MAKEFUN_ENV_URL/register {"port": N}. A 200 registers; a 409
//      means some other entry registered first, and this process simply waits
//      like any other. A 400 or 405 is a contract error and ends the program;
//      anything else is retried, since the env may still be starting.
//   4. GET $MAKEFUN_ENV_URL/done until the body is {"done": true}. The env
//      answers at once ({"done": false} while the suite runs), so this is a
//      poll, not a long-held request. A failed poll is retried with a short
//      exponential backoff; the process never exits before the env says done.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[git-forge] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const BACKOFF_FIRST_MS = 250;
const BACKOFF_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential, capped. */
function backoffMs(attempt: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/** Tell the env the bound port, retrying until it accepts (or refuses for good). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error(`register answered HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register answered HTTP ')) throw error;
    }
    await sleep(backoffMs(attempt));
  }
}

/** Poll the env until it says the trial is done. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet: it is not done, so poll again.
    }
    await sleep(backoffMs(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[git-forge] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[git-forge] registered; waiting for the env to say done\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[git-forge] done\n');
}

try {
  await main();
  process.exit(0);
} catch (error) {
  process.stderr.write(`[git-forge] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
