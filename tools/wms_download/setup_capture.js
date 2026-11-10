#!/usr/bin/env node
/* 首次配置辅助：打开可见 Chrome，人工登录并导航到查询页，按 Enter 后抓取截图/DOM/控件清单。
 *
 * 用法：
 *   node setup_capture.js --config wms.config.json
 *   node setup_capture.js --url https://wms.example.com/
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = __dirname;
const DEFAULT_PUPPETEER = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules\\puppeteer-core';
const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}
function resolvePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(ROOT, value);
}
function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

(async () => {
  const configPath = resolvePath(arg('--config') || 'wms.config.json');
  const config = loadJson(configPath, {});
  const url = arg('--url') || config.url;
  if (!url) {
    console.error('缺少 WMS URL：请用 --url 或填写 wms.config.json 的 url');
    process.exit(1);
  }
  const puppeteerPath = process.env.PUPPETEER_CORE_PATH || config.puppeteerPath || DEFAULT_PUPPETEER;
  const puppeteer = require(puppeteerPath);
  const chromePath = config.chromePath || DEFAULT_CHROME;
  const userDataDir = resolvePath(config.profileDir || 'profile');
  fs.mkdirSync(userDataDir, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    userDataDir,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1440,960', '--no-first-run']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 960 });
  console.log('打开：' + url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('');
  console.log('请在打开的浏览器里完成：');
  console.log('  1) 登录；');
  console.log('  2) 进入“按日期查询 + 导出/下载”的页面；');
  console.log('  3) 回到这个窗口按 Enter，抓取页面现场。');
  console.log('');
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('准备好后按 Enter：', () => { rl.close(); resolve(); });
  });
  const dir = path.join(ROOT, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const base = path.join(dir, 'setup-' + stamp());
  await page.screenshot({ path: base + '.png', fullPage: false });
  fs.writeFileSync(base + '.html', await page.content(), 'utf8');
  const controls = await page.evaluate(() => {
    function selectorOf(el) {
      if (el.id) return '#' + CSS.escape(el.id);
      if (el.getAttribute('name')) return el.tagName.toLowerCase() + '[name="' + el.getAttribute('name') + '"]';
      const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) return el.tagName.toLowerCase() + '.' + cls.map((c) => CSS.escape(c)).join('.');
      return el.tagName.toLowerCase();
    }
    const nodes = Array.from(document.querySelectorAll('input, textarea, select, button, a'));
    return nodes.filter((el) => {
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && !!(el.offsetWidth || el.offsetHeight);
    }).map((el) => ({
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || '',
      name: el.getAttribute('name') || '',
      id: el.id || '',
      className: (el.className || '').toString().slice(0, 120),
      text: (el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim().slice(0, 80)
    }));
  });
  fs.writeFileSync(base + '.controls.json', JSON.stringify(controls, null, 2), 'utf8');
  console.log('');
  console.log('已保存：');
  console.log('  ' + base + '.png');
  console.log('  ' + base + '.html');
  console.log('  ' + base + '.controls.json');
  console.log('');
  console.log('控件清单（可用于填 wms.config.json）：');
  controls.forEach((item) => {
    console.log(`  ${item.selector}  <${item.tag}${item.type ? ' type=' + item.type : ''}>  ${item.text}`);
  });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
