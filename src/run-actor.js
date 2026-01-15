import 'dotenv/config';
import pkg from 'apify-client';

let ApifyClient;
if (typeof pkg === 'function') {
    ApifyClient = pkg;
} else if (pkg && pkg.ApifyClient) {
    ApifyClient = pkg.ApifyClient;
} else if (pkg && pkg.default) {
    if (typeof pkg.default === 'function') ApifyClient = pkg.default;
    else if (pkg.default.ApifyClient) ApifyClient = pkg.default.ApifyClient;
}

if (!ApifyClient) {
    console.error('Could not find `ApifyClient` export in apify-client. Debug keys:',
        Object.keys(pkg || {}), pkg && pkg.default ? Object.keys(pkg.default) : undefined);
    process.exit(1);
}

async function main() {
    const token = process.env.APIFY_TOKEN;
    if (!token) {
        console.error('Missing APIFY_TOKEN in environment. See .env.example');
        process.exit(1);
    }
    if (token === 'YOUR-APIFY-TOKEN' || /your[-_ ]?apify|your[-_ ]?token/i.test(token)) {
        console.error('APIFY_TOKEN looks like a placeholder. Please set a valid token in .env or the environment.');
        process.exit(1);
    }

    const client = new ApifyClient({ token });

    try {
        const startUrl = process.env.START_URL || 'https://my.apify.com/actors/aG6J8PgAW1ve7qkfd';
        const maxPages = parseInt(process.env.MAX_CRAWL_PAGES || '10', 10);

        console.log(`Calling actor with startUrl=${startUrl} maxCrawlPages=${maxPages}`);

        // Rich pageFunction: extract metadata, headings, links, images and text snippet
        const pageFunction = `async function pageFunction(context) {
            const { request } = context;
            try {
                const onPage = typeof document !== 'undefined';
                const title = onPage ? document.title : (await context.page.title());
                const url = request.url || (onPage ? location.href : '');
                const meta = {};
                if (onPage) {
                    document.querySelectorAll('meta[name], meta[property], meta[content]').forEach(m => {
                        const name = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('itemprop');
                        if (name) meta[name] = m.getAttribute('content') || m.getAttribute('value') || '';
                    });
                } else {
                    try { Object.assign(meta, await context.page.evaluate(() => {
                        const out = {};
                        document.querySelectorAll('meta[name], meta[property], meta[itemprop]').forEach(m => {
                            const name = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('itemprop');
                            if (name) out[name] = m.getAttribute('content') || m.getAttribute('value') || '';
                        });
                        return out;
                    })); } catch(e){}
                }

                const headings = onPage
                    ? Array.from(document.querySelectorAll('h1, h2, h3')).map(h => ({ tag: h.tagName, text: h.innerText.trim() }))
                    : await context.page.evaluate(() => Array.from(document.querySelectorAll('h1, h2, h3')).map(h => ({ tag: h.tagName, text: h.innerText.trim() })));

                const links = onPage
                    ? Array.from(document.querySelectorAll('a[href]')).slice(0, 50).map(a => ({ href: a.href, text: a.innerText.trim() }))
                    : await context.page.evaluate(() => Array.from(document.querySelectorAll('a[href]')).slice(0,50).map(a => ({ href: a.href, text: a.innerText.trim() })));

                const images = onPage
                    ? Array.from(document.querySelectorAll('img')).slice(0, 50).map(i => ({ src: i.src, alt: i.alt }))
                    : await context.page.evaluate(() => Array.from(document.querySelectorAll('img')).slice(0,50).map(i => ({ src: i.src, alt: i.alt })));

                const bodyText = onPage
                    ? (document.body?.innerText || '').slice(0, 2000)
                    : await context.page.evaluate(() => document.body?.innerText?.slice(0,2000) || '');

                return { title, url, meta, headings, links, images, textSnippet: bodyText };
            } catch (e) {
                return { error: String(e) };
            }
        }`;

        const run = await client.actor('apify/web-scraper').call({
            startUrls: [{ url: startUrl }],
            maxCrawlPages: maxPages,
            pageFunction,
        });

        console.log('Actor started. Run ID:', run.data?.id || run.id || run);
        console.log('You can view run details at:', `https://my.apify.com/runs/${run.data?.id || run.id}`);
    } catch (err) {
        console.error('Actor call failed:', err?.message || err);
        process.exit(2);
    }
}

main();
