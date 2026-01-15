import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';

async function main() {
    const token = process.env.APIFY_TOKEN;
    let runId = process.env.RUN_ID;
    const runsEndpointEnv = process.env.APIFY_RUNS_ENDPOINT; // optional full endpoint to list runs
    if (!token) {
        console.error('Missing APIFY_TOKEN in environment.');
        process.exit(1);
    }

    // If RUN_ID isn't provided, try to obtain the latest run from a provided runs endpoint.
    if (!runId) {
        const endpoint = runsEndpointEnv || `https://api.apify.com/v2/acts/segsy~spotlight-multi-scrapping-system/runs?token=${encodeURIComponent(token)}`;
        console.log('No RUN_ID provided — fetching runs list from', endpoint);
        try {
            const runsRes = await fetch(endpoint, { headers: { Accept: 'application/json' } });
            if (!runsRes.ok) {
                console.error('Failed to fetch runs list:', runsRes.status, await runsRes.text());
                process.exit(2);
            }
            const runsJson = await runsRes.json();
            // runsJson may have items or runs or data
            const candidates = runsJson.items || runsJson.runs || runsJson.data || runsJson;
            const first = Array.isArray(candidates) ? candidates[0] : null;
            runId = first?.id || first?.runId || first?.actorRunId || null;
            if (!runId) {
                console.error('Could not determine run id from runs list. Dumping response keys:', Object.keys(runsJson || {}));
                console.error(JSON.stringify(runsJson, null, 2).slice(0, 1000));
                process.exit(3);
            }
            console.log('Selected run id:', runId);
        } catch (e) {
            console.error('Failed to fetch runs endpoint:', e?.message || e);
            process.exit(4);
        }
    }

    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    // Try multiple possible run endpoints until one succeeds
    const runEndpoints = [
        `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`,
        `https://api.apify.com/v2/runs/${encodeURIComponent(runId)}`,
        `https://api.apify.com/v2/actors/runs/${encodeURIComponent(runId)}`,
    ];
    let runJson = null;
    for (const url of runEndpoints) {
        try {
            const res = await fetch(url, { headers });
            if (res.ok) {
                runJson = await res.json();
                console.log('Fetched run via', url);
                break;
            } else {
                const text = await res.text();
                console.log('Endpoint', url, 'returned', res.status, text.slice(0, 200));
            }
        } catch (e) {
            console.log('Request to', url, 'failed:', e?.message || e);
        }
    }
    if (!runJson) {
        console.error('Could not fetch run from any known endpoint');
        process.exit(2);
    }
    // try to find dataset id in common locations
    const datasetId = runJson.defaultDatasetId || runJson.data?.defaultDatasetId || runJson.data?.datasetId || runJson.defaultDatasetId;
    if (!datasetId) {
        console.error('Could not find dataset id in run response. Dumping run keys:', Object.keys(runJson));
        console.error(JSON.stringify(runJson, null, 2));
        process.exit(3);
    }

    console.log('Found dataset id:', datasetId);

    // Fetch dataset items (JSON)
    const itemsUrl = `https://api.apify.com/v2/datasets/${encodeURIComponent(datasetId)}/items?format=json&clean=true&limit=10000`;
    const itemsRes = await fetch(itemsUrl, { headers });
    if (!itemsRes.ok) {
        console.error('Failed to fetch dataset items:', itemsRes.status, await itemsRes.text());
        process.exit(4);
    }
    const items = await itemsRes.json();

    const outDir = path.join('storage', 'datasets');
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `${datasetId}.json`);
    await fs.writeFile(outPath, JSON.stringify(items, null, 2), 'utf8');

    console.log(`Saved ${items.length} items to ${outPath}`);
}

main().catch(err => { console.error(err); process.exit(10); });
