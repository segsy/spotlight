// main.js
import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler } from 'crawlee';

// Simple sentiment analyzer (tiny lexicon) to avoid extra deps.
function analyzeSentiment(text) {
    if (!text) return { score: 0, comparative: 0 };
    const pos = ['good', 'great', 'excellent', 'love', 'like', 'awesome', 'happy', 'positive', 'best'];
    const neg = ['bad', 'terrible', 'hate', 'awful', 'angry', 'sad', 'negative', 'worse', 'worst'];
    const words = String(text).toLowerCase().split(/\W+/).filter(Boolean);
    let score = 0;
    for (const w of words) {
        if (pos.includes(w)) score++;
        if (neg.includes(w)) score--;
    }
    return { score, comparative: score / Math.max(1, words.length) };
}

function platformFromUrl(url) {
    if (!url || typeof url !== 'string') return 'web';
    const u = url.toLowerCase();
    if (u.includes('reddit.com')) return 'reddit';
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube';
    if (u.includes('instagram.com')) return 'instagram';
    return 'blog';
}

function normalizeStartUrls(startUrls) {
    // Accept: ["https://..."] OR [{ url: "https://..." }] OR requestListSources shape
    if (!Array.isArray(startUrls)) return [];
    const urls = [];
    for (const item of startUrls) {
        if (typeof item === 'string') urls.push(item);
        else if (item && typeof item.url === 'string') urls.push(item.url);
        else if (item && typeof item.requestsFromUrl === 'string') {
            // requestListSources can include "requestsFromUrl" sources; Crawlee handles that,
            // but for simplicity we keep only direct urls here.
        }
    }
    return urls.filter(Boolean);
}

Actor.main(async () => {
    const input = (await Actor.getInput()) ?? {};
    const {
        startUrls = [{ url: 'https://www.reddit.com/r/programming/' }],
        maxRequestsPerCrawl = 100,
    } = input;

    const urls = normalizeStartUrls(startUrls);

    if (urls.length === 0) {
        throw new Error('`startUrls` must include at least one valid URL (string or { url }).');
    }

    // Create proxy config only on Apify platform
    let proxyConfiguration = null;
    if (Actor.isAtHome?.()) {
        proxyConfiguration = await Actor.createProxyConfiguration();
    } else {
        Actor.log.info('Running locally - skipping proxy configuration');
    }

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
        await Actor.pushData(item);
    }

    const cheerioUrls = urls.filter((u) => {
        const p = platformFromUrl(u);
        return p === 'reddit' || p === 'blog';
    });

    if (cheerioUrls.length) {
        const crawler = new CheerioCrawler({
            proxyConfiguration,
            maxRequestsPerCrawl,

            async requestHandler({ enqueueLinks, request, $, log }) {
                log.info('Cheerio: processing', { url: request.url });

                const platform = platformFromUrl(request.url);
                const title = $('title').text() || $('h1').first().text() || null;

                const body =
                    $('article').text() ||
                    $('[data-test-id="post-content"]').text() ||
                    $('body').text() ||
                    null;

                let comments = [];
                if (platform === 'reddit') {
                    $('div[data-testid="comment"]').each((_, el) => {
                        const t = $(el).text().trim();
                        if (t) comments.push(t.slice(0, 20000));
                    });
                }

                await saveItem({
                    url: request.url,
                    title,
                    text: comments.join('\n\n') || body || '',
                    platform,
                    extra: { commentsCount: comments.length },
                });

                // Be careful: '**/*' can explode to whole-site crawling.
                // Keep it tighter or let users control it.
                await enqueueLinks({
                    selector: 'a',
                    globs: ['http?(s)://**'],
                }).catch((err) => log.warning('enqueueLinks failed', { error: err?.message }));
            },

            failedRequestHandler({ request, error, log }) {
                log.error('Cheerio request failed', { url: request.url, error: error?.message });
            },
        });

        await crawler.run(cheerioUrls);
    }

    const playwrightUrls = urls.filter((u) => {
        const p = platformFromUrl(u);
        return p === 'youtube' || p === 'instagram';
    });

    if (playwrightUrls.length) {
        const pwCrawler = new PlaywrightCrawler({
            proxyConfiguration,
            maxRequestsPerCrawl,
            launchContext: { launchOptions: { headless: true } },

            async requestHandler({ page, request, enqueueLinks, log }) {
                log.info('Playwright: processing', { url: request.url });
                const platform = platformFromUrl(request.url);

                if (platform === 'youtube') {
                    await page.waitForSelector('ytd-comment-thread-renderer', { timeout: 8000 }).catch(() => null);
                    const comments = await page.$$eval(
                        'ytd-comment-renderer #content-text',
                        (els) => els.map((e) => e.textContent?.trim()).filter(Boolean),
                    );
                    await saveItem({
                        url: request.url,
                        title: await page.title(),
                        text: comments.join('\n\n'),
                        platform,
                        extra: { commentsCount: comments.length },
                    });
                } else if (platform === 'instagram') {
                    await page.waitForSelector('article', { timeout: 8000 }).catch(() => null);
                    const comments = await page.$$eval(
                        'ul li > div > div > div > span',
                        (els) => els.map((e) => e.textContent?.trim()).filter(Boolean),
                    );
                    await saveItem({
                        url: request.url,
                        title: await page.title(),
                        text: comments.join('\n\n'),
                        platform,
                        extra: { commentsCount: comments.length },
                    });
                } else {
                    await saveItem({
                        url: request.url,
                        title: await page.title(),
                        text: await page.content(),
                        platform,
                    });
                }

                await enqueueLinks({
                    selector: 'a',
                    globs: ['http?(s)://**'],
                }).catch((err) => log.warning('Playwright enqueueLinks failed', { error: err?.message }));
            },

            failedRequestHandler({ request, error, log }) {
                log.error('Playwright request failed', { url: request.url, error: error?.message });
            },
        });

        await pwCrawler.run(playwrightUrls);
    }

    Actor.log.info('Done.');
});
