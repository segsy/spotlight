// src/main.js
import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler } from 'crawlee';

// ----------------------------
// Safe logger (never throws)
// ----------------------------
const L = {
  info: (msg, data) => {
    try {
      if (Actor?.log?.info) return Actor.log.info(msg, data);
    } catch {}
    console.log(msg, data ?? '');
  },
  warning: (msg, data) => {
    try {
      if (Actor?.log?.warning) return Actor.log.warning(msg, data);
    } catch {}
    console.warn(msg, data ?? '');
  },
  error: (msg, data) => {
    try {
      if (Actor?.log?.error) return Actor.log.error(msg, data);
    } catch {}
    console.error(msg, data ?? '');
  },
};

// ----------------------------
// Tiny sentiment helper (lexicon)
// ----------------------------
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

function computeKeywordStats(comments, keywords) {
  const keys = (keywords || [])
    .map((k) => String(k || '').trim())
    .filter(Boolean)
    .slice(0, 25);

  const stats = {};
  for (const k of keys) stats[k] = { mentions: 0, sentimentSum: 0, comparativeSum: 0 };

  for (const c of comments) {
    const text = String(c || '');
    const low = text.toLowerCase();
    for (const k of keys) {
      if (low.includes(k.toLowerCase())) {
        const s = analyzeSentiment(text);
        stats[k].mentions += 1;
        stats[k].sentimentSum += s.score;
        stats[k].comparativeSum += s.comparative;
      }
    }
  }

  for (const k of keys) {
    const m = stats[k].mentions || 0;
    stats[k] = {
      mentions: m,
      avgScore: m ? stats[k].sentimentSum / m : 0,
      avgComparative: m ? stats[k].comparativeSum / m : 0,
    };
  }
  return stats;
}

// ----------------------------
// URL helpers
// ----------------------------
function normalizeStartUrls(startUrls) {
  if (!Array.isArray(startUrls)) return [];
  const urls = [];
  for (const item of startUrls) {
    if (typeof item === 'string') urls.push(item);
    else if (item && typeof item.url === 'string') urls.push(item.url);
  }
  return urls.filter(Boolean);
}

function isHttpUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
}

function isGarbageUrl(u) {
  try {
    const x = new URL(u);
    const h = x.hostname.replace(/^www\./, '');
    if (h === 'accounts.google.com') return true;
    if (h === 'support.google.com') return true;
    if ((h === 'youtube.com' || h === 'm.youtube.com') && (x.pathname === '/' || x.pathname === '')) return true;
    return false;
  } catch {
    return true;
  }
}

function platformFromUrl(url) {
  if (!url || typeof url !== 'string') return 'web';
  const low = url.toLowerCase();
  if (low.includes('reddit.com')) return 'reddit';
  if (low.includes('youtube.com') || low.includes('youtu.be')) return 'youtube';
  if (low.includes('instagram.com')) return 'instagram';
  return 'blog';
}

function isYouTubeUrl(u) {
  try {
    const x = new URL(u);
    const h = x.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') return true;
    if (h !== 'youtube.com' && h !== 'm.youtube.com') return false;
    return (
      x.pathname.startsWith('/watch') ||
      x.pathname.startsWith('/shorts') ||
      x.pathname.startsWith('/channel/') ||
      x.pathname.startsWith('/@') ||
      x.pathname.startsWith('/user/')
    );
  } catch {
    return false;
  }
}

function isInstagramUrl(u) {
  try {
    const x = new URL(u);
    const h = x.hostname.replace(/^www\./, '');
    if (h !== 'instagram.com' && h !== 'www.instagram.com') return false;
    return (
      /^\/[A-Za-z0-9._]+\/?$/.test(x.pathname) ||
      x.pathname.startsWith('/reel/') ||
      x.pathname.startsWith('/p/') ||
      x.pathname.startsWith('/tv/')
    );
  } catch {
    return false;
  }
}

function toCanonicalYouTube(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') {
      const id = u.pathname.replace('/', '');
      const out = new URL('https://www.youtube.com/watch');
      out.searchParams.set('v', id);
      return out.toString();
    }
    return url;
  } catch {
    return url;
  }
}

// Detect blocks by status or page content
async function detectBlocked({ page, response }) {
  const status = response?.status?.() ?? null;
  if (status === 403 || status === 429) return { blocked: true, reason: `HTTP ${status}` };

  try {
    const url = page.url();
    if (url.includes('sorry') || url.includes('consent') || url.includes('captcha')) {
      return { blocked: true, reason: `Redirected to ${url}` };
    }
    const html = await page.content();
    const lower = html.toLowerCase();
    if (
      lower.includes('unusual traffic') ||
      lower.includes('verify you are a human') ||
      lower.includes('captcha') ||
      lower.includes('consent') ||
      lower.includes('sign in to continue')
    ) {
      return { blocked: true, reason: 'Bot/verification page detected' };
    }
  } catch {
    // ignore
  }

  return { blocked: false, reason: null };
}

// ----------------------------
// Main
// ----------------------------
Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {};

  const {
    startUrls = [{ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }],
    platforms = ['youtube', 'instagram', 'reddit', 'blog'],
    maxRequestsPerCrawl = 30,

    keywords = [],
    maxCommentsPerPage = 80,
    maxRelatedVideos = 6,

    maxConcurrency = 1,
    sameDomainDelaySecs = 6,

    proxyGroups = ['RESIDENTIAL'],
    proxyCountryCode = null,
  } = input;

  let urls = normalizeStartUrls(startUrls)
    .filter(isHttpUrl)
    .map((u) => u.trim())
    .filter((u) => !isGarbageUrl(u));

  const wanted = new Set((platforms || []).map((p) => String(p).toLowerCase()));
  urls = urls.filter((u) => {
    const p = platformFromUrl(u);
    if (!wanted.size) return true;
    if (p === 'youtube') return wanted.has('youtube') && isYouTubeUrl(u);
    if (p === 'instagram') return wanted.has('instagram') && isInstagramUrl(u);
    if (p === 'reddit') return wanted.has('reddit');
    if (p === 'blog') return wanted.has('blog');
    return false;
  });

  urls = urls.map((u) => (isYouTubeUrl(u) ? toCanonicalYouTube(u) : u));

  if (urls.length === 0) {
    throw new Error(
      'No valid startUrls after filtering. Provide YouTube watch/shorts/channel URLs and/or Instagram reel/post/profile URLs. Avoid accounts.google.com links.'
    );
  }

  // ✅ Enable Apify Proxy (safe)
  let proxyConfiguration = null;
  if (Actor.isAtHome?.()) {
    try {
      const cfg = {
        groups: Array.isArray(proxyGroups) && proxyGroups.length ? proxyGroups : ['RESIDENTIAL'],
      };
      if (proxyCountryCode && typeof proxyCountryCode === 'string') cfg.countryCode = proxyCountryCode;

      proxyConfiguration = await Actor.createProxyConfiguration(cfg);

      L.info('Apify Proxy enabled', {
        usesApifyProxy: proxyConfiguration?.usesApifyProxy,
        groups: proxyConfiguration?.groups,
        countryCode: proxyCountryCode || null,
      });
    } catch (e) {
      L.warning('Failed to initialize Apify Proxy. Continuing without proxy.', { error: e?.message || String(e) });
      proxyConfiguration = null;
    }
  } else {
    L.info('Running locally — Apify Proxy disabled');
  }

  async function saveItem(item) {
    await Actor.pushData({
      ...item,
      scrapedAt: new Date().toISOString(),
    });
  }

  // Safe enqueue helper
  const safeEnqueue = async (enqueueLinks) => {
    if (typeof enqueueLinks !== 'function') return;
    try {
      await enqueueLinks({
        selector: 'a',
        globs: ['http://**/*', 'https://**/*'],
      });
    } catch (e) {
      L.warning('enqueueLinks failed', { error: e?.message || String(e) });
    }
  };

  // ----------------------------
  // Cheerio for reddit/blog
  // ----------------------------
  const cheerioUrls = urls.filter((u) => ['reddit', 'blog'].includes(platformFromUrl(u)));
  if (cheerioUrls.length) {
    const cheerio = new CheerioCrawler({
      proxyConfiguration,
      maxRequestsPerCrawl,

      async requestHandler({ request, $, log, enqueueLinks }) {
        log.info('Cheerio: processing', { url: request.url });

        const title = $('title').text() || $('h1').first().text() || null;
        const body = ($('article').text() || $('body').text() || '').slice(0, 20000);

        await saveItem({
          platform: platformFromUrl(request.url),
          url: request.url,
          title,
          text: body,
          sentimentPlaceholder: analyzeSentiment(body || title || ''),
        });

        await safeEnqueue(enqueueLinks);
      },

      failedRequestHandler({ request }, error) {
        L.error('Cheerio request failed', { url: request.url, error: error?.message || String(error) });
      },
    });

    await cheerio.run(cheerioUrls);
  }

  // ----------------------------
  // Playwright for YouTube/Instagram
  // ----------------------------
  const playwrightUrls = urls.filter((u) => ['youtube', 'instagram'].includes(platformFromUrl(u)));
  if (playwrightUrls.length) {
    const pw = new PlaywrightCrawler({
      proxyConfiguration,
      maxRequestsPerCrawl,

      maxConcurrency: Math.max(1, Number(maxConcurrency) || 1),
      sameDomainDelaySecs: Math.max(0, Number(sameDomainDelaySecs) || 0),

      navigationTimeoutSecs: 60,
      requestHandlerTimeoutSecs: 120,
      maxRequestRetries: 2,

      launchContext: { launchOptions: { headless: true } },

      preNavigationHooks: [
        async ({ page }) => {
          await page.route('**/*', (route) => {
            const type = route.request().resourceType();
            if (['image', 'media', 'font'].includes(type)) return route.abort();
            return route.continue();
          });
        },
      ],

      async requestHandler({ page, request, log, enqueueLinks }) {
        const url = request.url;
        const platform = platformFromUrl(url);
        log.info('Playwright: processing', { url, platform });

        // Explicit navigation so we can read HTTP status
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);

        const block = await detectBlocked({ page, response });
        if (block.blocked) {
          await saveItem({
            platform,
            url,
            title: await page.title().catch(() => null),
            blocked: true,
            blockReason: block.reason,
          });
          // Throw to let Crawlee retry / mark failed
          throw new Error(`Blocked: ${block.reason}`);
        }

        if (platform === 'youtube') {
          await page.waitForTimeout(1000);
          for (let i = 0; i < 4; i++) {
            await page.mouse.wheel(0, 1200);
            await page.waitForTimeout(1200);
          }

          const title = await page.title().catch(() => null);

          const commentNodes = await page.$$('ytd-comment-renderer #content-text');
          const comments = [];
          for (const n of commentNodes.slice(0, maxCommentsPerPage)) {
            const t = (await n.textContent())?.trim();
            if (t) comments.push(t);
          }

          const keywordStats = computeKeywordStats(comments, keywords);

          let channelUrl = null;
          try {
            const a = (await page.$('ytd-channel-name a')) || (await page.$('ytd-video-owner-renderer a'));
            const href = a ? await a.getAttribute('href') : null;
            if (href) channelUrl = href.startsWith('http') ? href : `https://www.youtube.com${href}`;
          } catch {
            channelUrl = null;
          }

          let relatedVideos = [];
          if (channelUrl) {
            const videosTab = channelUrl.includes('/videos') ? channelUrl : channelUrl.replace(/\/$/, '') + '/videos';
            try {
              await page.goto(videosTab, { waitUntil: 'domcontentloaded' });
              await page.waitForTimeout(1200);

              const links = await page.$$eval('a#video-title', (els) =>
                els
                  .map((e) => ({
                    title: (e.getAttribute('title') || e.textContent || '').trim(),
                    href: e.getAttribute('href') || '',
                  }))
                  .filter((x) => x.href && (x.href.startsWith('/watch') || x.href.startsWith('/shorts')))
              );

              relatedVideos = links.slice(0, maxRelatedVideos).map((x) => ({
                title: x.title || 'Untitled video',
                url: x.href.startsWith('http') ? x.href : `https://www.youtube.com${x.href}`,
              }));
            } catch (e) {
              L.warning('Failed to fetch channel videos', { channelUrl, error: e?.message || String(e) });
            }
          }

          await saveItem({
            platform: 'youtube',
            url,
            title,
            commentsCount: comments.length,
            keywordStats,
            channelUrl,
            relatedVideos,
            sentimentPlaceholder: analyzeSentiment(comments.join('\n') || title || ''),
          });

          // optional: don’t expand for YouTube; if you want, keep it:
          // await safeEnqueue(enqueueLinks);
          return;
        }

        if (platform === 'instagram') {
          await page.waitForTimeout(1500);
          const title = await page.title().catch(() => null);

          const nodes = await page.$$('article span');
          const texts = [];
          for (const n of nodes.slice(0, maxCommentsPerPage)) {
            const t = (await n.textContent())?.trim();
            if (t) texts.push(t);
          }

          const keywordStats = computeKeywordStats(texts, keywords);

          await saveItem({
            platform: 'instagram',
            url,
            title,
            commentsCount: texts.length,
            keywordStats,
            sentimentPlaceholder: analyzeSentiment(texts.join('\n') || title || ''),
          });

          return;
        }

        await saveItem({
          platform,
          url,
          title: await page.title().catch(() => null),
          text: (await page.content().catch(() => '')).slice(0, 20000),
        });

        await safeEnqueue(enqueueLinks);
      },

      failedRequestHandler({ request }, error) {
        L.error('Playwright request failed', { url: request.url, error: error?.message || String(error) });
      },
    });

    await pw.run(playwrightUrls);
  }

  L.info('Done.');
});
