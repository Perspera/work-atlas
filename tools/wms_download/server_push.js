#!/usr/bin/env node
/* 把本地 WMS 文件推送到看板服务器：HTTP 上传即入库（默认），或回退到 scp 拷贝。
 *
 * 默认 transport=http：POST 到 <serverSync.url>/api/ingest/upload，带机器令牌
 * （secrets.local.json 的 dashboardToken）。服务器落盘到数据源目录后立刻扫描入库，
 * 响应里直接带回行数与状态，不需要等后台扫描周期，也不需要 SSH 免密。
 *
 * transport=scp 时保留旧行为（scp + ssh stat 校验字节数），用于灰度与回滚。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DEFAULT_SCP = 'C:\\Windows\\System32\\OpenSSH\\scp.exe';
const UPLOAD_PATH = '/api/ingest/upload';

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw new Error(`读取失败：${file}：${error.message}`);
  }
}

function resolvePath(value, base) {
  if (!value) return value;
  return path.isAbsolute(value) ? value : path.resolve(base || ROOT, value);
}

function settingsOf(config) {
  const raw = config.serverSync || {};
  const transport = String(raw.transport || 'http').trim().toLowerCase();
  const target = String(raw.target || '').trim();
  const remoteDir = String(raw.remoteDir || '').trim();
  const url = String(raw.url || '').trim();
  return {
    transport,
    url: url.replace(/\/+$/, ''),
    target,
    remoteDir: remoteDir.replace(/\\/g, '/').replace(/\/+$/, ''),
    scpPath: raw.scpPath || DEFAULT_SCP,
    sshPath: raw.sshPath || path.join(path.dirname(raw.scpPath || DEFAULT_SCP), 'ssh.exe'),
    timeoutMs: Number(raw.timeoutMs) || 120000,
    required: raw.required !== false,
    pattern: new RegExp(String(raw.namePattern || '出库流程节点时间跟踪'), 'i'),
    maxFiles: Number(raw.maxFiles) || 5,
  };
}

function configured(settings) {
  if (!settings) return false;
  if (settings.transport === 'scp') return Boolean(settings.target && settings.remoteDir);
  return Boolean(settings.url);
}

function describe(settings) {
  if (!settings) return '未配置';
  return settings.transport === 'scp'
    ? `${settings.target}:${settings.remoteDir}`
    : `${settings.url}${UPLOAD_PATH}`;
}

function readToken(config) {
  const secretsPath = resolvePath(config.secretsFile || 'secrets.local.json', ROOT);
  const secrets = loadJson(secretsPath, null);
  const token = secrets && String(secrets.dashboardToken || '').trim();
  if (!token) {
    throw new Error(`secrets.local.json 缺少 dashboardToken（${secretsPath}）：请在 WMS 面板生成上传令牌后填入`);
  }
  return token;
}

function uploadFile(localFile, config, settings, log) {
  return new Promise((resolve, reject) => {
    const name = path.basename(localFile);
    let token;
    try {
      token = readToken(config);
    } catch (error) {
      reject(error);
      return;
    }
    let stat;
    try {
      stat = fs.statSync(localFile);
    } catch (error) {
      reject(new Error(`读取本地文件失败：${localFile}：${error.message}`));
      return;
    }
    const base = new URL(settings.url);
    const isHttps = base.protocol === 'https:';
    const options = {
      protocol: base.protocol,
      hostname: base.hostname,
      port: base.port || (isHttps ? 443 : 80),
      method: 'POST',
      path: (base.pathname.replace(/\/+$/, '') || '') + UPLOAD_PATH,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': stat.size,
        'X-WMS-Token': token,
        'X-File-Name': encodeURIComponent(name),
      },
      timeout: settings.timeoutMs,
    };
    if (log) log(`上传 ${name}（${stat.size} 字节）→ ${settings.url}${UPLOAD_PATH}`);
    const req = (isHttps ? https : http).request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = JSON.parse(text); } catch (_) { /* 非 JSON 响应 */ }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const detail = (body && body.error) || text.trim().slice(0, 300) || `HTTP ${res.statusCode}`;
          reject(new Error(`上传失败（HTTP ${res.statusCode}）：${detail}`));
          return;
        }
        if (!body || !body.ok) {
          reject(new Error(`上传失败：响应不合法：${text.trim().slice(0, 300)}`));
          return;
        }
        resolve({
          synced: true,
          name: body.name || name,
          size: body.size || stat.size,
          queued: Boolean(body.queued),
          rows: (body.source_file && body.source_file.rows) || 0,
          status: (body.source_file && body.source_file.status) || '',
          body,
        });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`上传超时（${settings.timeoutMs}ms）`));
    });
    req.on('error', (error) => reject(new Error(`上传失败：${error.message}`)));
    const stream = fs.createReadStream(localFile);
    stream.on('error', (error) => req.destroy(new Error(`读取文件失败：${error.message}`)));
    stream.pipe(req);
  });
}

function pushViaScp(localFile, settings, log) {
  const name = path.basename(localFile);
  const remotePath = `${settings.remoteDir}/${name}`;
  const opts = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=20'];
  if (!fs.existsSync(settings.scpPath)) {
    throw new Error(`找不到 scp：${settings.scpPath}`);
  }
  if (log) log(`上传 ${name} → ${settings.target}:${remotePath}`);
  const put = spawnSync(settings.scpPath, [...opts, localFile, `${settings.target}:${remotePath}`],
    { encoding: 'utf8', windowsHide: true, timeout: settings.timeoutMs });
  if (put.status !== 0) {
    const detail = (put.stderr || put.stdout || (put.error && put.error.message) || '').trim();
    throw new Error(`上传失败：${detail || `scp 退出码 ${put.status}`}`);
  }
  const size = fs.statSync(localFile).size;
  const check = spawnSync(settings.sshPath,
    [...opts, settings.target, `stat -c %s -- ${JSON.stringify(remotePath)}`],
    { encoding: 'utf8', windowsHide: true, timeout: settings.timeoutMs });
  const remoteSize = Number(String(check.stdout || '').trim());
  if (check.status !== 0 || !Number.isFinite(remoteSize)) {
    const detail = (check.stderr || check.stdout || '').trim();
    throw new Error(`服务器校验失败：${detail || '无法读取远端文件大小'}`);
  }
  if (remoteSize !== size) {
    throw new Error(`大小不一致：本地 ${size}，远端 ${remoteSize}`);
  }
  if (log) log(`校验通过：远端 ${remoteSize} 字节`);
  return { synced: true, name, size, queued: false, rows: 0, status: '', body: null };
}

/**
 * 推送一个文件到服务器。
 * @returns {Promise<{synced:boolean, name:string, size:number, queued:boolean, rows:number, status:string}>}
 * @throws  Error（调用方按 settings.required 决定是否致命）
 */
async function pushFile(localFile, config, log) {
  const settings = settingsOf(config);
  if (!configured(settings)) {
    throw new Error('未配置 serverSync（url 或 target/remoteDir），跳过同步');
  }
  if (settings.transport === 'scp') {
    return pushViaScp(localFile, settings, log);
  }
  return uploadFile(localFile, config, settings, log);
}

module.exports = {
  ROOT,
  UPLOAD_PATH,
  loadJson,
  resolvePath,
  settingsOf,
  configured,
  describe,
  readToken,
  uploadFile,
  pushViaScp,
  pushFile,
};
