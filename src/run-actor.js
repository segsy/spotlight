import 'dotenv/config';
import { ApifyClient } from 'apify-client';

async function main() {
  const token = process.env.APIFY_TOKEN;
  if (!token) throw new Error('Missing APIFY_TOKEN in environment.');

  const client = new ApifyClient({ token });

  const startUrl = process.env.START_URL || 'https://www.reddit.com/r/programming/';
  const maxPages = Number.parseInt(process.env.MAX_CRAWL_PAGES || '10', 10);

  console.log(`Calling apify/web-scraper with startUrl=${startUrl} maxCrawlPages=${maxPages}`);

  // IMPORTANT: web-scraper expects pageFunction as STRING of a function
  const pageFunction = `async function pageFunction(context) {
    const { request, $, page } = context;

    try {
      const url = request.url;

      // Works for both Cheerio ($ exists) and Puppeteer (page exists)
      const title =
        $ ? ($('title').text() || $('h1').first().text() || '') :
        page ? await page.title() :
        '';

      const textSnippet =
        $ ? ($('body').text() || '').slice(0, 2000) :
        page ? await page.evaluate(() => (document.body?.innerText || '').slice(0, 2000)) :
        '';

      return { url, title, textSnippet };
    } catch (e) {
      return { url: request.url, error: String(e) };
    }
  }`;

  const run = await client.actor('apify/web-scraper').call({
    startUrls: [{ url: startUrl }],
    maxCrawlPages: maxPages,
    pageFunction,
  });

  const runId = run?.data?.id || run?.id;
  console.log('Run ID:', runId);
  console.log('Run URL:', `https://my.apify.com/runs/${runId}`);
}

main().catch((err) => {
  console.error('Failed:', err?.stack || err?.message || err);
  process.exit(1);
});
