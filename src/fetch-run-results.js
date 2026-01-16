import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

const ACTOR_ID = process.env.ACTOR_ID || 'segsy~spotlight-multi-scrapping-system';

async function fetchJson(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { ok: res.ok, status: res.status, text, json };
}

async function main() {
  const token = process.env.APIFY_TOKEN;
  let runId = process.env.RUN_ID;

  if (!token) {
    console.error('Missing APIFY_TOKEN in environment.');
    process.exit(1);
  }

  // NOTE: Node < 18 will crash here.
  if (typeof fetch !== 'function') {
    console.error('Global fetch is not available. Use Node 18+ or add a fetch polyfill (undici/node-fetch).');
    process.exit(1);
  }

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

  // If RUN_ID isn't provided, fetch the latest run for the actor
  if (!runId) {
    const listRunsUrl =
      `https://api.apify.com/v2/acts/${encodeURIComponent(ACTOR_ID)}/runs?limit=1&desc=1`;

    console.log('No RUN_ID provided — fetching latest run from:', listRunsUrl);
    const { ok, status, json, text } = await fetchJson(listRunsUrl, headers);
    if (!ok) {
      console.error('Failed to fetch runs list:', status, text.slice(0, 500));
      process.exit(2);
    }

    const first = json?.data?.items?.[0];
    runId = first?.id;
    if (!runId) {
      console.error('Could not determine run id. Response keys:', Object.keys(json || {}));
      console.error(JSON.stringify(json, null, 2).slice(0, 1200));
      process.exit(3);
    }
    console.log('Selected run id:', runId);
  }

  // Fetch run details (most standard endpoint)
  const runUrl = `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`;
  const runRes = await fetchJson(runUrl, headers);

  if (!runRes.ok) {
    console.error('Failed to fetch run:', runRes.status, runRes.text.slice(0, 500));
    process.exit(4);
  }

  const datasetId = runRes.json?.data?.defaultDatasetId;
  if (!datasetId) {
    console.error('Could not find defaultDatasetId in run response.');
    console.error(JSON.stringify(runRes.json, null, 2).slice(0, 1200));
    process.exit(5);
  }

  console.log('Found dataset id:', datasetId);

  // Fetch dataset items
  const itemsUrl =
    `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=true&limit=10000`;

  const itemsRes = await fetchJson(itemsUrl, headers);
  if (!itemsRes.ok) {
    console.error('Failed to fetch dataset items:', itemsRes.status, itemsRes.text.slice(0, 500));
    process.exit(6);
  }

  const items = itemsRes.json || [];
  const outDir = path.join('storage', 'datasets');
  await fs.mkdir(outDir, { recursive: true });

  const outPath = path.join(outDir, `${datasetId}.json`);
  await fs.writeFile(outPath, JSON.stringify(items, null, 2), 'utf8');

  console.log(`Saved ${items.length} items to ${outPath}`);
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(10);
});
