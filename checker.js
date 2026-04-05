/**
 * checker.js
 * Core Playwright-based Google Maps review link checker.
 * Handles detection, retry logic, CAPTCHA detection, and anti-block strategies.
 */

const { chromium } = require('playwright');
const proxyManager = require('./proxyManager');

const TIMEOUT = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '20000', 10);

// Keywords that indicate a review is DEAD
const DEAD_KEYWORDS = [
  'this review is no longer available',
  'bài đánh giá này hiện không còn khả dụng',
  'no longer available',
  'không còn khả dụng',
  'review has been removed',
  'this content is unavailable',
  'nội dung này không khả dụng',
];

// Keywords that indicate a CAPTCHA / block
const CAPTCHA_KEYWORDS = [
  'captcha',
  'unusual traffic',
  'lưu lượng truy cập bất thường',
  'i\'m not a robot',
  'tôi không phải robot',
  'verify you are human',
  'xác minh bạn là người',
  'suspicious activity',
  'hoạt động đáng ngờ',
  'access denied',
  'error 403',
];

// Minimal Google Maps structural markers that confirm a valid Maps page
const MAPS_MARKERS = [
  'maps.google',
  'google.com/maps',
  'maps.app.goo.gl',
  'place/',
  'maps/reviews',
  'data-review-id',
  'aria-label',
  'gm-style',
];

function randomDelay(min = 1000, max = 3000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
}

function containsAny(text, keywords) {
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/**
 * Check a single review URL.
 *
 * @param {string} url
 * @param {object} proxyConfig  Playwright proxy config (or undefined)
 * @param {function} log        Logging callback (message) => void
 * @returns {'✅ Public' | '❌ Dead' | '⚠️ Error'}
 */
async function checkUrl(url, proxyConfig, log = console.log) {
  let browser;
  try {
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--lang=en-US,en',
      ],
    };

    if (proxyConfig) {
      const { _proxyId, ...cleanProxy } = proxyConfig;
      launchOptions.proxy = cleanProxy;
    }

    browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'en-US',
      timezoneId: 'America/New_York',
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    const page = await context.newPage();

    // Block unnecessary resources to speed up and reduce fingerprinting
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    let pageContent = '';
    let finalUrl = url;

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: TIMEOUT,
    });

    finalUrl = page.url();

    // Wait a moment for dynamic content to settle
    await page.waitForTimeout(2000);

    pageContent = await page.content();
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    const fullText = pageContent + ' ' + bodyText;

    await browser.close();
    browser = null;

    // --- Classification logic ---

    // 1. CAPTCHA detection
    if (containsAny(fullText, CAPTCHA_KEYWORDS)) {
      log(`⚠️ CAPTCHA detected for: ${url}`);
      return '⚠️ Error';
    }

    // 2. Dead review detection
    if (containsAny(fullText, DEAD_KEYWORDS)) {
      return '❌ Dead';
    }

    // 3. HTTP error
    if (response && response.status() >= 400) {
      log(`⚠️ HTTP ${response.status()} for: ${url}`);
      return '⚠️ Error';
    }

    // 4. Empty / very short content
    if (bodyText.trim().length < 100) {
      log(`⚠️ Page seems empty for: ${url}`);
      return '⚠️ Error';
    }

    // 5. Validate it's actually a Maps page (by URL or content)
    const isMapsDomain =
      finalUrl.includes('google.com/maps') ||
      finalUrl.includes('maps.app.goo.gl') ||
      finalUrl.includes('maps.google');

    if (!isMapsDomain && !containsAny(fullText, MAPS_MARKERS)) {
      log(`⚠️ Not a recognized Google Maps page: ${finalUrl}`);
      return '⚠️ Error';
    }

    return '✅ Public';
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
    log(`⚠️ Exception checking ${url}: ${err.message}`);
    return '⚠️ Error';
  }
}

/**
 * Check a URL with retry logic (up to maxRetries attempts, each on a different proxy).
 *
 * @param {string}   url
 * @param {string[]} proxyIds     Array of proxy IDs selected by user (empty = no proxy)
 * @param {string}   rotation     'random' | 'roundrobin'
 * @param {number}   maxRetries
 * @param {function} log
 * @returns {string}  Status string
 */
async function checkUrlWithRetry(url, proxyIds = [], rotation = 'random', maxRetries = 2, log = console.log) {
  let triedProxyIds = [];
  let lastProxyConfig;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt === 0) {
      lastProxyConfig = proxyManager.getFromPool(proxyIds, rotation, triedProxyIds);
    } else {
      // Retry: switch to a different proxy from the pool
      const currentId = lastProxyConfig ? lastProxyConfig._proxyId : null;
      if (currentId) triedProxyIds.push(currentId);
      lastProxyConfig = proxyManager.getAlternateFromPool(proxyIds, currentId);
      log(`🔄 Retry ${attempt}/${maxRetries} for: ${url}${lastProxyConfig ? ` (proxy: ${lastProxyConfig._proxyId})` : ' (no proxy)'}`);
    }

    await randomDelay(1000, 3000);

    const result = await checkUrl(url, lastProxyConfig, log);

    if (result !== '⚠️ Error') {
      return result; // Got a definitive answer
    }

    // If error and we used a proxy, mark it after all retries
    if (lastProxyConfig && lastProxyConfig._proxyId) {
      if (attempt === maxRetries) {
        proxyManager.markFailed(lastProxyConfig._proxyId);
      }
    }
  }

  return '⚠️ Error';
}

module.exports = { checkUrlWithRetry, checkUrl };
