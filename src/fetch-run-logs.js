import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

async function main() {
  const token = process.env.APIFY_TOKEN;
  const runId = process.env.RUN_ID;

  if (!token) {
    console.error('Missing APIFY_TOKEN in environment.');
    process.exit(1);
  }
  if (!runId) {
    console.error('Missing RUN_ID. Set RUN_ID in environment to the run id to fetch.');
    process.exit(1);
  }

  if (typeof fetch !== 'function') {
    console.error('Global fetch is not available. Use Node 18+ (you have Node 20+ in your Actor).');
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'text/plain, application/json, */*',
  };

  const outDir = path.join('storage', 'key_value_stores', 'default');
  await fs.mkdir(outDir, { recursive: true });

  // Save run details
  const runUrl = `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`;
  const runRes = await fetch(runUrl, { headers: { ...headers, Accept: 'application/json' } });
  if (!runRes.ok) {
    console.error('Failed to fetch run details:', runRes.status, await runRes.text());
    process.exit(2);
  }
  const runJson = await runRes.json();
  const runOutPath = path.join(outDir, `${runId}_run.json`);
  await fs.writeFile(runOutPath, JSON.stringify(runJson, null, 2), 'utf8');
  console.log('Saved run details to', runOutPath);

  // Fetch logs (text is most reliable on Apify)
  const logsEndpoints = [
    `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}/logs`,
    `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}/logs?format=text`,
    `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}/logs?format=txt`,
    `https://api.apify.com/v2/runs/${encodeURIComponent(runId)}/logs`,
  ];

  for (const url of logsEndpoints) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.log('Logs endpoint', url, 'returned', res.status);
        continue;
      }

      const contentType = res.headers.get('content-type') || '';
      const outPath = contentType.includes('application/json')
        ? path.join(outDir, `${runId}_logs.json`)
        : path.join(outDir, `${runId}_logs.txt`);

      if (contentType.includes('application/json')) {
        const data = await res.json();
        await fs.writeFile(outPath, JSON.stringify(data, null, 2), 'utf8');
        console.log('Saved logs (json) to', outPath);
      } else {
        const text = await res.text();
        await fs.writeFile(outPath, text, 'utf8');
        console.log('Saved logs (text) to', outPath);
      }
      return;
    } catch (e) {
      console.log('Request to', url, 'failed:', e?.message || e);
    }
  }

  console.log('No logs were found at known endpoints. Run details saved.');
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(99);
});
