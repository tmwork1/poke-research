import { chromium } from 'playwright';

const base = 'http://localhost:4323';

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('console', (msg) => {
	if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(String(err)));

await page.goto(base + '/about');

const variant = await page.getAttribute('.account-dropdown', 'data-variant');
console.log('data-variant:', variant, '(期待: login)');

// --- 1回クリック: ドロップダウンが開き、遷移しない ---
await page.click('.mypage-tab-wrap .mypage-tab');
await page.waitForSelector('.mypage-tab-wrap.open .account-dropdown[data-variant="login"]', { timeout: 3000 });
console.log('1クリック後のURL:', page.url(), '(期待: /about のまま)');

const loginBtnVisible = await page.isVisible('.dropdown-login-button');
const loginHref = await page.getAttribute('.dropdown-login-button', 'href');
console.log('ログインボタン表示:', loginBtnVisible, ' href:', loginHref, '(期待: 表示=true, href=/api/auth/login)');

await page.screenshot({ path: 'C:/Users/tmtmp/Documents/pokemon/poke-research/_tmp-logged-out-dropdown.png' });

// --- 2回目クリック: 閉じるだけで遷移しない ---
await page.click('.mypage-tab-wrap .mypage-tab');
await page.waitForTimeout(300);
const stillOpen = await page.isVisible('.mypage-tab-wrap.open .account-dropdown[data-variant="login"]');
console.log('2回クリック後も開いているか(falseが期待):', stillOpen);
console.log('2回クリック後のURL:', page.url(), '(期待: /about のまま)');

console.log('console errors:', consoleErrors);
await browser.close();
