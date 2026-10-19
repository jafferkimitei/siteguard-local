import type { Browser } from 'playwright';
import { assertDestinationAllowed } from '@siteguard/safety';
import type { Target } from '@siteguard/database';
import { USER_AGENT, type FetchResult } from './http';

/** Resource types that add traffic but never change the DOM we inspect. */
const SKIPPED_TYPES = new Set(['image', 'media', 'font']);

export async function launchBrowser(): Promise<Browser> {
  // Imported lazily so plain fetch crawls work without Playwright's browser installed.
  const { chromium } = await import('playwright');
  return chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH || undefined,
  });
}

/**
 * Render a page that safeFetch already retrieved and return the post-JavaScript HTML.
 *
 * The main document is served from the earlier fetch (no second request), and every
 * other request the browser makes goes through the same scope and private-network checks
 * as the rest of the tool; anything outside the approved hosts is aborted.
 */
export async function renderHtml(browser: Browser, fetched: FetchResult, target: Target, timeoutMs = 15_000): Promise<string> {
  const context = await browser.newContext({ userAgent: USER_AGENT, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const verdicts = new Map<string, Promise<boolean>>();
    const allowed = (url: string) => {
      const origin = new URL(url).origin;
      let v = verdicts.get(origin);
      if (!v) {
        v = assertDestinationAllowed(url, target).then(() => true, () => false);
        verdicts.set(origin, v);
      }
      return v;
    };

    await page.route('**/*', async (route) => {
      const req = route.request();
      const url = req.url();
      if (url === fetched.finalUrl && req.isNavigationRequest()) {
        return route.fulfill({
          status: fetched.status,
          contentType: fetched.headers.get('content-type') ?? 'text/html; charset=utf-8',
          body: fetched.body,
        });
      }
      if (!/^https?:/i.test(url) || SKIPPED_TYPES.has(req.resourceType()) || !(await allowed(url))) return route.abort();
      return route.continue();
    });

    await page.goto(fetched.finalUrl, { waitUntil: 'load', timeout: timeoutMs });
    // Give client-side frameworks a moment to settle, but never hang on long-polling pages.
    await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => {});
    return await page.content();
  } finally {
    await context.close();
  }
}
