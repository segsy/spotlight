// src/main.js
import { Actor } from 'apify';
import { CheerioCrawler, PlaywrightCrawler } from 'crawlee';

// ----------------------------
// Safe logger (never throws)
// ----------------------------
const L = {
  info: (msg, data) => {
    try { if (Actor?.log?.info) return Actor.log.info(msg, data); } catch {}
    console.log(msg, data ?? '');
  },
  warning: (msg, data) => {
    try { if (Actor?.log?.warning) return Actor.log.warning(msg, data); } catch {}
    console.warn(msg, data ?? '');
  },
  error: (msg, data) => {
    try { if (Actor?.log?.error) return Actor.log.error(msg, data); } catch {}
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

function computeKeywordStats(texts, keywords) {
  const keys = (keywords || [])
    .map((k) => String(k || '').trim())
    .filter(Boolean)
    .slice(0, 25);

  const stats = {};
  for (const k of keys) stats[k] = { mentions: 0, sentimentSum: 0, comparativeSum: 0 };

  for (const t of texts) {
    const text = String(t || '');
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
    startUrls = [{ url: 'https://www.reddit.com/r/programming/' }],
    platforms = ['youtube', 'instagram', 'reddit', 'blog'],
    maxRequestsPerCrawl = 50,

    // ✅ Requested: output posts+count and comments+count
    maxPostsPerSource = 15,
    maxCommentsPerPost = 50,

    // Optional: keyword sentiment
    keywords = [],

    // Throttling
    maxConcurrency = 1,
    sameDomainDelaySecs = 6,

    // Proxy
    proxyGroups = ['RESIDENTIAL'],
    proxyCountryCode = null,
  } = input;

  // Normalize URLs
  let urls = normalizeStartUrls(startUrls)
    .filter(isHttpUrl)
    .map((u) => u.trim())
    .filter((u) => !isGarbageUrl(u))
    .map((u) => (platformFromUrl(u) === 'youtube' ? toCanonicalYouTube(u) : u));

  // ✅ Deduplicate startUrls so you don't get 3 identical output rows
  urls = [...new Set(urls)];

  if (!urls.length) {
    throw new Error('No valid startUrls. Remove Google login/support URLs and provide actual page URLs.');
  }

  // Filter by requested platforms
  const wanted = new Set((platforms || []).map((p) => String(p).toLowerCase()));
  urls = urls.filter((u) => {
    const p = platformFromUrl(u);
    return wanted.has(p) || (p === 'blog' && wanted.has('blog'));
  });

  // ✅ Enable Apify Proxy
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

  // ✅ Safe enqueue helper
  const safeEnqueue = async (enqueueLinks) => {
    if (typeof enqueueLinks !== 'function') return;
    try {
      await enqueueLinks({ selector: 'a', globs: ['http://**/*', 'https://**/*'] });
    } catch (e) {
      L.warning('enqueueLinks failed', { error: e?.message || String(e) });
    }
  };

  // ✅ Always guarantee posts/comments arrays + counts in output
  async function saveResult({
    platform,
    url,
    title,
    posts = [],
    comments = [],
    keywordStats = null,
    blocked = false,
    blockReason = null,
    extra = {},
  }) {
    const safePosts = Array.isArray(posts) ? posts : [];
    const safeComments = Array.isArray(comments) ? comments : [];

    const allTextForSentiment = [
      title || '',
      ...safePosts.map((p) => p?.title || p?.text || ''),
      ...safeComments.map((c) => c?.text || c || ''),
    ]
      .join('\n')
      .slice(0, 20000);

    await Actor.pushData({
      platform,
      url,
      title: title || null,

      posts: safePosts,
      postsCount: safePosts.length,

      comments: safeComments,
      commentsCount: safeComments.length,

      keywordStats,
      blocked: !!blocked,
      blockReason: blockReason || null,

      sentimentPlaceholder: analyzeSentiment(allTextForSentiment),
      scrapedAt: new Date().toISOString(),
      ...extra,
    });
  }

  // ----------------------------
  // Cheerio: Reddit + Blogs
  // ----------------------------
  const cheerioUrls = urls.filter((u) => ['reddit', 'blog'].includes(platformFromUrl(u)));

  if (cheerioUrls.length) {
    const cheerio = new CheerioCrawler({
      proxyConfiguration,
      maxRequestsPerCrawl,

      async requestHandler({ request, $, log, enqueueLinks }) {
        const url = request.url;
        const platform = platformFromUrl(url);

        log.info('Cheerio: processing', { url, platform });

        const pageTitle = $('title').text().trim() || $('h1').first().text().trim() || null;

        // ✅ POSTS extraction (best-effort)
        const posts = [];
        if (platform === 'reddit') {
          $('a[data-click-id="body"]').each((_, el) => {
            const t = $(el).text().trim();
            const href = $(el).attr('href') || '';
            if (!t) return;
            const full = href.startsWith('http') ? href : `https://www.reddit.com${href}`;
            posts.push({ title: t, url: full });
          });
        } else {
          $('h1,h2').each((_, el) => {
            const t = $(el).text().trim();
            if (t) posts.push({ title: t });
          });
        }

        // ✅ COMMENTS extraction (best-effort)
        const comments = [];
        $('[data-testid="comment"], .comment, #comments .comment').each((_, el) => {
          const t = $(el).text().trim();
          if (t) comments.push({ text: t.slice(0, 2000) });
        });

        const limitedPosts = posts.slice(0, maxPostsPerSource);
        const limitedComments = comments.slice(0, maxCommentsPerPost);

        const keywordStats = keywords?.length
          ? computeKeywordStats(limitedComments.map((c) => c.text), keywords)
          : null;

        await saveResult({
          platform,
          url,
          title: pageTitle,
          posts: limitedPosts,
          comments: limitedComments,
          keywordStats,
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
  // Playwright: YouTube + Instagram
  // ----------------------------
  const playwrightUrls = urls.filter((u) => ['youtube', 'instagram'].includes(platformFromUrl(u)));

  if (playwrightUrls.length) {
    const pw = new PlaywrightCrawler({
      proxyConfiguration,
      maxRequestsPerCrawl,

      maxConcurrency: Math.max(1, Number(maxConcurrency) || 1),
      sameDomainDelaySecs: Math.max(0, Number(sameDomainDelaySecs) || 0),

      navigationTimeoutSecs: 60,
      requestHandlerTimeoutSecs: 180,
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

      async requestHandler({ page, request, log }) {
        const url = request.url;
        const platform = platformFromUrl(url);
        log.info('Playwright: processing', { url, platform });

        const response = await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);
        const block = await detectBlocked({ page, response });
        const title = await page.title().catch(() => null);

        if (block.blocked) {
          // Still output required fields even when blocked
          await saveResult({
            platform,
            url,
            title,
            posts: [{ title: title || `${platform} page`, url }],
            comments: [],
            blocked: true,
            blockReason: block.reason,
          });
          throw new Error(`Blocked: ${block.reason}`);
        }

        // ✅ YouTube: posts + comments + counts
        if (platform === 'youtube') {
          const posts = [{ title: title || 'YouTube Video', url }];

          // additional posts from same channel (best-effort)
          let channelUrl = null;
          try {
            const a = (await page.$('ytd-channel-name a')) || (await page.$('ytd-video-owner-renderer a'));
            const href = a ? await a.getAttribute('href') : null;
            if (href) channelUrl = href.startsWith('http') ? href : `https://www.youtube.com${href}`;
          } catch {}

          if (channelUrl) {
            const videosTab = channelUrl.replace(/\/$/, '') + '/videos';
            try {
              await page.goto(videosTab, { waitUntil: 'domcontentloaded' });
              await page.waitForTimeout(1200);

              const items = await page.$$eval('a#video-title', (els) =>
                els
                  .map((e) => ({
                    title: (e.getAttribute('title') || e.textContent || '').trim(),
                    href: e.getAttribute('href') || '',
                  }))
                  .filter((x) => x.href && (x.href.startsWith('/watch') || x.href.startsWith('/shorts')))
              );

              for (const it of items.slice(0, maxPostsPerSource)) {
                posts.push({
                  title: it.title || 'YouTube Video',
                  url: it.href.startsWith('http') ? it.href : `https://www.youtube.com${it.href}`,
                });
              }
            } catch (e) {
              L.warning('Failed to fetch channel videos', { channelUrl, error: e?.message || String(e) });
            }
          }

          // return to original video to load comments
          await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => null);
          await page.waitForTimeout(1000);

          for (let i = 0; i < 5; i++) {
            await page.mouse.wheel(0, 1400);
            await page.waitForTimeout(1200);
          }

          const commentNodes = await page.$$('ytd-comment-renderer #content-text');
          const comments = [];
          for (const n of commentNodes.slice(0, maxCommentsPerPost)) {
            const t = (await n.textContent())?.trim();
            if (t) comments.push({ text: t });
          }

          const keywordStats = keywords?.length ? computeKeywordStats(comments.map((c) => c.text), keywords) : null;

          await saveResult({
            platform: 'youtube',
            url,
            title,
            posts: posts.slice(0, maxPostsPerSource),
            comments,
            keywordStats,
            extra: { channelUrl: channelUrl || null },
          });

          return;
        }

        // ✅ Instagram: posts + comments + counts (best-effort)
        if (platform === 'instagram') {
          const posts = [{ title: title || 'Instagram Post/Profile', url }];

          await page.waitForTimeout(1500);

          // best-effort visible "comments"/text
          const nodes = await page.$$('article span');
          const texts = [];
          for (const n of nodes.slice(0, maxCommentsPerPost)) {
            const t = (await n.textContent())?.trim();
            if (t) texts.push(t);
          }

          const comments = texts.map((t) => ({ text: t }));

          const keywordStats = keywords?.length ? computeKeywordStats(texts, keywords) : null;

          await saveResult({
            platform: 'instagram',
            url,
            title,
            posts,
            comments,
            keywordStats,
          });

          return;
        }
      },

      failedRequestHandler({ request }, error) {
        L.error('Playwright request failed', { url: request.url, error: error?.message || String(error) });
      },
    });

    await pw.run(playwrightUrls);
  }

  L.info('Done.');
});
