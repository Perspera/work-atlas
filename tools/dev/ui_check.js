/* 前端回归截图：登录后逐页截图，并收集控制台错误。
 * 用法：node tools/dev/ui_check.js [http://127.0.0.1:8787] [admin密码]
 * 依赖本机已装的 Chrome（通过 puppeteer-core 驱动）。
 */
const path = require('path');
const fs = require('fs');

const NODE_MODULES = 'C:/Users/Administrator/.dsh/profiles/desktop/node_modules';
const puppeteer = require(NODE_MODULES + '/puppeteer-core');

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Users/Administrator/AppData/Local/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
];

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PASSWORD = process.argv[3] || 'Admin12345';
const OUT = path.join(__dirname, '..', '..', 'data', 'ui');

(async () => {
  const executablePath = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!executablePath) throw new Error('找不到 Chrome/Edge');
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--lang=zh-CN', '--window-size=1440,900'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const errors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push('console: ' + msg.text());
  });
  page.on('pageerror', (err) => errors.push('pageerror: ' + err.message));

  await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30000 });
  const userInput = await page.$('#f-user');
  if (userInput) {
    await page.type('#f-user', 'admin');
    await page.type('#f-pwd', PASSWORD);
    await page.click('#f-go');
    await page.waitForSelector('.kpi-row, .auth-err', { timeout: 20000 });
    await new Promise((r) => setTimeout(r, 1200));
  }
  const authError = await page.$('.auth-err');
  if (authError) {
    const text = await page.evaluate((el) => el.textContent, authError);
    console.log('登录失败：' + text);
    await browser.close();
    process.exit(1);
  }

  const shots = [
    ['overview', '#/overview'],
    ['labor', '#/labor'],
    ['hub', '#/dashboard'],
    ['editor', '#/board/page/overview'],
    ['progress', '#/progress'],
    ['volume', '#/volume'],
    ['trend', '#/trend'],
    ['alerts', '#/alerts'],
    ['orders', '#/orders'],
    ['waves', '#/waves'],
    ['sources', '#/sources'],
  ];

  const selectOptions = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#date-select option')).map((o) => o.textContent)
  );
  console.log('date options: ' + JSON.stringify(selectOptions.slice(0, 6)));

  for (const [name, hash] of shots) {
    await page.evaluate((h) => { location.hash = h; }, hash);
    await new Promise((r) => setTimeout(r, 2600));
    await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });
    console.log('shot ' + name + '.png');
  }

  // 人工作业量：切到「存档」模式截图（先确保有存档：有人员数据的旧日期会自动补档）
  await page.evaluate(() => { location.hash = '#/labor'; });
  await new Promise((r) => setTimeout(r, 2200));
  const archiveBtn = await page.$('[data-mode="archive"]');
  if (archiveBtn) {
    await archiveBtn.click();
    await new Promise((r) => setTimeout(r, 2600));
    await page.screenshot({ path: path.join(OUT, 'labor_archive.png') });
    console.log('shot labor_archive.png');
  }

  // 大屏模式（1920x1080 视口）
  await page.setViewport({ width: 1920, height: 1080 });
  await page.evaluate(() => { location.hash = '#/screen'; });
  await new Promise((r) => setTimeout(r, 4000));
  await page.screenshot({ path: path.join(OUT, 'screen.png') });
  const screenTitle = await page.evaluate(() => {
    const el = document.querySelector('#sc-title');
    return el ? el.textContent : '';
  });
  console.log('shot screen.png title=' + JSON.stringify(screenTitle));
  await page.evaluate(() => { document.body.classList.remove('screen-mode'); location.hash = '#/overview'; });
  await page.setViewport({ width: 1440, height: 900 });
  await new Promise((r) => setTimeout(r, 1500));

  // 有数据的历史日期（11-02）：验证看板不是空壳
  const dataDate = selectOptions.length > 1
    ? await page.evaluate(() => {
        const sel = document.querySelector('#date-select');
        const value = Array.from(sel.options).map((o) => o.value)
          .find((v) => v && v !== sel.value && v !== sel.options[0].value);
        sel.value = value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return value;
      })
    : null;
  if (dataDate) {
    for (const [name, hash] of [['overview_1102', '#/overview'], ['labor_1102', '#/labor']]) {
      await page.evaluate((h) => { location.hash = h; }, hash);
      await new Promise((r) => setTimeout(r, 3000));
      await page.screenshot({ path: path.join(OUT, name + '.png') });
      console.log('shot ' + name + '.png');
    }
    await page.setViewport({ width: 1920, height: 1080 });
    await page.evaluate(() => { location.hash = '#/screen'; });
    await new Promise((r) => setTimeout(r, 4000));
    await page.screenshot({ path: path.join(OUT, 'screen_1102.png') });
    console.log('shot screen_1102.png');
    await page.evaluate(() => { document.body.classList.remove('screen-mode'); location.hash = '#/overview'; });
    await page.setViewport({ width: 1440, height: 900 });
    await new Promise((r) => setTimeout(r, 1200));
  }

  // 切到历史日期：应出现"当前业务日…不是今天"的黄色提示
  const historyDate = dataDate;
  if (historyDate) {
    await new Promise((r) => setTimeout(r, 2200));
    await page.evaluate(() => { location.hash = '#/waves'; });
    await new Promise((r) => setTimeout(r, 1800));
    await page.screenshot({ path: path.join(OUT, 'waves_history.png') });
    const banner = await page.evaluate(() => {
      const el = document.querySelector('[data-back-today]');
      return el ? el.parentElement.textContent.trim().slice(0, 80) : '';
    });
    console.log('history date = ' + historyDate + ' | banner = ' + JSON.stringify(banner));
    console.log('shot waves_history.png');
    // 回到今天
    await page.evaluate(() => {
      const btn = document.querySelector('#btn-today');
      if (btn) btn.click();
    });
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 订单组页：展开"编辑"弹窗再截一张
  await page.evaluate(() => { location.hash = '#/orders'; });
  await new Promise((r) => setTimeout(r, 2000));
  const editBtn = await page.$('[data-edit]');
  if (editBtn) {
    await editBtn.click();
    await new Promise((r) => setTimeout(r, 800));
    await page.screenshot({ path: path.join(OUT, 'orders_edit.png') });
    console.log('shot orders_edit.png');
    await page.keyboard.press('Escape').catch(() => {});
  }

  console.log('errors=' + JSON.stringify(errors));
  await browser.close();
})().catch((err) => {
  console.error('FAILED: ' + err.message);
  process.exit(1);
});
