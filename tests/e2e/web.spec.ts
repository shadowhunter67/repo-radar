import { test, expect } from '@playwright/test';

test.describe('web analyzer preview', () => {
  test.skip(true, 'The deterministic server fixture is supplied by the deployment harness.');

  test('renders a report, evidence dialog, and downloadable JSON', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Repository').fill('spf13/cobra');
    await page.getByRole('button', { name: 'Analyze' }).click();
    await expect(page.locator('[data-field="score"]')).toHaveText('83.5');
    const row = page.locator('[data-finding-id="RR-EXEC-001"]');
    await row.focus();
    await row.press('Enter');
    await expect(page.locator('[data-evidence-dialog]')).toContainText('CHAIN-001');
    await page.keyboard.press('Escape');
    await expect(row).toBeFocused();
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download JSON report' }).click();
    expect((await download).suggestedFilename()).toMatch(
      /^repo-radar-spf13-cobra-[0-9a-f]{12}\.json$/,
    );
  });
});
