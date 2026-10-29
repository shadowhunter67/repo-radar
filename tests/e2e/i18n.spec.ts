import { expect, test, type Page } from '@playwright/test';

const rgb = (css: string): number[] => (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
const luminance = ([r, g, b]: number[]) => {
  const c = [r, g, b].map((v) => {
    const s = (v ?? 0) / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
};
const ratio = (fg: string, bg: string) => {
  const [a, b] = [luminance(rgb(fg)), luminance(rgb(bg))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
async function styleOf(page: Page, selector: string, pseudo?: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((el, p) => {
      const s = getComputedStyle(el, p ?? null);
      return { color: s.color, background: s.backgroundColor, border: s.borderTopColor };
    }, pseudo);
}

test.describe('Vietnamese by default, English on request', () => {
  test('opens in Vietnamese, analyzes once, switches language in place without a new request', async ({
    page,
  }) => {
    const posts: string[] = [];
    page.on('request', (r) => r.method() === 'POST' && posts.push(r.url()));
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    await expect(page).toHaveTitle('repo-radar — Web Analyzer: Bản xem trước Quét nhanh');
    await expect(page.getByLabel('Kho mã')).toBeVisible();

    await page.getByLabel('Kho mã').fill('sindresorhus/is-plain-obj');
    await page.getByRole('button', { name: 'Phân tích' }).click();
    await expect(page.locator('[data-field="score"]')).toBeVisible({ timeout: 15_000 });
    const heads = () =>
      page
        .locator('#result [data-section] > h2, #result [data-section] > summary')
        .allTextContents();
    expect(await heads()).toEqual(
      expect.arrayContaining(['Tổng quan', 'Điểm', 'Độ tin cậy', 'Độ phủ', 'Phát hiện']),
    );
    const score = await page.locator('[data-field="score"]').textContent();
    const ids = await page
      .locator('tr[data-finding-id]')
      .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-finding-id')));

    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle('repo-radar — Web Analyzer: Quick Scan Preview');
    expect(await heads()).toEqual(
      expect.arrayContaining(['Overview', 'Score', 'Confidence', 'Coverage', 'Findings']),
    );
    expect(await page.locator('[data-field="score"]').textContent()).toBe(score);
    expect(
      await page
        .locator('tr[data-finding-id]')
        .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-finding-id'))),
    ).toEqual(ids);

    await page.getByRole('button', { name: 'Tiếng Việt' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    expect(await heads()).toEqual(
      expect.arrayContaining(['Tổng quan', 'Điểm', 'Độ tin cậy', 'Độ phủ', 'Phát hiện']),
    );
    expect(posts.filter((u) => u.endsWith('/api/v1/analyze'))).toHaveLength(1);
  });

  test('a reload returns to Vietnamese (nothing is stored)', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'English' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
    expect(
      await page.evaluate(
        () => localStorage.length + sessionStorage.length + document.cookie.length,
      ),
    ).toBe(0);
  });

  test('the language buttons work from the keyboard', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'English' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Tiếng Việt' }).focus();
    await page.keyboard.press('Space');
    await expect(page.locator('html')).toHaveAttribute('lang', 'vi');
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`control contrast in ${scheme} mode`, () => {
    test.use({ colorScheme: scheme });
    test('buttons, inputs and selects never share a foreground and background colour', async ({
      page,
    }) => {
      await page.goto('/');
      await page.getByLabel('Kho mã').fill('spf13/cobra');
      await page.getByRole('button', { name: 'Phân tích' }).click();
      await expect(page.locator('[data-field="score"]')).toBeVisible({ timeout: 15_000 });

      const enabled = [
        '#analyze',
        '[data-example]',
        '[data-lang="vi"]',
        '[data-lang="en"]',
        '[data-pagination="next"]',
        '[data-action="copy-cli"]',
        '[data-action="copy-integrity"]',
      ];
      for (const sel of enabled) {
        const s = await styleOf(page, sel);
        expect(s.color, sel).not.toBe(s.background);
        expect(ratio(s.color, s.background), `${sel} ${scheme}`).toBeGreaterThanOrEqual(4.5);
      }
      // a disabled button (Previous on the first page) is dimmer on purpose but still readable
      const prev = await styleOf(page, '[data-pagination="prev"]');
      await expect(page.locator('[data-pagination="prev"]')).toBeDisabled();
      expect(prev.color).not.toBe(prev.background);
      expect(ratio(prev.color, prev.background)).toBeGreaterThanOrEqual(3);

      // the evidence dialog's Close button
      await page.locator('tr[data-finding-id]').first().press('Enter');
      const close = await styleOf(page, '[data-evidence-dialog] button');
      expect(close.color).not.toBe(close.background);
      expect(ratio(close.color, close.background)).toBeGreaterThanOrEqual(4.5);
      await page.keyboard.press('Escape');

      for (const sel of [
        '#repository',
        '#ref',
        'select[data-filter="severity"]',
        'input[data-filter="search"]',
      ]) {
        const s = await styleOf(page, sel);
        expect(ratio(s.color, s.background), `${sel} ${scheme}`).toBeGreaterThanOrEqual(4.5);
        expect(s.border, `${sel} border`).not.toBe(s.background);
      }
      const ph = await styleOf(page, '#repository', '::placeholder');
      const field = await styleOf(page, '#repository');
      expect(ratio(ph.color, field.background)).toBeGreaterThanOrEqual(4.5);

      // hover keeps text readable
      await page.locator('#analyze').hover();
      const hovered = await styleOf(page, '#analyze');
      expect(ratio(hovered.color, hovered.background)).toBeGreaterThanOrEqual(4.5);
    });
  });
}
