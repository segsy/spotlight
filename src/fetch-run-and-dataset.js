import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

async function main() {
  const token = process.env.APIFY_TOKEN;
  const runId = process.env.RUN_ID;
  const outputDir = process.env.OUTPUT_DIR || path.join('storage', 'datasets');

  if (!token) {
    console.error('❌ Missing APIFY_TOKEN in environment');
    process.exit(1);
  }

  if (!runId) {
    console.error('❌ Missing RUN_ID in environment');
    process.exit(1);
  }

  if (typeof fetch !== 'function') {
    console.error('❌ Global fetch not available. Use Node 18+');
    process.exit(1);
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };

  await fs.mkdir(outputDir, { recursive: true });

  /* ----------------------------------------------------
   * 1) Fetch run details
   * -------------------------------------------------- */
  const runUrl = `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`;
  console.log('🔎 Fetching run:', runUrl);

  const runRes = await fetch(runUrl, { headers });
  if (!runRes.ok) {
    console.error('❌ Failed to fetch run:', runRes.status, await runRes.text());
    process.exit(2);
  }

  const runJson = await runRes.json();
  const runData = runJson?.data;

  if (!runData) {
    console.error('❌ Invalid run response');
    console.error(JSON.stringify(runJson, null, 2));
    process.exit(3);
  }

  const datasetId = runData.defaultDatasetId;
  if (!datasetId) {
    console.error('❌ defaultDatasetId not found in run');
    console.error(JSON.stringify(runData, null, 2));
    process.exit(4);
  }

  // Save run metadata
  const runOutPath = path.join(outputDir, `${runId}_run.json`);
  await fs.writeFile(runOutPath, JSON.stringify(runJson, null, 2), 'utf8');
  console.log('✅ Saved run metadata:', runOutPath);

  /* ----------------------------------------------------
   * 2) Fetch dataset items
   * -------------------------------------------------- */
  const itemsUrl =
    `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items` +
    `?format=json&clean=true&limit=100000`;

  console.log('📦 Fetching dataset items:', itemsUrl);

  const itemsRes = await fetch(itemsUrl, { headers });
  if (!itemsRes.ok) {
    console.error('❌ Failed to fetch dataset items:', itemsRes.status, await itemsRes.text());
    process.exit(5);
  }

  const items = await itemsRes.json();

  const itemsOutPath = path.join(outputDir, `${datasetId}_items.json`);
  await fs.writeFile(itemsOutPath, JSON.stringify(items, null, 2), 'utf8');

  console.log(`✅ Saved ${items.length} dataset items to:`, itemsOutPath);
}

main().catch((err) => {
  console.error('💥 Unexpected error:', err?.stack || err);
  process.exit(99);
});
