// main.ts — entrypoint: bind an ephemeral port, register with the harness, and
// serve the forge until the harness says the run is done.

import { createApp } from './server.ts';

const envUrl = process.env.MAKEFUN_ENV_URL;
if (!envUrl) {
  throw new Error('MAKEFUN_ENV_URL is required');
}

async function register(port: number): Promise<void> {
  const url = new URL('/register', envUrl);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.ok || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`registration refused: ${res.status}`);
      lastError = new Error(`register ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error('registration failed');
}

async function waitForDone(): Promise<void> {
  const url = new URL('/done', envUrl);
  for (let attempt = 0; attempt < 3600; attempt += 1) {
    const res = await fetch(url);
    if (res.ok) {
      const data = (await res.json()) as { done?: boolean };
      if (data.done) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('timeout waiting for done');
}

const app = createApp();
await new Promise<void>((resolve) => {
  app.listen(0, () => resolve());
});
const address = app.address();
if (address === null || typeof address === 'string') throw new Error('could not bind an ephemeral port');
await register(address.port);
await waitForDone();
await new Promise<void>((resolve) => {
  app.close(() => resolve());
});
process.exit(0);
