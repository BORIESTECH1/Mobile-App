const { test, expect } = require('@playwright/test');
const speakeasy = require('speakeasy');

const BASE = process.env.BASE_URL || 'http://localhost:3333';

test.describe('2FA QR / otpauth UI checks', () => {
  test('signup -> setup-2fa returns otpauth_url and base32', async ({ page }) => {
    const username = 'qr_ui_' + Date.now().toString(36).slice(2,8);
    const password = 'QrStrong1';

    // Sign up via UI
    await page.goto(`${BASE}/signup.html`);
    await page.fill('#su_username', username);
    await page.fill('#su_displayName', 'QR UI Test');
    await page.fill('#su_password', password);
    await page.click('#btnSignup');

    // wait for loggedInUser in localStorage
    await page.waitForFunction(() => !!localStorage.getItem('loggedInUser'));

    // Grab access token from localStorage
    const access = await page.evaluate(() => localStorage.getItem('bt_api_token'));
    expect(access).toBeTruthy();

    // Call setup-2fa via browser fetch to get otpauth_url
    const secret = await page.evaluate(async (accessToken) => {
      const r = await fetch('/auth/setup-2fa', { method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' } });
      return r.json();
    }, access);

    expect(secret).toBeTruthy();
    expect(secret.base32).toBeTruthy();
    expect(secret.otpauth_url).toBeTruthy();
    expect(secret.otpauth_url.indexOf('otpauth://') === 0).toBeTruthy();

    // Optionally verify that generated TOTP using the base32 secret is valid by calling enable-2fa
    const totp = speakeasy.totp({ secret: secret.base32, encoding: 'base32' });
    const ok = await page.evaluate(async (accessToken, token) => {
      const r = await fetch('/auth/enable-2fa', { method: 'POST', headers: { 'Authorization': 'Bearer ' + accessToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      return r.ok;
    }, access, totp);
    expect(ok).toBeTruthy();
  });
});
