import 'dotenv/config';
import pkg from 'apify-client';

function resolveApifyClient(mod) {
  if (typeof mod === 'function') return mod;
  if (mod?.ApifyClient) return mod.ApifyClient;
  if (typeof mod?.default === 'function') return mod.default;
  if (mod?.default?.ApifyClient) return mod.default.ApifyClient;
  return null;
}

async function main() {
  const ApifyClient = resolveApifyClient(pkg);

  if (!ApifyClient) {
    console.error('Could not resolve ApifyClient export from apify-client.');
    console.error('Top-level keys:', Object.keys(pkg || {}));
    console.error('Default keys:', pkg?.default ? Object.keys(pkg.default) : null);
    process.exit(1);
  }

  const token = process.env.APIFY_TOKEN;
  const runId = process.env.RUN_ID;

  if (!token || !runId) {
    console.error('Set APIFY_TOKEN and RUN_ID in environment');
    process.exit(1);
  }

  const client = new ApifyClient({ token });

  // Inspect what the client actually has
  const clientKeys = Object.keys(client);
  console.log('Client keys:', clientKeys);

  // Helper
  const printResult = (name, res) => {
    console.log(`\nSuccess: ${name}`);
    const data = res?.data ?? res;
    console.log('Top keys:', data ? Object.keys(data) : data);
    console.log(JSON.stringify(data, null, 2).slice(0, 1200));
  };

  const attempts = [];

  // Common newer style
  if (typeof client.run === 'function') {
    const runRes = client.run(runId);
    if (runRes && typeof runRes.get === 'function') {
      attempts.push(async () => ({ name: 'client.run(runId).get()', res: await runRes.get() }));
    }
  }

  // Actor-run resource naming variants
  if (typeof client.actorRun === 'function') {
    const ar = client.actorRun(runId);
    if (ar && typeof ar.get === 'function') {
      attempts.push(async () => ({ name: 'client.actorRun(runId).get()', res: await ar.get() }));
    }
  }

  // Some versions expose actorRuns collection style
  if (typeof client.actorRuns === 'function') {
    const ar = client.actorRuns();
    if (ar && typeof ar.get === 'function') {
      attempts.push(async () => ({ name: 'client.actorRuns().get({ id })', res: await ar.get({ id: runId }) }));
    }
  }

  // Last resort: direct REST fetch (always valid)
  attempts.push(async () => {
    const url = `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`;
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`REST ${r.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text);
    return { name: 'REST /v2/actor-runs/<runId>', res: json };
  });

  // Execute attempts
  for (const fn of attempts) {
    try {
      const out = await fn();
      printResult(out.name, out.res);
      return;
    } catch (e) {
      console.log('Attempt failed:', e?.message || e);
    }
  }

  console.error('All attempts failed');
  process.exit(2);
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(99);
});
