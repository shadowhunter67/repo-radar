import { expect, test } from '@playwright/test';

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 900 },
]) {
  test(`labeled responsive layout at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await page.getByLabel('Repository').fill('spf13/cobra');
    await page.getByRole('button', { name: 'Analyze' }).click();
    await expect(page.locator('[data-field="score"]')).toHaveText('83.5');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    for (const field of await page.locator('[data-field]').all()) {
      expect((await field.locator('xpath=preceding-sibling::*[1]').textContent())?.trim()).not.toBe(
        '',
      );
    }
    await expect(page.getByLabel('Severity')).toBeVisible();
    await expect(page.getByLabel('Category')).toBeVisible();
    const firstRow = page.locator('tbody tr[data-finding-id]').first();
    await firstRow.focus();
    await expect(page.getByRole('button', { name: 'Analyze' })).toBeVisible();
    await expect(firstRow).toBeFocused();
    await firstRow.press('Enter');
    const dialog = page.locator('[data-evidence-dialog]');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(dialog).toContainText('CHAIN-001');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(firstRow).toBeFocused();
  });
}
