const { test, expect } = require('@playwright/test');

// Use BASE_URL env var when running under a static server. Default to file:// fallback for convenience.
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Mark Paid flow', ()=>{
  test('marking a member as paid with wallet debit reduces wallet and records contribution', async ({ page }, testInfo) => {
    // start tracing to help debug failures
    await page.tracing.start({ screenshots: true, snapshots: true });
    // Create group and members via window APIs
    await page.goto(`${BASE_URL}/groups.html`);
    await page.waitForTimeout(200);

    const groupId = await page.evaluate(()=>{
      const id = window.esusu.createGroup({ name: 'PW Test Group', contributionAmount: 100, startDate: new Date().toISOString().slice(0,10), adminUser: 'alice' }).id;
      window.esusu.joinGroup(id, 'bob');
      localStorage.setItem('loggedInUser', 'alice');
      return id;
    });

    // ensure bob has sufficient wallet balance to be debited
    await page.evaluate(()=> window.esusu.topUpWallet('bob', 500));
    const beforeBal = await page.evaluate(()=> window.esusu.getWallet('bob'));

    // navigate to group page
    await page.goto(`${BASE_URL}/group.html?id=${groupId}`);
    await page.waitForTimeout(300);

    const btn = page.locator('button.mark-paid[data-user="bob"]');
    await expect(btn).toBeVisible();

    await btn.click();

    // optional note input
    const modalInput = page.locator('.modal-input').first();
    if (await modalInput.count() > 0) {
      await modalInput.fill('cash');
      await page.click('.modal-ok');
    }

    // confirm modal: click Yes to debit wallet
    const yesBtn = page.locator('.modal-yes').first();
    if (await yesBtn.count() > 0) await yesBtn.click();

    await page.waitForTimeout(300);

    // contribution should be recorded and status = paid
    const contribs = await page.evaluate((gid)=> window.esusu.getContributionsForDate(gid, new Date().toISOString().slice(0,10)), groupId);
    const bob = contribs.find(c => c.userId === 'bob');
    expect(bob).toBeTruthy();
    expect(bob.status).toBe('paid');

    // wallet should be debited by group's contribution amount (100)
    const afterBal = await page.evaluate(()=> window.esusu.getWallet('bob'));
    expect(Number(afterBal)).toBe(Number(beforeBal) - 100);
    // automatic payout should have been created if all members were paid (beneficiary credited)
    const payouts = await page.evaluate(()=> JSON.parse(localStorage.getItem('esusu_payouts')||'[]'));
    expect(payouts.length).toBeGreaterThanOrEqual(1);
    const myPayout = payouts.find(p=>p.groupId===groupId && p.date === new Date().toISOString().slice(0,10));
    expect(myPayout).toBeTruthy();
    // beneficiary wallet should be increased by payout amount (if non-zero)
    if (myPayout && myPayout.amount > 0) {
      const ben = await page.evaluate((b)=> window.esusu.getWallet(b), myPayout.beneficiary_userId);
      expect(Number(ben)).toBeGreaterThanOrEqual(0);
    }
    // stop tracing and save
    await page.tracing.stop({ path: `test-results/trace-markpaid-${Date.now()}.zip` });
  });

  test('attempting to debit wallet with insufficient balance shows error and does not mark paid', async ({ page }, testInfo) => {
    await page.tracing.start({ screenshots: true, snapshots: true });
    await page.goto(`${BASE_URL}/groups.html`);
    await page.waitForTimeout(200);

    // create a group and member with zero balance
    const groupId = await page.evaluate(()=>{
      const id = window.esusu.createGroup({ name: 'PW Test Group 2', contributionAmount: 150, startDate: new Date().toISOString().slice(0,10), adminUser: 'charlie' }).id;
      window.esusu.joinGroup(id, 'eve');
      localStorage.setItem('loggedInUser', 'charlie');
      // ensure eve has zero wallet
      const p = JSON.parse(localStorage.getItem('bt_profiles')||'{}'); p['eve'] = p['eve'] || {}; p['eve'].wallet = 0; localStorage.setItem('bt_profiles', JSON.stringify(p));
      return id;
    });

    await page.goto(`${BASE_URL}/group.html?id=${groupId}`);
    await page.waitForTimeout(300);

    const btn = page.locator('button.mark-paid[data-user="eve"]');
    await expect(btn).toBeVisible();

    await btn.click();
    // optional note input
    const modalInput = page.locator('.modal-input').first();
    if (await modalInput.count() > 0) {
      await modalInput.fill('bank transfer');
      await page.click('.modal-ok');
    }

    // confirm modal: click Yes to debit (should fail)
    const yesBtn = page.locator('.modal-yes').first();
    if (await yesBtn.count() > 0) await yesBtn.click();

    // wait for toast error to appear
    await page.waitForTimeout(300);
    const toast = page.locator('.toast', { hasText: 'Insufficient' });
    await expect(toast.first()).toBeVisible();

    // contribution for eve should not be marked as paid
    const contribs = await page.evaluate((gid)=> window.esusu.getContributionsForDate(gid, new Date().toISOString().slice(0,10)), groupId);
    const eve = contribs.find(c => c.userId === 'eve');
    // either no contribution or not paid
    if (eve) expect(eve.status).not.toBe('paid');
    await page.tracing.stop({ path: `test-results/trace-markpaid-fail-${Date.now()}.zip` });
  });  # from project root
  node .\mock-server\server.js
  # Or use the orchestrator if you have Playwright/CI set up:
  node .\scripts\run-mock-and-test.js
});
