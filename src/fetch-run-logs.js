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

    const headers = { Authorization: `Bearer ${token}`, Accept: '*/*' };

    const runUrl = `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}`;
    const runRes = await fetch(runUrl, { headers });
    if (!runRes.ok) {
        console.error('Failed to fetch run details:', runRes.status, await runRes.text());
        process.exit(2);
    }
    const runJson = await runRes.json();

    const outDir = path.join('storage', 'key_value_stores', 'default');
    await fs.mkdir(outDir, { recursive: true });
    const runOutPath = path.join(outDir, `${runId}_run.json`);
    await fs.writeFile(runOutPath, JSON.stringify(runJson, null, 2), 'utf8');
    console.log('Saved run details to', runOutPath);

    const logsEndpoints = [
        `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}/logs?format=json`,
        `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}/logs?format=txt`,
        `https://api.apify.com/v2/actor-runs/${encodeURIComponent(runId)}/logs`,
        `https://api.apify.com/v2/runs/${encodeURIComponent(runId)}/logs?format=json`,
    ];

    for (const url of logsEndpoints) {
        try {
            const res = await fetch(url, { headers });
            if (!res.ok) {
                console.log('Logs endpoint', url, 'returned', res.status);
                continue;
            }
            const contentType = res.headers.get('content-type') || '';
            if (contentType.includes('application/json')) {
                const data = await res.json();
                const outPath = path.join(outDir, `${runId}_logs.json`);
                await fs.writeFile(outPath, JSON.stringify(data, null, 2), 'utf8');
                console.log('Saved logs (json) to', outPath);
                return;
            } else {
                const text = await res.text();
                const outPath = path.join(outDir, `${runId}_logs.txt`);
                await fs.writeFile(outPath, text, 'utf8');
                console.log('Saved logs (text) to', outPath);
                return;
            }
        } catch (e) {
            console.log('Request to', url, 'failed:', e?.message || e);
        }
    }

    console.log('No logs were found at known endpoints. Run details saved.');
}

main().catch(err => { console.error(err); process.exit(10); });
