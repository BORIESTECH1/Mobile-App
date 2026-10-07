const { test, expect } = require('@playwright/test');
const speakeasy = require('speakeasy');

const BASE = process.env.BASE_URL || 'http://localhost:3333';

test.describe('Auth UI flows', () => {
  test('signup -> enable 2FA -> logout -> login with 2FA via UI', async ({ page }) => {
    const username = 'ui_' + Date.now().toString(36).slice(2,8);
    const password = 'UiStrong1';
    const displayName = 'UI Test';

    // Sign up via UI
    await page.goto(`${BASE}/signup.html`);
    await page.fill('#su_username', username);
    await page.fill('#su_displayName', displayName);
    await page.fill('#su_password', password);
    await page.click('#btnSignup');

    // wait for redirect to dashboard (or loggedInUser set)
    await page.waitForFunction(() => !!localStorage.getItem('loggedInUser'));
    const logged = await page.evaluate(() => localStorage.getItem('loggedInUser'));
    expect(logged).toBe(username);

    // Obtain access token from localStorage
    const access = await page.evaluate(() => localStorage.getItem('bt_api_token'));
    expect(access).toBeTruthy();

    // Call setup-2fa via browser context fetch to get base32 secret
    const secret = await page.evaluate(async (accessToken) => {
      const r = await fetch('/auth/setup-2fa', { method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' } });
      return r.json();
    }, access);
    expect(secret).toBeTruthy();
    expect(secret.base32).toBeTruthy();

    // Generate TOTP using secret and enable via browser fetch
    const totp = speakeasy.totp({ secret: secret.base32, encoding: 'base32' });
    const ok = await page.evaluate(async (accessToken, token) => {
      const r = await fetch('/auth/enable-2fa', { method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      return r.ok;
    }, access, totp);
    expect(ok).toBeTruthy();

    // Logout by POSTing to /auth/logout (browser will clear cookie)
    await page.evaluate(async () => { await fetch('/auth/logout', { method: 'POST', credentials: 'include' }); localStorage.removeItem('bt_api_token'); localStorage.removeItem('loggedInUser'); });

    // Navigate to login UI and login
    await page.goto(`${BASE}/login.html`);
    await page.fill('#li_username', username);
    await page.fill('#li_password', password);
    await page.click('#btnLogin');

    // If a 2FA modal appears, enter TOTP
    const modalInput = page.locator('.modal-input').first();
    if (await modalInput.count() > 0) {
      const totp2 = speakeasy.totp({ secret: secret.base32, encoding: 'base32' });
      await modalInput.fill(totp2);
      // click OK
      await page.click('.modal-ok');
    }

    // Wait for dashboard to show loggedInUser again
    await page.waitForFunction(() => !!localStorage.getItem('loggedInUser'));
    const logged2 = await page.evaluate(() => localStorage.getItem('loggedInUser'));
    expect(logged2).toBe(username);
  });
});
