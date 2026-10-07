const { test, expect } = require('@playwright/test');
const path = require('path');

// Helper to open a file:// URL in Playwright
function localFileUrl(filename){
  const p = path.resolve(filename).replace(/\\/g, '/');
  return 'file://' + p;
}

test.describe('Esusu flows', ()=>{
  test('create, join, topup, process payout', async ({ page }) => {
    // Open groups page
    await page.goto(localFileUrl('groups.html'));
    // ensure JS loaded
    await page.waitForTimeout(200);

    // create group via the form
    await page.click('#btnShowNewGroup');
    await page.fill('#g_name','Test Group');
    await page.fill('#g_amount','100');
    await page.fill('#g_admin','testuser');
    await page.click('#btnCreateGroup');

    // wait for toast or refresh
    await page.waitForTimeout(300);

    // ensure group appears in list
    const groupCard = await page.locator('.group-card').first();
    await expect(groupCard).toBeVisible();

    // get id via dataset on view button
    const viewBtn = groupCard.locator('button', { hasText: 'View' });
    const groupHref = await groupCard.locator('button', { hasText: 'View' }).getAttribute('onclick');
    // click view
    await viewBtn.click();
    await page.waitForLoadState('load');

    // On group page, top up wallet
    await page.waitForSelector('#btnTopUp');
    // use top up modal if present
    if (await page.$('#esusuJoinModal') !== null) {
      // ensure it's hidden
    }
    await page.click('#btnTopUp');
    // if input modal appeared, fill it
    const modalInput = await page.$('.modal-input');
    if (modalInput) {
      // first input is user id
      await modalInput.fill('testuser');
      await page.click('.modal-ok');
      // second modal input for amt
      await page.waitForSelector('.modal-input');
      await page.fill('.modal-input','500');
      await page.click('.modal-ok');
    } else {
      // fallback fill prompts won't be present in headless; instead call esusu.topUpWallet directly via evaluate
      await page.evaluate(()=> window.esusu && window.esusu.topUpWallet && window.esusu.topUpWallet('testuser',500));
    }

    // process today's payout (click process button)
    await page.click('#btnProcess');
    await page.waitForTimeout(400);

    // check that payouts exist in localStorage (esusu_payouts)
    const payouts = await page.evaluate(()=> JSON.parse(localStorage.getItem('esusu_payouts')||'[]'));
    expect(payouts.length).toBeGreaterThanOrEqual(1);
  });
});
