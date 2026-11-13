#!/usr/bin/env node
/* WMS 浏览器自动下载：登录 -> 查询页 -> 填日期 -> 查询 -> 下载 -> 校验 -> 交付。
 *
 * 用法：
 *   node download_wms.js --config wms.config.json
 *   node download_wms.js --config wms.config.json --date 2026-11-05
 *   node download_wms.js --config wms.config.json --yesterday
 *
 * 账号密码放在同目录 secrets.local.json，不要写进配置或命令行。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DEFAULT_PUPPETEER = 'C:\\Users\\Administrator\\.dsh\\profiles\\desktop\\node_modules\\puppeteer-core';
const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const DEFAULT_PYTHON = 'C:\\Users\\Administrator\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe';
const DEFAULT_SCP = 'C:\\Windows\\System32\\OpenSSH\\scp.exe';

let currentPage = null;
let currentBrowser = null;
let runDir = null;

function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function log(message) {
  const line = `[${nowText()}] ${message}`;
  console.log(line);
  try {
    if (runDir) fs.appendFileSync(path.join(runDir, 'run.log'), line + '\n', 'utf8');
  } catch (_) { /* ignore */ }
}

function fail(message, code) {
  const error = new Error(message);
  error.exitCode = code || 1;
  throw error;
}

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    fail(`读取配置失败：${file}：${error.message}`);
  }
}

function resolvePath(value, base) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(base || ROOT, value);
}

function parseArgs(argv) {
  const args = { config: path.join(ROOT, 'wms.config.json') };
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i];
    if (item === '--config') args.config = argv[++i];
    else if (item === '--date') args.date = argv[++i];
    else if (item === '--today') args.today = true;
    else if (item === '--yesterday') args.yesterday = true;
    else if (item === '--headless') args.headless = true;
    else if (item === '--headed') args.headless = false;
    else if (item === '--sync-file') args.syncFile = argv[++i];
    else if (item === '--help' || item === '-h') args.help = true;
    else fail(`未知参数：${item}`);
  }
  return args;
}

function pad(n) { return String(n).padStart(2, '0'); }
function localDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function formatDate(isoDate, format) {
  const [y, m, d] = String(isoDate).split('-');
  return String(format || 'YYYY-MM-DD')
    .replace(/YYYY/g, y).replace(/MM/g, m).replace(/DD/g, d);
}
function pickSearchDate(config, args) {
  if (args.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.date)) fail(`日期格式应为 YYYY-MM-DD：${args.date}`);
    return args.date;
  }
  if (args.today) return localDate(0);
  if (args.yesterday) return localDate(-1);
  const mode = config.dateMode || 'yesterday';
  if (mode === 'today') return localDate(0);
  if (mode === 'yesterday') return localDate(-1);
  if (mode === 'fixed') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(config.fixedDate || ''))) fail('dateMode=fixed 时必须配置 fixedDate');
    return config.fixedDate;
  }
  if (mode === 'relative') {
    const offset = Number(config.relativeDays);
    if (!Number.isFinite(offset)) fail('dateMode=relative 时必须配置 relativeDays');
    return localDate(offset);
  }
  fail(`未知 dateMode：${mode}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function singleInstanceLock() {
  const lock = path.join(ROOT, '.wms_download.lock');
  if (fs.existsSync(lock)) {
    const pid = Number(fs.readFileSync(lock, 'utf8').trim());
    if (pid) {
      try {
        process.kill(pid, 0);
        fail(`已有下载任务在运行（PID ${pid}）`, 2);
      } catch (error) {
        if (error.exitCode) throw error;
        // 进程已退出，允许接管
      }
    }
  }
  fs.writeFileSync(lock, String(process.pid), 'utf8');
  return () => {
    try { fs.unlinkSync(lock); } catch (_) { /* ignore */ }
  };
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForAny(page, selectors, timeout) {
  const list = (selectors || []).filter(Boolean);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const selector of list) {
      try {
        const el = await page.$(selector);
        if (el && await page.evaluate((node) => !!(node.offsetWidth || node.offsetHeight || node.getClientRects().length), el)) {
          return selector;
        }
      } catch (_) { /* selector may not support */ }
    }
    await sleep(250);
  }
  return null;
}

async function elementVisible(page, selector) {
  if (!selector) return false;
  try {
    return await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    }, selector);
  } catch (_) {
    return false;
  }
}

async function safeEval(page, fn, ...args) {
  let last = null;
  for (let i = 0; i < 12; i++) {
    try { return await page.evaluate(fn, ...args); }
    catch (error) {
      last = error;
      if (!/Execution context was destroyed|Cannot find context|Target closed/i.test(error.message)) throw error;
      await sleep(800);
    }
  }
  throw last;
}

async function waitPortalReady(page, config) {
  const timeout = Math.max(30000, config.portalWaitMs || 90000);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const state = await safeEval(page, () => ({
        menu: !!document.querySelector('li.sMenu'),
        login: !!document.querySelector('input[type=password]'),
        url: location.href
      }));
      if (state.menu) return state;
      if (state.login && !config.login?.skip && config.login?.username) return state;
    } catch (_) { /* navigation in progress */ }
    await sleep(1000);
  }
  fail('等待 WMS 门户加载超时（检查 VPN/SSO 是否登录）');
}

async function openReport(page, config) {
  const query = config.query || {};
  if (config.queryUrl) {
    await goto(page, config.queryUrl, config.timeoutMs);
  } else if (config.menuItemText) {
    const menuText = String(config.menuItemText);
    const formDeadline = Date.now() + Math.max(30000, config.formWaitMs || 60000);
    let opened = false;
    let attempts = 0;
    while (Date.now() < formDeadline && attempts < 6) {
      attempts += 1;
      try {
        const result = await safeEval(page, (needle) => {
          const lis = Array.from(document.querySelectorAll('li.sMenu'));
          const li = lis.find((x) => (x.title || x.innerText || '').includes(needle));
          if (!li) return { ok: false, count: lis.length };
          const a = li.querySelector('a');
          li.scrollIntoView({ block: 'center' });
          (a || li).click();
          return { ok: true, title: li.title || li.innerText };
        }, menuText);
        if (result.ok) log(`已点击菜单（第 ${attempts} 次）：${result.title}`);
        else log(`菜单暂未出现（第 ${attempts} 次），继续等待`);
      } catch (_) { /* navigation */ }
      // 给页面/框架一点时间；同一菜单偶尔第一次只展开父级
      for (let i = 0; i < 15; i++) {
        try {
          if (await page.evaluate((sel) => !!document.querySelector(sel), query.dateInput)) {
            opened = true;
            break;
          }
        } catch (_) { /* navigation */ }
        await sleep(1000);
      }
      if (opened) break;
    }
    if (!opened) fail(`点击菜单后没有出现查询页：${menuText}`);
  }
  if (config.preSteps && config.preSteps.length) await runPreSteps(page, config.preSteps, config.timeoutMs);
  // 等查询表单出现，期间可能有导航
  const deadline = Date.now() + Math.max(30000, config.formWaitMs || 60000);
  while (Date.now() < deadline) {
    try {
      if (await page.evaluate((sel) => !!document.querySelector(sel), query.dateInput)) return;
    } catch (_) { /* navigation */ }
    await sleep(800);
  }
  fail(`查询页没有出现日期输入框：${query.dateInput}`);
}

async function exportViaCapturedForm(page, query, downloadDir, timeout) {
  const exp = query.exportDialog || {};
  const grid = exp.grid || '#g_plat_customize_report_export_settings';
  const confirmText = exp.confirmText || '导出';
  const waitMs = exp.waitMs || 60000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await page.evaluate((sel) => !!document.querySelector(sel), grid).catch(() => false)) break;
    await sleep(500);
  }
  if (!await page.evaluate((sel) => !!document.querySelector(sel), grid).catch(() => false)) {
    fail('导出设置弹窗没有出现');
  }
  // 等 jqGrid 初始化；默认通常已全选，仅在没有选中行时补选，避免反选
  let selected = -1;
  const readyDeadline = Date.now() + 20000;
  while (Date.now() < readyDeadline) {
    selected = await safeEval(page, (sel) => {
      const $grid = window.jQuery && window.jQuery(sel);
      if (!$grid || !$grid.length || !$grid.jqGrid) return -1;
      try {
        const ids = $grid.jqGrid('getDataIDs') || [];
        if (!ids.length) return -1;
        return ($grid.jqGrid('getGridParam', 'selarrrow') || []).length;
      } catch (_) { return -1; }
    }, grid).catch(() => -1);
    if (selected >= 0) break;
    await sleep(500);
  }
  if (selected <= 0) {
    selected = await safeEval(page, (sel) => {
      const $grid = window.jQuery && window.jQuery(sel);
      if (!$grid || !$grid.length || !$grid.jqGrid) return 0;
      const ids = $grid.jqGrid('getDataIDs') || [];
      ids.forEach((id) => $grid.jqGrid('setSelection', id, false));
      return ($grid.jqGrid('getGridParam', 'selarrrow') || []).length;
    }, grid).catch(() => 0);
  }
  log(`导出列已选：${selected} 行`);
  if (exp.allDataText) {
    await safeEval(page, (text) => {
      const dialogs = Array.from(document.querySelectorAll('.ui-dialog'));
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return;
      const nodes = Array.from(dialog.querySelectorAll('label, span, input'));
      const hit = nodes.find((x) => (x.innerText || x.value || '').includes(text));
      if (hit) hit.click();
    }, exp.allDataText).catch(() => {});
  }
  // 拦截表单 submit：WMS 的 excel.do 通过 target=_blank 提交，直接抓参数更稳
  await safeEval(page, () => {
    window.__capturedExportForms = [];
    window.__origFormSubmit = HTMLFormElement.prototype.submit;
    HTMLFormElement.prototype.submit = function () {
      try {
        window.__capturedExportForms.push({
          action: this.action,
          method: this.method || 'POST',
          enctype: this.enctype || '',
          inputs: Array.from(this.elements).map((el) => ({ name: el.name, value: el.value }))
        });
      } catch (_) { /* ignore */ }
    };
  });
  let triggered = false;
  try {
    triggered = await safeEval(page, ({ confirm, funcName }) => {
      if (funcName && typeof window[funcName] === 'function') {
        const dialogs = Array.from(document.querySelectorAll('.ui-dialog'));
        const dialog = dialogs[dialogs.length - 1];
        let id = '';
        if (dialog) {
          const hit = Array.from(dialog.querySelectorAll('button')).find((x) => (x.innerText || '').trim() === confirm);
          if (hit) id = hit.id;
        }
        try { window[funcName](id); return true; } catch (_) { /* fall through */ }
      }
      const dialogs = Array.from(document.querySelectorAll('.ui-dialog'));
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return false;
      const hit = Array.from(dialog.querySelectorAll('button')).find((x) => (x.innerText || '').trim() === confirm);
      if (!hit) return false;
      hit.click();
      return true;
    }, { confirm: confirmText, funcName: exp.functionName || 'exportData' });
  } finally {
    await safeEval(page, () => {
      if (window.__origFormSubmit) HTMLFormElement.prototype.submit = window.__origFormSubmit;
    }).catch(() => {});
  }
  if (!triggered) fail('未能触发出库文件导出');
  // 等待表单被捕捉（exportData 同步；plat.action 可能异步）
  let forms = [];
  const waitForms = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      forms = await page.evaluate(() => window.__capturedExportForms || []).catch(() => []);
      if (forms.length) return true;
      await sleep(500);
    }
    return false;
  };
  await waitForms(10000);
  if (!forms.length) {
    log('第一次未捕获导出表单，补选并重试一次');
    await safeEval(page, (sel) => {
      const $grid = window.jQuery && window.jQuery(sel);
      if (!$grid || !$grid.length || !$grid.jqGrid) return;
      const ids = $grid.jqGrid('getDataIDs') || [];
      if (!($grid.jqGrid('getGridParam', 'selarrrow') || []).length) {
        ids.forEach((id) => $grid.jqGrid('setSelection', id, false));
      }
    }, grid).catch(() => {});
    await safeEval(page, (confirm) => {
      const dialog = Array.from(document.querySelectorAll('.ui-dialog')).pop();
      if (!dialog) return;
      const hit = Array.from(dialog.querySelectorAll('button')).find((x) => (x.innerText || '').trim() === confirm);
      if (hit) hit.click();
    }, confirmText).catch(() => {});
    await waitForms(8000);
  }
  if (!forms.length) fail('未捕获到 WMS 导出表单，无法下载');
  const form = forms[forms.length - 1];
  log(`捕获导出表单：${form.action}（${form.inputs.length} 个字段）`);
  const result = await page.evaluate(async (payload) => {
    const body = new URLSearchParams();
    payload.inputs.forEach((item) => body.append(item.name, item.value));
    const response = await fetch(payload.action, { method: payload.method || 'POST', body, credentials: 'include' });
    const buffer = await response.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return {
      status: response.status,
      type: response.headers.get('content-type') || '',
      disposition: response.headers.get('content-disposition') || '',
      size: bytes.length,
      data: btoa(binary)
    };
  }, form);
  if (result.status !== 200 || !result.data) fail(`导出请求失败：HTTP ${result.status}`);
  let name = '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(result.disposition || '');
  if (match) {
    try { name = decodeURIComponent(match[1]); } catch (_) { name = match[1]; }
  }
  if (!name) {
    const fileInput = form.inputs.find((x) => x.name === 'fileName');
    name = (fileInput && fileInput.value) || `导出-${Date.now()}.xlsx`;
  }
  name = path.basename(name).replace(/[\\/:*?"<>|]+/g, '_');
  const target = path.join(downloadDir, name);
  fs.writeFileSync(target, Buffer.from(result.data, 'base64'));
  log(`导出文件已保存：${name}（${result.size} 字节，${result.type}）`);
  return target;
}

async function clickExportDialog(page, query) {
  const exportCfg = query.exportDialog || {};
  const grid = exportCfg.grid || '#g_plat_customize_report_export_settings';
  const waitMs = exportCfg.waitMs || 60000;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const ready = await page.evaluate((sel) => !!document.querySelector(sel), grid).catch(() => false);
    if (ready) break;
    await sleep(500);
  }
  if (!await page.evaluate((sel) => !!document.querySelector(sel), grid).catch(() => false)) {
    fail('导出设置弹窗没有出现');
  }
  // 勾选所有可导出列/行
  await safeEval(page, (sel) => {
    const $grid = window.jQuery ? window.jQuery(sel) : null;
    if (!$grid || !$grid.length || !$grid.jqGrid) return;
    try {
      const ids = $grid.jqGrid('getDataIDs') || [];
      ids.forEach((id) => $grid.jqGrid('setSelection', id, false));
    } catch (_) { /* ignore */ }
  }, grid);
  // 选择“所有过滤数据”
  if (exportCfg.allDataText) {
    try {
      await safeEval(page, (text) => {
        const $dialogs = window.jQuery ? window.jQuery('.ui-dialog') : null;
        if ($dialogs && $dialogs.length) {
          const nodes = Array.from($dialogs[$dialogs.length - 1].querySelectorAll('label, span, input'));
          const hit = nodes.find((x) => (x.innerText || x.value || '').includes(text));
          if (hit) hit.click();
        }
      }, exportCfg.allDataText);
    } catch (_) { /* ignore */ }
  }
  // 优先调用页面自带 exportData（WMS 的导出按钮绑定此函数）
  const usedFunction = await safeEval(page, (confirmText) => {
    if (typeof window.exportData !== 'function') return false;
    const dialogs = Array.from(document.querySelectorAll('.ui-dialog'));
    const dialog = dialogs[dialogs.length - 1];
    if (!dialog) return false;
    const buttons = Array.from(dialog.querySelectorAll('button'));
    const hit = buttons.find((x) => (x.innerText || '').trim() === confirmText);
    const invokeId = hit ? hit.id : '';
    try { window.exportData(invokeId); return true; } catch (_) { return false; }
  }, exportCfg.confirmText || '导出').catch(() => false);
  if (!usedFunction) {
    await safeEval(page, (confirmText) => {
      const dialogs = Array.from(document.querySelectorAll('.ui-dialog'));
      const dialog = dialogs[dialogs.length - 1];
      if (!dialog) return false;
      const buttons = Array.from(dialog.querySelectorAll('button'));
      const hit = buttons.find((x) => (x.innerText || '').trim() === confirmText);
      if (!hit) return false;
      hit.click();
      return true;
    }, exportCfg.confirmText || '导出');
  }
}

async function clickBySelectorOrText(page, target, timeout) {
  if (!target) fail('配置缺少查询/下载按钮选择器或文字');
  const selector = typeof target === 'string' ? target : target.selector;
  const text = typeof target === 'object' ? target.text : '';
  const limit = timeout || 15000;
  if (selector) {
    await page.waitForSelector(selector, { visible: true, timeout: limit });
    await page.click(selector);
    return selector;
  }
  if (!text) fail('配置缺少按钮 selector/text');
  const clicked = await page.evaluate((wanted) => {
    const norm = (v) => String(v || '').replace(/\s+/g, '').trim();
    const nodes = Array.from(document.querySelectorAll('button, a, span, div, li, input[type=button], input[type=submit]'));
    const hits = nodes.filter((el) => {
      const label = norm(el.innerText || el.value || el.getAttribute('aria-label') || el.title);
      if (label !== norm(wanted)) return false;
      const style = getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled &&
        !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    });
    if (!hits.length) return false;
    // 选择最内层元素，避免点到外层容器
    const node = hits[hits.length - 1];
    node.scrollIntoView({ block: 'center' });
    node.click();
    return true;
  }, text);
  if (!clicked) fail(`页面上找不到按钮/文字：${text}`);
  return text;
}

async function setInputValue(page, selector, value) {
  if (!selector) fail('配置缺少日期输入框选择器');
  await page.waitForSelector(selector, { timeout: 15000 });
  const ok = await page.evaluate(({ sel, val }) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    try { setter.call(el, val); } catch (_) { el.value = val; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
    el.blur();
    return true;
  }, { sel: selector, val: value });
  if (!ok) fail(`无法填写日期框：${selector}`);
}

async function goto(page, url, timeout, waitUntil) {
  if (!url) fail('配置缺少 url');
  log(`打开页面：${url}`);
  await page.goto(url, { waitUntil: waitUntil || 'domcontentloaded', timeout: timeout || 60000 });
  await sleep(500);
}

async function captureFailure(page, reason) {
  if (!runDir) return;
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  try {
    if (page) {
      await page.screenshot({ path: path.join(runDir, `fail-${stamp}.png`), fullPage: false });
      const html = await page.content();
      fs.writeFileSync(path.join(runDir, `fail-${stamp}.html`), html, 'utf8');
      log(`失败现场已保存：fail-${stamp}.png/html（${reason}）`);
    }
  } catch (error) {
    log(`保存失败现场失败：${error.message}`);
  }
}

async function doLogin(page, config, secrets) {
  const login = config.login || {};
  if (login.skip) {
    log('login.skip=true，跳过登录（使用 WMS 门户/SSO 已登录会话）');
    return;
  }
  if (!login.username || !login.password || !login.submit) {
    if (login.assumeLoggedInIfNoForm) { log('未配置登录表单，按已登录处理'); return; }
    fail('配置缺少 login.username/password/submit');
  }
  if (login.success && await elementVisible(page, login.success)) {
    log('检测到已登录，跳过登录');
    return;
  }
  if (await elementVisible(page, login.username)) {
    log(`登录账号：${secrets.username}`);
    await page.waitForSelector(login.username, { visible: true, timeout: 15000 });
    await page.click(login.username);
    await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, login.username);
    await page.type(login.username, secrets.username, { delay: 15 });
    await page.click(login.password);
    await page.evaluate((sel) => { const el = document.querySelector(sel); if (el) el.value = ''; }, login.password);
    await page.type(login.password, secrets.password, { delay: 15 });
    if (login.captcha && await elementVisible(page, login.captcha)) {
      fail('页面出现验证码，自动登录无法继续；请人工登录一次或使用 manualLogin 模式');
    }
    log('提交登录');
    await clickBySelectorOrText(page, login.submit, 15000);
    if (login.success) {
      const found = await waitForAny(page, [login.success], config.timeoutMs || 60000);
      if (!found) fail('登录后未检测到成功标志，可能账号/密码错误或需要验证码');
    } else {
      await page.waitForNetworkIdle({ idleTime: 800, timeout: config.timeoutMs || 60000 }).catch(() => {});
    }
    await sleep(800);
  } else if (login.success && await elementVisible(page, login.success)) {
    log('检测到已登录，跳过登录');
  } else if (login.assumeLoggedInIfNoForm) {
    log('未发现登录表单，按已登录处理');
  } else if (config.manualLogin) {
    fail('当前未登录，且配置为 manualLogin；请先用可见浏览器登录一次');
  } else {
    fail('找不到登录账号输入框，请检查 login.username 选择器/URL');
  }
}

async function runPreSteps(page, steps, timeout) {
  for (const step of steps || []) {
    if (!step || !step.type) continue;
    if (step.type === 'click') {
      log(`点击：${step.text || step.selector}`);
      await clickBySelectorOrText(page, step, timeout || 15000);
      await sleep(step.waitMs || 800);
    } else if (step.type === 'wait') {
      await sleep(step.ms || 1000);
    } else if (step.type === 'waitFor') {
      await page.waitForSelector(step.selector, { visible: true, timeout: step.timeout || timeout || 30000 });
    } else if (step.type === 'goto') {
      await goto(page, step.url, timeout);
    } else {
      fail(`未知 preSteps 类型：${step.type}`);
    }
  }
}

async function setSearchDate(page, query, date) {
  if (!query.dateInput) fail('配置缺少 query.dateInput');
  const formatted = formatDate(date, query.dateFormat || 'YYYY-MM-DD');
  log(`填写查询日期：${formatted}`);
  await setInputValue(page, query.dateInput, formatted);
  if (query.dateEndInput) {
    await setInputValue(page, query.dateEndInput, formatDate(query.dateEnd, query.dateFormat || 'YYYY-MM-DD'));
  }
}

async function waitQueryResult(page, query, timeout) {
  const result = query.result;
  const empty = query.empty;
  const emptyText = query.emptyText || '没有记录';
  const loadingText = query.loadingText || '读取中';
  const deadline = Date.now() + Math.max(30000, timeout || 120000);
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(({ resultSel, emptySel, emptyTxt, loadingTxt }) => {
        const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const rows = resultSel ? Array.from(document.querySelectorAll(resultSel)).filter(visible).length : 0;
        const emptyHit = (emptySel && visible(document.querySelector(emptySel))) ||
          (loadingTxt === '' && emptyTxt && document.body.innerText.includes(emptyTxt));
        const bodyText = document.body.innerText || '';
        return { rows, emptyHit, loading: bodyText.includes(loadingTxt) };
      }, { resultSel: result, emptySel: empty, emptyTxt: emptyText, loadingTxt: loadingText });
      if (state.rows > 0) return { rows: state.rows };
      if (!state.loading && (state.emptyHit || (emptyText && await page.evaluate((t) => (document.body.innerText || '').includes(t), emptyText)))) {
        fail('查询结果为空（页面显示空态），不下载', 3);
      }
    } catch (_) { /* navigation/refresh */ }
    if (!result) {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 }).catch(() => {});
      return { rows: null };
    }
    await sleep(2000);
  }
  fail('等待查询结果超时，页面没有结果行（WMS 查询可能超过 2 分钟）');
}

function findNewDownload(downloadDir, startedAt, extensions) {
  const exts = (extensions || []).map((x) => String(x).toLowerCase());
  let files = [];
  try { files = fs.readdirSync(downloadDir); } catch (_) { return null; }
  const candidates = [];
  for (const name of files) {
    if (name.endsWith('.crdownload') || name.endsWith('.tmp')) continue;
    const full = path.join(downloadDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (!stat.isFile()) continue;
    if (stat.mtimeMs < startedAt - 2000) continue;
    if (exts.length && !exts.includes(path.extname(name).toLowerCase())) continue;
    candidates.push({ name, full, mtime: stat.mtimeMs, size: stat.size });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0] || null;
}

async function waitDownload(downloadDir, startedAt, extensions, timeout) {
  const deadline = Date.now() + timeout;
  let last = null;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const candidate = findNewDownload(downloadDir, startedAt, extensions);
    if (candidate) {
      if (last && last.name === candidate.name && last.size === candidate.size) {
        if (!stableSince) stableSince = Date.now();
        if (Date.now() - stableSince >= 1200) return candidate;
      } else {
        stableSince = 0;
      }
      last = candidate;
    }
    await sleep(300);
  }
  fail('等待下载文件超时（未发现稳定文件）');
}

async function saveFetchDownload(page, urlTemplate, date, targetDir) {
  const url = String(urlTemplate).replace(/\{date\}/g, date);
  log(`通过登录态直接请求下载：${url}`);
  const encoded = await page.evaluate(async (requestUrl) => {
    const res = await fetch(requestUrl, { credentials: 'include' });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buffer = await res.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return { data: btoa(binary) };
  }, url);
  if (encoded.error) fail(`直接下载失败：${encoded.error}`);
  const target = path.join(targetDir, `download-${date}.xlsx`);
  fs.writeFileSync(target, Buffer.from(encoded.data, 'base64'));
  return target;
}

function validateFile(file, validation) {
  const ext = path.extname(file).toLowerCase();
  const exts = (validation && validation.extensions) || [];
  if (exts.length && !exts.map((x) => String(x).toLowerCase()).includes(ext)) {
    fail(`下载文件扩展名不符合：${ext}`);
  }
  const stat = fs.statSync(file);
  const min = Number(validation && validation.minBytes) || 1;
  if (stat.size < min) fail(`下载文件过小：${stat.size} 字节`);
  return stat;
}

function _syncSettings(config) {
  const raw = config.serverSync || {};
  const target = String(raw.target || '').trim();
  const remoteDir = String(raw.remoteDir || '').trim();
  if (!target || !remoteDir) return null;
  const scpPath = raw.scpPath || DEFAULT_SCP;
  if (!fs.existsSync(scpPath)) fail(`找不到 scp：${scpPath}`);
  return {
    target,
    remoteDir: remoteDir.replace(/\\/g, '/').replace(/\/+$/, ''),
    scpPath,
    sshPath: raw.sshPath || path.join(path.dirname(scpPath), 'ssh.exe'),
    timeoutMs: Number(raw.timeoutMs) || 120000,
    required: raw.required !== false,
    // 服务器上看板只扫描 share 目录，文件名保持原样（含中文），用 -- 保护以 - 开头的名字
  };
}

function pushToServer(localFile, config, tag) {
  const settings = _syncSettings(config);
  if (!settings) {
    log('未配置 serverSync，跳过服务器同步');
    return { synced: false, skipped: true };
  }
  const name = path.basename(localFile);
  const remotePath = `${settings.remoteDir}/${name}`;
  const opts = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=20'];
  log(`同步到服务器：${settings.target}:${remotePath}`);
  const put = spawnSync(
    settings.scpPath,
    [...opts, localFile, `${settings.target}:${remotePath}`],
    { encoding: 'utf8', windowsHide: true, timeout: settings.timeoutMs }
  );
  if (put.status !== 0) {
    const detail = (put.stderr || put.stdout || put.error?.message || '').trim();
    const message = `同步到服务器失败（${tag || 'deliver'}）：${detail || `scp 退出码 ${put.status}`}`;
    if (settings.required) fail(message);
    log(`警告：${message}`);
    return { synced: false, error: message };
  }
  const size = fs.statSync(localFile).size;
  const check = spawnSync(
    settings.sshPath,
    [...opts, settings.target, `stat -c %s -- ${JSON.stringify(remotePath)}`],
    { encoding: 'utf8', windowsHide: true, timeout: settings.timeoutMs }
  );
  const remoteSize = Number(String(check.stdout || '').trim());
  if (check.status !== 0 || !Number.isFinite(remoteSize)) {
    const detail = (check.stderr || check.stdout || '').trim();
    const message = `服务器文件校验失败：${detail || '无法读取远端文件大小'}`;
    if (settings.required) fail(message);
    log(`警告：${message}`);
    return { synced: false, error: message };
  }
  if (remoteSize !== size) {
    const message = `服务器文件大小不一致：本地 ${size} 字节，远端 ${remoteSize} 字节`;
    if (settings.required) fail(message);
    log(`警告：${message}`);
    return { synced: false, error: message };
  }
  log(`已同步到服务器：${remotePath}（${size} 字节）`);
  return { synced: true, remote: remotePath, size };
}

function validateHeaders(file, validation, pythonPath) {
  const required = (validation && validation.requiredHeaders) || [];
  if (!required.length) return;
  if (!pythonPath || !fs.existsSync(pythonPath)) {
    log(`未找到 Python，跳过表头校验：${pythonPath || '(未配置)'}`);
    return;
  }
  const script = path.join(ROOT, 'validate_download.py');
  if (!fs.existsSync(script)) {
    log('未找到 validate_download.py，跳过表头校验');
    return;
  }
  const result = spawnSync(pythonPath, [script, file, JSON.stringify(required)], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    fail(`表头/内容校验失败：${(result.stderr || result.stdout || '').trim() || '未知错误'}`);
  }
  log(`表头校验通过：${(result.stdout || '').trim()}`);
}

function findChrome(config) {
  const localAppData = process.env.LOCALAPPDATA || '';
  const candidates = [
    config.chromePath,
    process.env.CHROME_PATH,
    localAppData ? path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe') : '',
    DEFAULT_CHROME,
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const item of candidates) {
    if (fs.existsSync(item)) return item;
  }
  return '';
}

async function openBrowser(config) {
  const puppeteerPath = process.env.PUPPETEER_CORE_PATH || config.puppeteerPath || DEFAULT_PUPPETEER;
  let puppeteer;
  try { puppeteer = require(puppeteerPath); }
  catch (error) { fail(`无法加载 puppeteer-core：${puppeteerPath}\n${error.message}`); }
  const executablePath = findChrome(config);
  if (!executablePath) fail(`Chrome 不存在：${config.chromePath || DEFAULT_CHROME}（可在 wms.config.json 配置 chromePath）`);

  const userDataDir = resolvePath(config.profileDir || 'profile', ROOT);
  ensureDir(userDataDir);
  const headless = config.headless === true;
  log(`启动 Chrome（${headless ? '无头' : '可见'}），profile：${userDataDir}`);
  const browser = await puppeteer.launch({
    executablePath,
    headless,
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1440,900',
      '--disable-features=TranslateUI',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });
  return browser;
}

async function downloadFlow(config, args, secrets) {
  const date = pickSearchDate(config, args);
  const timeout = config.timeoutMs || 60000;
  const downloadDir = resolvePath(config.downloadDir || 'downloads/tmp', ROOT);
  const deliverDir = resolvePath(config.deliverDir || 'deliver', ROOT);
  const keepCopy = config.keepDownloadCopy !== false;
  // 每轮清空临时下载目录，避免误把上一次的文件当成本次结果
  try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  ensureDir(downloadDir);
  ensureDir(deliverDir);
  ensureDir(runDir);
  log(`本次查询日期：${date}`);
  log(`临时下载目录：${downloadDir}`);
  log(`交付目录：${deliverDir}`);

  const browser = await openBrowser(config);
  currentBrowser = browser;
  try {
    const context = browser.defaultBrowserContext ? browser.defaultBrowserContext() : null;
    const cdp = await browser.target().createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });

    const page = await browser.newPage();
    currentPage = page;
    page.setDefaultTimeout(timeout);
    await page.setViewport({ width: Number(config.viewportWidth) || 1600, height: Number(config.viewportHeight) || 1000 });
    await goto(page, config.url, timeout, 'networkidle2');
    await waitPortalReady(page, config);
    await sleep(2500);
    await doLogin(page, config, secrets);
    const query = config.query || {};
    if (!config.queryUrl) {
      await waitPortalReady(page, config);
    }
    await sleep(2000);
    await openReport(page, config);
    await page.waitForSelector(query.dateInput, { visible: true, timeout });
    await setSearchDate(page, query, date);
    log('点击查询');
    await clickBySelectorOrText(page, query.search || { text: '查询' }, timeout);
    await waitQueryResult(page, query, Math.max(15000, timeout));

    const startedAt = Date.now();
    let downloaded = null;
    if (query.downloadFetchUrl) {
      downloaded = await saveFetchDownload(page, query.downloadFetchUrl, date, downloadDir);
    } else {
      log('点击下载/导出');
      await clickBySelectorOrText(page, query.download || { text: '导出' }, timeout);
      if (query.exportDialog && query.exportDialog.captureForm) {
        downloaded = await exportViaCapturedForm(page, query, downloadDir, timeout);
      } else {
        if (query.exportDialog) await clickExportDialog(page, query);
        downloaded = (await waitDownload(
          downloadDir, startedAt, (config.validation && config.validation.extensions) || [], query.downloadWaitMs || 120000
        )).full;
      }
    }
    log(`下载完成：${path.basename(downloaded)}`);
    const stat = validateFile(downloaded, config.validation || {});
    validateHeaders(downloaded, config.validation || {}, config.pythonPath || DEFAULT_PYTHON);
    log(`文件校验通过：${stat.size} 字节`);

    const targetName = path.basename(downloaded);
    let target = path.join(deliverDir, targetName);
    if (fs.existsSync(target) && config.overwriteDeliver === false) {
      target = path.join(deliverDir, `${path.parse(targetName).name}-${date}${path.extname(targetName)}`);
    }
    fs.copyFileSync(downloaded, target);
    log(`已交付：${target}`);
    if (keepCopy) {
      const archiveDir = path.join(ROOT, 'downloads', date);
      ensureDir(archiveDir);
      fs.copyFileSync(downloaded, path.join(archiveDir, `${date}-${targetName}`));
    }
    // 交付目录若是网络盘/本机目录，服务器扫不到，再推一份到服务器数据源目录
    const sync = pushToServer(target, config, 'deliver');
    return { date, file: target, size: stat.size, source: downloaded, sync };
  } catch (error) {
    await captureFailure(currentPage, error.message);
    throw error;
  } finally {
    try { await browser.close(); } catch (_) { /* ignore */ }
    currentBrowser = null;
    currentPage = null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node download_wms.js --config wms.config.json [--date YYYY-MM-DD|--today|--yesterday] [--headless|--headed]');
    console.log('      node download_wms.js --config wms.config.json --sync-file <本地文件>   # 只补传文件到服务器数据源目录');
    return 0;
  }
  const configPath = resolvePath(args.config, ROOT);
  const config = loadJson(configPath);
  if (args.headless !== undefined) config.headless = args.headless;
  const secretsPath = resolvePath(config.secretsFile || 'secrets.local.json', path.dirname(configPath));
  const secrets = loadJson(secretsPath, null);
  if (!secrets || !secrets.username || !secrets.password) {
    if (config.manualLogin || (config.login && config.login.skip)) {
      log('未配置账号密码：使用已登录 session（manualLogin/login.skip）');
    } else {
      fail(`未找到账号配置：${secretsPath}\n请复制 secrets.local.example.json 为 secrets.local.json 并填写（不要提交到代码库）`);
    }
  }
  runDir = resolvePath(config.logDir || 'logs', ROOT);
  ensureDir(runDir);
  if (args.syncFile) {
    // 只做补传：把本地已有文件推到服务器数据源目录（不启动浏览器）
    const local = resolvePath(args.syncFile, ROOT);
    if (!fs.existsSync(local)) fail(`找不到要同步的文件：${local}`);
    const stat = fs.statSync(local);
    validateFile(local, config.validation || {});
    const sync = pushToServer(local, config, 'manual');
    log(`完成：${JSON.stringify({ file: local, size: stat.size, sync })}`);
    return sync.synced || sync.skipped ? 0 : 1;
  }
  const release = singleInstanceLock();
  try {
    const retries = Math.max(0, Math.min(3, Number(config.retries) || 0));
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        if (attempt > 0) log(`第 ${attempt + 1} 次尝试`);
        const result = await downloadFlow(config, args, secrets || {});
        log(`完成：${JSON.stringify(result)}`);
        return 0;
      } catch (error) {
        lastError = error;
        await captureFailure(currentPage, error.message);
        if (error.exitCode === 3 || /验证码|账号|密码|登录|配置|找不到/.test(error.message)) break;
        if (attempt < retries) {
          log(`失败，${8000}ms 后重试：${error.message}`);
          await sleep(8000);
        }
      }
    }
    log(`失败：${lastError ? lastError.message : '未知错误'}`);
    return lastError && lastError.exitCode ? lastError.exitCode : 1;
  } finally {
    release();
  }
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(error.exitCode || 1);
});
