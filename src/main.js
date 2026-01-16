// src/main.js
import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler } from 'crawlee';

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
  if (!Array.isArray(startUrls)) return [];
  const urls = [];
  for (const item of startUrls) {
    if (typeof item === 'string') urls.push(item);
    else if (item && typeof item.url === 'string') urls.push(item.url);
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

  // Proxy (safe)
  let proxyConfiguration = null;
  if (Actor.isAtHome?.()) {
    try {
      proxyConfiguration = await Actor.createProxyConfiguration();
    } catch (e) {
      Actor.log.warning('Proxy configuration failed; continuing without proxy.', { error: e?.message });
      proxyConfiguration = null;
    }
  } else {
    Actor.log.info('Running locally - skipping proxy configuration');
  }

  async function saveItem({ url, title, text, platform, extra = {} }) {
    const sentiment = analyzeSentiment(text || title || '');
    await Actor.pushData({
      platform,
      url,
      title: title || null,
      text: (text || '').trim().slice(0, 20000),
      sentimentPlaceholder: sentiment,
      scrapedAt: new Date().toISOString(),
      ...(extra || {}),
    });
  }

  // Use safe globs + safe logger
  const safeEnqueue = async (enqueueLinks) => {
    try {
      await enqueueLinks({
        selector: 'a',
        globs: ['http://**/*', 'https://**/*'],
      });
    } catch (e) {
      Actor.log.warning('enqueueLinks failed', { error: e?.message });
    }
  };

  // -------------------------
  // CheerioCrawler (static)
  // -------------------------
  const cheerioUrls = urls.filter((u) => ['reddit', 'blog'].includes(platformFromUrl(u)));

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
          '';

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
          text: comments.join('\n\n') || body,
          platform,
          extra: { commentsCount: comments.length },
        });

        await safeEnqueue(enqueueLinks);
      },

      // ✅ NEW Crawlee v3 signature: (context, error)
      failedRequestHandler({ request }, error) {
        Actor.log.error('Cheerio request failed', {
          url: request.url,
          error: error?.message || String(error),
        });
      },
    });

    await crawler.run(cheerioUrls);
  }

  // -------------------------
  // PlaywrightCrawler (dynamic)
  // -------------------------
  const playwrightUrls = urls.filter((u) => ['youtube', 'instagram'].includes(platformFromUrl(u)));

  if (playwrightUrls.length) {
    const pwCrawler = new PlaywrightCrawler({
      proxyConfiguration,
      maxRequestsPerCrawl,

      // Helps reduce rate-limits a bit (especially IG)
      maxConcurrency: 1,
      sameDomainDelaySecs: 5,

      launchContext: { launchOptions: { headless: true } },

      async requestHandler({ page, request, enqueueLinks, log }) {
        log.info('Playwright: processing', { url: request.url });
        const platform = platformFromUrl(request.url);

        if (platform === 'youtube') {
          await page.waitForSelector('ytd-comment-thread-renderer', { timeout: 8000 }).catch(() => null);

          const nodes = await page.$$('ytd-comment-renderer #content-text');
          const comments = [];
          for (const n of nodes.slice(0, 50)) {
            const t = (await n.textContent())?.trim();
            if (t) comments.push(t);
          }

          await saveItem({
            url: request.url,
            title: await page.title(),
            text: comments.join('\n\n'),
            platform,
            extra: { commentsCount: comments.length },
          });
        } else if (platform === 'instagram') {
          await page.waitForSelector('article', { timeout: 8000 }).catch(() => null);

          const nodes = await page.$$('ul li > div > div > div > span');
          const comments = [];
          for (const n of nodes.slice(0, 50)) {
            const t = (await n.textContent())?.trim();
            if (t) comments.push(t);
          }

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

        await safeEnqueue(enqueueLinks);
      },

      // ✅ NEW Crawlee v3 signature: (context, error)
      failedRequestHandler({ request }, error) {
        Actor.log.error('Playwright request failed', {
          url: request.url,
          error: error?.message || String(error),
        });
      },
    });

    await pwCrawler.run(playwrightUrls);
  }

  Actor.log.info('Done.');
});
