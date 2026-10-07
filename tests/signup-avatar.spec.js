const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const MOCK_URL = process.env.MOCK_SERVER_URL || 'http://localhost:3333';

// tiny 1x1 PNG base64
const AVATAR_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4//8/AwAI/AL+QnQfAAAAAElFTkSuQmCC';

test.describe('Signup with avatar', ()=>{
  test('uploads avatar, stores compressed avatar locally and on server', async ({ page }) => {
    await page.goto(`${BASE_URL}/signup.html`);
    await page.waitForTimeout(150);

    // Configure endpoint so client will try server path (mock-server)
    await page.evaluate((url)=>{ try{ localStorage.setItem('bt_api_endpoint', url); }catch(e){} }, MOCK_URL);

    const username = `playavat_${Date.now()}`;
    await page.fill('#su_username', username);
    await page.fill('#su_displayName', 'Play Avatar');
    await page.fill('#su_password', '0000');

    // upload avatar using binary buffer (no file on disk required)
    await page.setInputFiles('#su_avatar', [{ name: 'avatar.png', mimeType: 'image/png', buffer: Buffer.from(AVATAR_PNG_BASE64, 'base64') }]);

    // small wait for preview to render
    await page.waitForTimeout(200);

    await page.click('#btnSignup');

    // wait for navigation/redirect to dashboard (tolerant)
    try{
      await page.waitForURL(/.*dashboard\.html/, { timeout: 4000 });
    }catch(e){ /* ignore timing */ }

    // verify localStorage contains bt_profiles[username].avatar
    const avatarLocal = await page.evaluate((u)=>{
      const p = JSON.parse(localStorage.getItem('bt_profiles')||'{}');
      return p[u] && p[u].avatar || null;
    }, username);
    expect(avatarLocal).toBeTruthy();
    expect(typeof avatarLocal).toBe('string');
    expect(avatarLocal.startsWith('data:image/')).toBeTruthy();

    // verify server stored avatar via mock-server account lookup
    const serverAccount = await page.evaluate(async (mock, u)=>{
      try{
        const res = await fetch(mock + '/account/' + encodeURIComponent(u));
        if (!res.ok) return null;
        return await res.json();
      }catch(e){ return null; }
    }, MOCK_URL, username);

    expect(serverAccount).toBeTruthy();
    expect(serverAccount.username).toBe(username);
  // server should have avatar field set (either data URL or served URL)
  expect(serverAccount.avatar).toBeTruthy();
  expect(/^(data:image\/|https?:\/\/)/.test(serverAccount.avatar)).toBeTruthy();

    // cleanup
    await page.evaluate((u)=>{ localStorage.removeItem('bt_api_endpoint'); localStorage.removeItem('loggedInUser'); const p = JSON.parse(localStorage.getItem('bt_profiles')||'{}'); if (p[u]) delete p[u]; localStorage.setItem('bt_profiles', JSON.stringify(p)); }, username);
  });
});
