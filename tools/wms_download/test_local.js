#!/usr/bin/env node
/* 本地 fixture 端到端测试：不依赖真实 WMS。
 * 运行：node test_local.js
 */
'use strict';
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = __dirname;
const NODE = process.env.NODE_BIN || process.execPath;
const { deliverNameForDate } = require('./download_wms');

function serveFixture() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/' || req.url.startsWith('/test_fixture')) {
        const html = fs.readFileSync(path.join(ROOT, 'test_fixture.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function runDownload(configPath, date) {
  return new Promise((resolve) => {
    const child = spawn(NODE, [path.join(ROOT, 'download_wms.js'), '--config', configPath, '--date', date || '2026-11-05', '--headless'], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { NODE_BIN: NODE }),
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wms-download-test-'));
  const server = await serveFixture();
  const port = server.address().port;
  const config = {
    url: `http://127.0.0.1:${port}/test_fixture.html`,
    dateMode: 'fixed',
    fixedDate: '2026-11-05',
    dateFormat: 'YYYY-MM-DD',
    headless: true,
    downloadDir: path.join(tmp, 'tmp'),
    deliverDir: path.join(tmp, 'deliver'),
    archiveDir: path.join(tmp, 'downloads'),
    logDir: path.join(tmp, 'logs'),
    profileDir: path.join(tmp, 'profile'),
    keepDownloadCopy: true,
    retries: 0,
    timeoutMs: 30000,
    login: {
      username: '#username',
      password: '#password',
      submit: '#login',
      success: '.user-name'
    },
    preSteps: [],
    query: {
      dateInput: '#orderDate',
      dateFormat: 'YYYY-MM-DD',
      search: { text: '查询' },
      result: '#result-body .row',
      empty: '#empty',
      download: { text: '导出' },
      downloadWaitMs: 30000
    },
    validation: {
      extensions: ['.csv'],
      minBytes: 20,
      requiredHeaders: ['订单日期', '波次号']
    }
  };
  const configPath = path.join(tmp, 'wms.config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  fs.writeFileSync(path.join(tmp, 'secrets.local.json'), JSON.stringify({ username: 'demo', password: 'Demo12345' }), 'utf8');

  const deliverDir = path.join(tmp, 'deliver');
  const archiveDir = path.join(tmp, 'downloads');
  let failed = false;
  function check(name, ok, detail) {
    console.log((ok ? '  [OK]   ' : '  [FAIL] ') + name + (ok ? '' : '  ' + (detail || '')));
    if (!ok) failed = true;
  }

  // 交付文件命名单测（不启动浏览器）：WMS 导出名里的“导出当天”日期要换成查询日期
  const naming = [
    ['【出库】出库流程节点时间跟踪(配送中心)-2026-11-14.xlsx', '2026-11-13',
      '【出库】出库流程节点时间跟踪(配送中心)-2026-11-13.xlsx'],
    ['出库测试.csv', '2026-11-13', '出库测试-2026-11-13.csv'],
    ['报表-20261014.xlsx', '2026-11-13', '报表-2026-11-13.xlsx'],
    ['报表-2026.10.14.xlsx', '2026-11-13', '报表-2026-11-13.xlsx'],
    ['汇总-2026-10-01-配送中心.xlsx', '2026-11-13', '汇总-2026-10-01-配送中心-2026-11-13.xlsx'],
    ['2026-11-14.xlsx', '2026-11-13', '导出-2026-11-13.xlsx']
  ];
  for (const [input, day, want] of naming) {
    const got = deliverNameForDate(input, day);
    check('命名：' + input + ' + ' + day, got === want, got);
  }

  try {
    // 第一轮：查询 2026-11-05；fixture 的下载名固定带“导出日期”2026-11-04
    const result = await runDownload(configPath, '2026-11-05');
    console.log(result.stdout.split('\n').filter((x) => x.includes('下载完成') || x.includes('交付文件名') || x.includes('已交付') || x.includes('表头校验')).join('\n'));
    if (result.stderr) console.log('STDERR:', result.stderr.slice(0, 1000));
    check('脚本退出码 0', result.code === 0, 'code=' + result.code);
    const files = fs.readdirSync(deliverDir).sort();
    check('交付文件按查询日期命名', files.length === 1 && files[0] === '出库测试-2026-11-05.csv', files.join(','));
    const first = path.join(deliverDir, '出库测试-2026-11-05.csv');
    const firstStat = fs.existsSync(first) ? fs.statSync(first) : null;
    if (firstStat) {
      const text = fs.readFileSync(first, 'utf8');
      check('文件内容含查询日期和表头', text.includes('2026-11-05') && text.includes('订单日期'), text.slice(0, 120));
    }
    check('留档目录按查询日期归档',
      fs.existsSync(path.join(archiveDir, '2026-11-05', '出库测试-2026-11-05.csv')),
      fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir).join(',') : 'missing');

    // 第二轮：查询 2026-11-03；不能覆盖 11-05 的文件
    const other = await runDownload(configPath, '2026-11-03');
    check('第二轮退出码 0', other.code === 0, 'code=' + other.code);
    const after = fs.readdirSync(deliverDir).sort();
    check('两个日期文件并存',
      after.length === 2 && after.join(',') === '出库测试-2026-11-03.csv,出库测试-2026-11-05.csv', after.join(','));
    const otherFile = path.join(deliverDir, '出库测试-2026-11-03.csv');
    if (fs.existsSync(otherFile)) {
      const text = fs.readFileSync(otherFile, 'utf8');
      check('11-03 文件内容正确', text.includes('2026-11-03'), text.slice(0, 120));
    }
    if (firstStat && fs.existsSync(first)) {
      const nowStat = fs.statSync(first);
      check('11-05 文件未被第二轮覆盖',
        nowStat.size === firstStat.size && nowStat.mtimeMs === firstStat.mtimeMs,
        'size ' + firstStat.size + '->' + nowStat.size);
      check('11-05 文件内容仍是 11-05', fs.readFileSync(first, 'utf8').includes('2026-11-05'));
    }
    check('没有出现带导出日期的交付名', !after.some((x) => x.includes('2026-11-04')), after.join(','));

    // 空数据页：不交付、非 0 退出
    const emptyResult = await runDownload(configPath, '1900-01-01');
    check('空数据时退出码非 0', emptyResult.code !== 0, 'code=' + emptyResult.code);
    check('空数据不新增交付文件', fs.readdirSync(deliverDir).length === 2,
      fs.readdirSync(deliverDir).join(','));
  } finally {
    server.close();
    console.log('临时目录：' + tmp);
    process.exit(failed ? 1 : 0);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
