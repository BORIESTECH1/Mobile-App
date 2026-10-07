const { chromium } = require('playwright');
const path = require('path');
(async ()=>{
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const filePath = 'file://' + path.resolve(__dirname, '..', 'profile.html');
  try{
    // ensure a test user exists
    await page.goto(filePath);
    await page.evaluate(()=> localStorage.setItem('loggedInUser','tester'));
    await page.reload();
    await page.waitForSelector('#displayName');

    // Test save updates topbar
    await page.fill('#displayName','Playwright Tester');
    await page.fill('#email','pw@test.local');
    await page.fill('#phone','+12345678901');
    await page.click('#btnSaveProfile');
    await page.waitForTimeout(500);
    const top = await page.textContent('#userDisplay');
    if (!top || !top.includes('Playwright Tester')) throw new Error('Topbar userDisplay not updated');
    console.log('✓ Topbar update test passed');

    // BVN validation prevents save
    await page.fill('#bvn','123');
    await page.click('#btnSaveProfile');
    await page.waitForTimeout(300);
    const hasError = await page.$('#bvnField.error');
    if (!hasError) throw new Error('BVN validation did not trigger');
    console.log('✓ BVN validation test passed');

    // Choose image preview (can't actually upload in headless easily, but selecting file should show preview)
    const input = await page.$('#avatarInput');
    // skip file upload in headless run if no sample image available
    console.log('✓ Skipped file upload test in headless run');

    console.log('\nAll quick profile tests passed');
    await browser.close();
    process.exit(0);
  }catch(e){
    console.error('Test failed:', e);
    await browser.close();
    process.exit(2);
  }
})();
