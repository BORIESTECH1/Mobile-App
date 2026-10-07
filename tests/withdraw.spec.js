const { test, expect } = require('@playwright/test');
const path = require('path');
function localFileUrl(filename){ const p = path.resolve(filename).replace(/\\/g, '/'); return 'file://' + p; }

test.describe('Withdraw flows', ()=>{
  test('wallet withdraw debits wallet and records history', async ({ page }) => {
    await page.goto(localFileUrl('index.html'));
    await page.waitForTimeout(200);
    // set PIN and top up wallet
    await page.evaluate(async ()=>{ if (window.setPin) await window.setPin('1234'); if (window.esusu && window.esusu.topUpWallet) window.esusu.topUpWallet('wuser', 1000); localStorage.setItem('loggedInUser','wuser'); });
    // perform withdraw via API (bypassing UI) to exercise logic
    const res = await page.evaluate(async ()=>{ return await window.esusu.withdrawFromWallet('wuser', 250, { dest: 'Cash' }); });
    expect(res.success).toBeTruthy();
    const wallet = await page.evaluate(()=> window.esusu.getWallet('wuser'));
    expect(wallet).toBe(750);
    const history = await page.evaluate(()=> JSON.parse(localStorage.getItem('history')||'[]'));
    const found = history.find(h=>h.type === 'withdraw' && h.amount === 250);
    expect(found).toBeTruthy();
  });

  test('escrow withdrawal request, approval and release', async ({ page }) => {
    await page.goto(localFileUrl('index.html'));
    await page.waitForTimeout(200);
    // create group and members
    const group = await page.evaluate(()=> window.esusu.createGroup({ name: 'EscrowTest', contributionAmount: 100, startDate: (new Date()).toISOString().slice(0,10), adminUser: 'admin' }));
    const gid = group.id;
    // join two more members so threshold 0.51 requires 2 approvals (ceil(3*0.51)=2)
    await page.evaluate((g)=>{ window.esusu.joinGroup(g, 'alice'); window.esusu.joinGroup(g, 'bob'); }, gid);
    // enable escrow and top up escrow
    await page.evaluate((g)=>{ const all = JSON.parse(localStorage.getItem('esusu_groups')||'{}'); all[g].settings = all[g].settings || {}; all[g].settings.escrowEnabled = true; all[g].settings.approvalThreshold = 0.51; localStorage.setItem('esusu_groups', JSON.stringify(all)); window.esusu.topUpGroupEscrow(g, 500); }, gid);
    // request escrow withdrawal by alice
    const req = await page.evaluate((g)=> window.esusu.requestEscrowWithdrawal(g, 'alice', 300, { dest: 'Bank' }), gid);
    expect(req && req.id).toBeTruthy();
    // Approve by admin (admin default) and bob -> should release when approvals >=2
    const a1 = await page.evaluate((id, user)=> window.esusu.approveEscrowWithdrawal(id, user), req.id, 'admin');
    // may not release yet
    const a2 = await page.evaluate((id, user)=> window.esusu.approveEscrowWithdrawal(id, user), req.id, 'bob');
    // after second approval it should be released
    const final = await page.evaluate((id)=>{ const arr = JSON.parse(localStorage.getItem('esusu_withdrawals')||'[]'); return arr.find(x=>x.id===id); }, req.id);
    expect(final.status).toBe('completed');
    // escrow should be reduced by 300
    const escrow = await page.evaluate((g)=> window.esusu.getGroupEscrow(g), gid);
    expect(escrow).toBe(200);
    // alice wallet should be credited
    const walletAlice = await page.evaluate(()=> window.esusu.getWallet('alice'));
    expect(walletAlice).toBe(300);
  });
});
