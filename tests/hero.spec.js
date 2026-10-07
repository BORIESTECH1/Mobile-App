const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Dashboard hero personalization', ()=>{
  test('shows logged-in user display name and avatar', async ({ page }) => {
    // small transparent 1x1 png data URL used for quick avatar test
    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
    // inject profiles and loggedInUser before page load
    await page.addInitScript(({ p, u }) => {
      localStorage.setItem('bt_profiles', JSON.stringify(p));
      localStorage.setItem('loggedInUser', u);
    }, { p: { 'alice': { displayName: 'Alice Example', avatar: tinyPng } }, u: 'alice' });

    await page.goto(`${BASE_URL}/dashboard.html`);
    // hero text should include display name
    const heroName = page.locator('#heroUserName');
    await expect(heroName).toHaveText(/Welcome back, Alice/);

    const heroAvatar = page.locator('#heroUserAvatar');
    await expect(heroAvatar).toBeVisible();
    await expect(heroAvatar).toHaveAttribute('src', /data:image\/png/);
  });
});
