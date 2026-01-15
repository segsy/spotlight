// Apify SDK - toolkit for building Apify Actors
import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler, Dataset } from 'crawlee';


// Simple sentiment analyzer (tiny lexicon) to avoid extra deps.
function analyzeSentiment(text) {
    if (!text) return { score: 0, comparative: 0 };
    const pos = ['good', 'great', 'excellent', 'love', 'like', 'awesome', 'happy', 'positive', 'best'];
    const neg = ['bad', 'terrible', 'hate', 'awful', 'angry', 'sad', 'negative', 'worse', 'worst'];
    const words = text.toLowerCase().split(/\W+/).filter(Boolean);
    let score = 0;
    for (const w of words) {
        if (pos.includes(w)) score++;
        if (neg.includes(w)) score--;
    }
    return { score, comparative: score / Math.max(1, words.length) };
}

// Infer platform from a URL when not explicitly provided
function platformFromUrl(url) {
    if (!url || typeof url !== 'string') return 'web';
    const u = url.toLowerCase();
    if (u.includes('reddit.com')) return 'reddit';
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
    if (u.includes('instagram.com')) return 'instagram';
    return 'blog';
}

await Actor.init();

const input = (await Actor.getInput()) ?? {};
const {
    startUrls = ['https://www.reddit.com/r/programming/'],
    maxRequestsPerCrawl = 100,
    platforms = ['reddit', 'blog', 'youtube', 'instagram'],
    query = '',
    maxCommentsDepth = 3,
    sort = 'hot',
    timeFilter = 'week',
} = input;

if (!Array.isArray(startUrls) || startUrls.length === 0) {
    throw new Error('`startUrls` must be a non-empty array.');
}
// Only create proxy config when running on Apify platform
let proxyConfiguration = null;
try {
    const isAtHome = typeof Actor.isAtHome === 'function' ? Actor.isAtHome() : !!process.env.APIFY_IS_AT_HOME;
    if (isAtHome) {
        proxyConfiguration = await Actor.createProxyConfiguration();
    } else {
        console.log('Running locally - skipping proxy configuration');
        proxyConfiguration = null;
    }
} catch (err) {
    console.warn('Failed to create proxy configuration, continuing without proxy', { error: err?.message });
    proxyConfiguration = null;
}



// Helper to save items prepared for NLP processors.
async function saveItem({ url, title, text, platform, extra = {} }) {
    const sentiment = analyzeSentiment(text || title || '');
    const item = {
        platform,
        url,
        title: title || null,
        text: (text || '').trim().slice(0, 20000),
        sentimentPlaceholder: sentiment,
        scrapedAt: new Date().toISOString(),
        ...(extra || {}),
    };
    await Dataset.pushData(item);
}


// Run CheerioCrawler for static sites (blogs, Reddit listing pages)
const cheerioUrls = startUrls.filter((u) => {
    const p = platformFromUrl(u);
    return p === 'reddit' || p === 'blog';
});

if (cheerioUrls.length > 0) {
    const crawler = new CheerioCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl,
        async requestHandler({ enqueueLinks, request, $, log }) {
            log.info('Cheerio: processing', { url: request.url });

            const platform = platformFromUrl(request.url);

            // Extract title and body heuristics
            const title = $('title').text() || $('h1').first().text() || null;
            const body = $('article').text() || $('[data-test-id="post-content"]').text() || $('body').text() || null;

            // For Reddit, try to extract top-level comments from the HTML if present
            let comments = [];
            if (platform === 'reddit') {
                // Reddit's static HTML contains some comment text; this is best-effort.
                $('div[data-testid="comment"]').each((i, el) => {
                    const t = $(el).text().trim();
                    if (t) comments.push(t.slice(0, 20000));
                });
            }

            await saveItem({ url: request.url, title, text: comments.join('\n\n') || body, platform, extra: { commentsCount: comments.length } });

            try {
                await enqueueLinks({ globs: ['**/*'] });
            } catch (err) {
                log.warning('enqueueLinks failed', { error: err?.message });
            }
        },
        failedRequestHandler({ request, error, log }) {
            log.error('Cheerio request failed', { url: request.url, error: error?.message });
        },
    });
    await crawler.run(cheerioUrls);
}

// Run PlaywrightCrawler for dynamic JS-heavy sites (YouTube, Instagram)
const playwrightUrls = startUrls.filter((u) => {
    const p = platformFromUrl(u);
    return p === 'youtube' || p === 'instagram';
});

if (playwrightUrls.length > 0) {
    const pwCrawler = new PlaywrightCrawler({
        proxyConfiguration,
        maxRequestsPerCrawl,
        launchContext: {
            // default browser options; Apify images provide Playwright browsers
            launchOptions: { headless: true },
        },
        async requestHandler({ page, request, enqueueLinks, log }) {
            log.info('Playwright: processing', { url: request.url });
            const platform = platformFromUrl(request.url);

            try {
                if (platform === 'youtube') {
                    // Wait for comments section and collect visible comments (best-effort)
                    await page.waitForSelector('ytd-comment-thread-renderer', { timeout: 8000 }).catch(() => null);
                    const comments = await page.$$eval('ytd-comment-renderer #content-text', els => els.map(e => e.textContent.trim()).filter(Boolean));
                    const title = await page.title();
                    await saveItem({ url: request.url, title, text: comments.join('\n\n'), platform, extra: { commentsCount: comments.length } });
                } else if (platform === 'instagram') {
                    // Instagram requires login for many comment views; attempt public posts
                    await page.waitForSelector('article', { timeout: 8000 }).catch(() => null);
                    const title = await page.title();
                    const comments = await page.$$eval('ul li > div > div > div > span', els => els.map(e => e.textContent.trim()).filter(Boolean));
                    await saveItem({ url: request.url, title, text: comments.join('\n\n'), platform, extra: { commentsCount: comments.length } });
                } else {
                    const title = await page.title();
                    const body = await page.content();
                    await saveItem({ url: request.url, title, text: body, platform });
                }

                try {
                    await enqueueLinks({ selector: 'a', globs: ['**/*'] });
                } catch (err) {
                    log.warning('Playwright enqueueLinks failed', { error: err?.message });
                }
            } catch (err) {
                log.error('Playwright handler error', { url: request.url, error: err?.message });
            }
        },
        failedRequestHandler({ request, error, log }) {
            log.error('Playwright request failed', { url: request.url, error: error?.message });
        },
    });
    await pwCrawler.run(playwrightUrls);
}

// All done
await Actor.exit();
