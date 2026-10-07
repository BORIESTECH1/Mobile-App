const { test, expect } = require('@playwright/test');
const speakeasy = require('speakeasy');

const BASE = process.env.BASE_URL || 'http://localhost:3333';

test.describe('Auth flows', () => {
  test('register -> login -> call protected endpoint', async ({ request }) => {
    const username = 'pw_test_' + Date.now().toString(36).slice(2,8);
    const password = 'StrongPass1';

    // register
    const r1 = await request.post(`${BASE}/auth/register`, { data: { username, password, displayName: 'PW Test' } });
    expect(r1.ok()).toBeTruthy();

    // login
    const r2 = await request.post(`${BASE}/auth/login`, { data: { username, password } });
    expect(r2.ok()).toBeTruthy();
    const j = await r2.json();
    expect(j.accessToken).toBeTruthy();

    // call protected endpoint using access token
    const r3 = await request.post(`${BASE}/process-tx`, { data: { amount: 100 }, headers: { Authorization: 'Bearer ' + j.accessToken } });
    expect(r3.ok()).toBeTruthy();
    const res = await r3.json();
    expect(res).toHaveProperty('status');
  });

  test('enable 2FA and complete MFA login flow', async ({ request }) => {
    const username = 'mfa_test_' + Date.now().toString(36).slice(2,8);
    const password = 'StrongPass1';

    // register
    const r1 = await request.post(`${BASE}/auth/register`, { data: { username, password, displayName: 'MFA Test' } });
    expect(r1.ok()).toBeTruthy();

    // login to get access token
    const r2 = await request.post(`${BASE}/auth/login`, { data: { username, password } });
    expect(r2.ok()).toBeTruthy();
    const j2 = await r2.json();
    expect(j2.accessToken).toBeTruthy();

    // setup 2FA (requires Authorization)
    const s = await request.post(`${BASE}/auth/setup-2fa`, { headers: { Authorization: 'Bearer ' + j2.accessToken } });
    expect(s.ok()).toBeTruthy();
    const secretResp = await s.json();
    expect(secretResp.base32).toBeTruthy();

    // generate TOTP and enable
    const totp = speakeasy.totp({ secret: secretResp.base32, encoding: 'base32' });
    const en = await request.post(`${BASE}/auth/enable-2fa`, { headers: { Authorization: 'Bearer ' + j2.accessToken }, data: { token: totp } });
    expect(en.ok()).toBeTruthy();

    // now login should require MFA
    const loginAttempt = await request.post(`${BASE}/auth/login`, { data: { username, password } });
    expect(loginAttempt.ok()).toBeTruthy();
    const loginJson = await loginAttempt.json();
    expect(loginJson.mfaRequired).toBeTruthy();
    expect(loginJson.tempToken).toBeTruthy();

    // verify 2FA using temp token
    const totp2 = speakeasy.totp({ secret: secretResp.base32, encoding: 'base32' });
    const v = await request.post(`${BASE}/auth/verify-2fa`, { data: { tempToken: loginJson.tempToken, token: totp2 } });
    expect(v.ok()).toBeTruthy();
    const vj = await v.json();
    expect(vj.accessToken).toBeTruthy();

    // call protected endpoint
    const r3 = await request.post(`${BASE}/process-tx`, { data: { amount: 50 }, headers: { Authorization: 'Bearer ' + vj.accessToken } });
    expect(r3.ok()).toBeTruthy();
    const res = await r3.json();
    expect(res).toHaveProperty('status');
  });
});
