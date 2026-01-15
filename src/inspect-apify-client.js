import 'dotenv/config';
import pkg from 'apify-client';

let ApifyClient;
if (typeof pkg === 'function') ApifyClient = pkg;
else if (pkg && pkg.ApifyClient) ApifyClient = pkg.ApifyClient;
else if (pkg && pkg.default) {
    if (typeof pkg.default === 'function') ApifyClient = pkg.default;
    else if (pkg.default.ApifyClient) ApifyClient = pkg.default.ApifyClient;
}

async function main() {
    const token = process.env.APIFY_TOKEN;
    const runId = process.env.RUN_ID;
    if (!token || !runId) {
        console.error('Set APIFY_TOKEN and RUN_ID in environment');
        process.exit(1);
    }
    const client = new ApifyClient({ token });

    console.log('Client keys:', Object.keys(client));
    console.log('client.runs keys:', client.runs ? Object.keys(client.runs) : 'no runs');

    const tries = [
        async () => ({ name: 'runs.get', fn: client.runs.get, res: await client.runs.get({ runId }) }),
        async () => ({ name: 'runs.getRun', fn: client.runs.getRun, res: await client.runs.getRun({ runId }) }),
        async () => ({ name: 'runs.getRunRaw', fn: client.runs.getRunRaw, res: await client.runs.getRunRaw(runId) }),
        async () => ({ name: 'runs.get({ runId }) alt', fn: client.runs.get, res: await client.runs.get(runId) }),
    ];

    for (const t of tries) {
        try {
            const out = await t();
            console.log(`Success: ${out.name}`);
            console.log(Object.keys(out.res || {}));
            console.log(JSON.stringify(out.res?.data || out.res, null, 2).slice(0, 1000));
            return;
        } catch (e) {
            console.log('Attempt failed:', e?.message || e);
        }
    }
    console.error('All attempts failed');
}

main().catch(e => { console.error(e); process.exit(99); });
