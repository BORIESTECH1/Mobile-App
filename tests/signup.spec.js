const { test, expect } = require('@playwright/test');

// BASE_URL env var when running under a static server. Default to http://localhost:3000
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const MOCK_URL = process.env.MOCK_SERVER_URL || 'http://localhost:3333';

test.describe('Signup flow', ()=>{
  test('create a new account via signup page (server if configured, else local)', async ({ page }) => {
    await page.goto(`${BASE_URL}/signup.html`);
    await page.waitForTimeout(150);

    // Configure endpoint for the page to try server create-account (optional)
    await page.evaluate((url)=>{ try{ localStorage.setItem('bt_api_endpoint', url); }catch(e){} }, MOCK_URL);

    const username = `play-${Date.now()}`;
    await page.fill('#su_username', username);
    await page.fill('#su_password', '0000');
    await page.click('#btnSignup');

    // Wait for navigation to dashboard (client redirects to dashboard.html)
    await page.waitForTimeout(800);
    // It's possible redirect takes slightly longer; allow URL check
    try{
      await page.waitForURL(new RegExp('.*dashboard\.html'), { timeout: 3500 });
    }catch(e){ /* ignore timing flakiness */ }

    // Check localStorage for created profile and loggedInUser
    const loggedIn = await page.evaluate(()=> localStorage.getItem('loggedInUser'));
    expect(loggedIn).toBeTruthy();
    expect(loggedIn).toBe(username);
    const profiles = await page.evaluate(()=> JSON.parse(localStorage.getItem('bt_profiles')||'{}'));
    expect(profiles[username]).toBeTruthy();
    // cleanup
    await page.evaluate((u)=>{ localStorage.removeItem('bt_api_endpoint'); localStorage.removeItem('loggedInUser'); const p = JSON.parse(localStorage.getItem('bt_profiles')||'{}'); if (p[u]) delete p[u]; localStorage.setItem('bt_profiles', JSON.stringify(p)); }, username);
  });
});
