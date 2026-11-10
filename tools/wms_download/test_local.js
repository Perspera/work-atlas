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

  let failed = false;
  function check(name, ok, detail) {
    console.log((ok ? '  [OK]   ' : '  [FAIL] ') + name + (ok ? '' : '  ' + (detail || '')));
    if (!ok) failed = true;
  }
  try {
    const result = await runDownload(configPath, '2026-11-05');
    console.log(result.stdout.split('\n').filter((x) => x.includes('下载完成') || x.includes('已交付') || x.includes('表头校验')).join('\n'));
    if (result.stderr) console.log('STDERR:', result.stderr.slice(0, 1000));
    check('脚本退出码 0', result.code === 0, 'code=' + result.code);
    const files = fs.readdirSync(path.join(tmp, 'deliver'));
    check('交付目录有 1 个文件', files.length === 1, files.join(','));
    if (files.length) {
      const text = fs.readFileSync(path.join(tmp, 'deliver', files[0]), 'utf8');
      check('文件内容含查询日期和表头', text.includes('2026-11-05') && text.includes('订单日期'), text.slice(0, 120));
    }
    // 空数据页：不交付、非 0 退出
    const emptyResult = await runDownload(configPath, '1900-01-01');
    check('空数据时退出码非 0', emptyResult.code !== 0, 'code=' + emptyResult.code);
    check('空数据不新增交付文件', fs.readdirSync(path.join(tmp, 'deliver')).length === 1,
      fs.readdirSync(path.join(tmp, 'deliver')).join(','));
  } finally {
    server.close();
    console.log('临时目录：' + tmp);
    process.exit(failed ? 1 : 0);
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
