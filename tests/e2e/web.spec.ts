import { readFileSync } from 'node:fs';
import { expect, test, type ConsoleMessage } from '@playwright/test';

const fixture = JSON.parse(readFileSync('tests/fixtures/web/report-cobra.json', 'utf8'));
const SHA = 'adbc8813901bba65827259daa8e22ff94ec1f30e';

test.describe('web analyzer preview (real server, real UI, fixture report)', () => {
  test('analyze, inspect, evidence dialog, download', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (m: ConsoleMessage) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await page.addInitScript(() => {
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        (window as unknown as { __csp: string[] }).__csp.push(
          `${e.violatedDirective} ${e.blockedURI}`,
        ),
      );
    });

    // nothing is analysed on load, even with a pre-filled repository
    const requests: string[] = [];
    page.on('request', (r) => requests.push(`${r.method()} ${new URL(r.url()).pathname}`));
    await page.goto('/?repo=spf13/cobra');
    await expect(page.locator('#repository')).toHaveValue('spf13/cobra');
    expect(requests.filter((r) => r.includes('/api/'))).toEqual([]);
    await expect(page.locator('[data-section="score"]')).toHaveCount(0);

    await page.getByRole('button', { name: 'Phân tích' }).click();
    await expect(page.locator('[data-section="score"] [data-field="score"]')).toHaveText('83.5', {
      timeout: 15_000,
    });
    expect(requests.filter((r) => r === 'POST /api/v1/analyze')).toHaveLength(1);

    await expect(page.locator('[data-field="sha"]')).toHaveText(SHA);
    await expect(page.locator('[data-field="repository"]')).toHaveText('spf13/cobra');
    await expect(page.locator('[data-section="confidence"] [data-field="confidence"]')).toHaveText(
      '0.877',
    );
    await expect(page.locator('[data-section="coverage"] [data-field="coverage"]')).toHaveText(
      '100%',
    );
    await expect(page.locator('tbody tr[data-finding-id]')).toHaveCount(4);

    // severity filter then evidence dialog by keyboard
    const row = page.locator('tr[data-finding-id="RR-EXEC-001"]');
    await row.focus();
    await row.press('Enter');
    const dialog = page.locator('[data-evidence-dialog]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-evidence-id="CHAIN-001"]')).toContainText('Makefile');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(row).toBeFocused();

    // download equals the report served by the API
    const download = page.waitForEvent('download');
    await page.locator('a[data-action="download"]').click();
    const d = await download;
    expect(d.suggestedFilename()).toBe(`repo-radar-spf13-cobra-${SHA.slice(0, 12)}.json`);
    const body = readFileSync((await d.path()) as string, 'utf8');
    expect(JSON.parse(body)).toEqual(fixture);

    expect(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('a missing repository shows the not-found message and no result view', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Kho mã').fill('someone/missing');
    await page.getByRole('button', { name: 'Phân tích' }).click();
    await expect(page.locator('#error')).toContainText(
      'Không tìm thấy kho mã hoặc kho mã không thể truy cập.',
    );
    await expect(page.locator('[data-section="score"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Phân tích' })).toBeEnabled();
  });

  test('invalid input is rejected before any API request', async ({ page }) => {
    const posts: string[] = [];
    page.on('request', (r) => r.method() === 'POST' && posts.push(r.url()));
    await page.goto('/');
    await page.getByLabel('Kho mã').fill('http://127.0.0.1/owner/repo');
    await page.getByRole('button', { name: 'Phân tích' }).click();
    await expect(page.locator('#error')).toContainText(
      'Hãy nhập kho mã GitHub công khai theo dạng owner/repo.',
    );
    expect(posts).toEqual([]);
  });

  test('response headers carry the CSP and the page has no inline script, style or handler', async ({
    page,
  }) => {
    const res = await page.goto('/');
    const csp = res?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(await page.locator('script:not([src])').count()).toBe(0);
    expect(await page.locator('[style]').count()).toBe(0);
  });
});
