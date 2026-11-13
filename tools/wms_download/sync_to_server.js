#!/usr/bin/env node
/* 把交付目录里的最新 WMS 文件同步到看板服务器数据源目录。
 *
 * 只做文件搬运，不启动浏览器：即使下载动作发生在别的电脑（或本机浏览器
 * 会话失效），只要文件落到了交付目录，这个脚本就能保证服务器目录里也有。
 *
 * 用法：
 *   node sync_to_server.js --config wms.config.json
 *   node sync_to_server.js --config wms.config.json --dry-run
 *   node sync_to_server.js --config wms.config.json --all      # 忽略状态，全部重传
 *
 * 状态文件 logs/sync-state.json 记录已同步的 名称+大小+修改时间，避免重复上传。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = __dirname;
const DEFAULT_SCP = 'C:\\Windows\\System32\\OpenSSH\\scp.exe';

function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

let logDir = null;

function log(message) {
  const line = `[${nowText()}] ${message}`;
  console.log(line);
  if (!logDir) return;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'sync.log'), line + '\n', 'utf8');
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
    else if (item === '--dry-run') args.dryRun = true;
    else if (item === '--all') args.all = true;
    else if (item === '--help' || item === '-h') args.help = true;
    else fail(`未知参数：${item}`);
  }
  return args;
}

function settingsOf(config) {
  const raw = config.serverSync || {};
  const target = String(raw.target || '').trim();
  const remoteDir = String(raw.remoteDir || '').trim();
  if (!target || !remoteDir) {
    log('未配置 serverSync.target / remoteDir，跳过同步');
    return null;
  }
  const scpPath = raw.scpPath || DEFAULT_SCP;
  const sshPath = raw.sshPath || path.join(path.dirname(scpPath), 'ssh.exe');
  if (!fs.existsSync(scpPath)) fail(`找不到 scp：${scpPath}`);
  return {
    target,
    remoteDir: remoteDir.replace(/\\/g, '/').replace(/\/+$/, ''),
    scpPath,
    sshPath,
    timeoutMs: Number(raw.timeoutMs) || 120000,
    pattern: new RegExp(String(raw.namePattern || '出库流程节点时间跟踪'), 'i'),
    maxFiles: Number(raw.maxFiles) || 5,
  };
}

function listCandidates(deliverDir, settings) {
  let names;
  try {
    names = fs.readdirSync(deliverDir);
  } catch (error) {
    fail(`读取交付目录失败：${deliverDir}：${error.message}`);
  }
  const files = [];
  for (const name of names) {
    if (name.startsWith('~$') || name.startsWith('.')) continue;
    if (!/\.(xlsx|xls|csv)$/i.test(name)) continue;
    if (!settings.pattern.test(name)) continue;
    const full = path.join(deliverDir, name);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { continue; }
    if (!stat.isFile()) continue;
    files.push({ name, full, size: stat.size, mtime: Math.round(stat.mtimeMs) });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, settings.maxFiles);
}

function stateKey(file) {
  return `${file.name}|${file.size}|${file.mtime}`;
}

function pushFile(file, settings, dryRun) {
  const remotePath = `${settings.remoteDir}/${file.name}`;
  const opts = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=20'];
  if (dryRun) {
    log(`[dry-run] 将上传 ${file.name}（${file.size} 字节）→ ${settings.target}:${remotePath}`);
    return true;
  }
  log(`上传 ${file.name}（${file.size} 字节）→ ${settings.target}:${remotePath}`);
  const put = spawnSync(settings.scpPath, [...opts, file.full, `${settings.target}:${remotePath}`],
    { encoding: 'utf8', windowsHide: true, timeout: settings.timeoutMs });
  if (put.status !== 0) {
    const detail = (put.stderr || put.stdout || put.error?.message || '').trim();
    fail(`上传失败：${detail || `scp 退出码 ${put.status}`}`);
  }
  const check = spawnSync(settings.sshPath, [...opts, settings.target, `stat -c %s -- ${JSON.stringify(remotePath)}`],
    { encoding: 'utf8', windowsHide: true, timeout: settings.timeoutMs });
  const remoteSize = Number(String(check.stdout || '').trim());
  if (check.status !== 0 || !Number.isFinite(remoteSize)) {
    const detail = (check.stderr || check.stdout || '').trim();
    fail(`服务器校验失败：${detail || '无法读取远端文件大小'}`);
  }
  if (remoteSize !== file.size) {
    fail(`大小不一致：本地 ${file.size}，远端 ${remoteSize}`);
  }
  log(`校验通过：远端 ${remoteSize} 字节`);
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node sync_to_server.js --config wms.config.json [--dry-run] [--all]');
    return 0;
  }
  const configPath = resolvePath(args.config, ROOT);
  const config = loadJson(configPath);
  logDir = resolvePath(config.logDir || 'logs', ROOT);
  const settings = settingsOf(config);
  if (!settings) return 0;

  const deliverDir = resolvePath(config.deliverDir || '', ROOT);
  if (!deliverDir || !fs.existsSync(deliverDir)) {
    fail(`交付目录不可用：${deliverDir || '(未配置)'}`);
  }
  const statePath = path.join(logDir, 'sync-state.json');
  const state = args.all ? {} : (loadJson(statePath, {}) || {});
  const candidates = listCandidates(deliverDir, settings);
  if (!candidates.length) {
    log(`交付目录没有匹配的文件：${deliverDir}`);
    return 0;
  }
  log(`交付目录：${deliverDir}，候选 ${candidates.length} 个`);

  let pushed = 0;
  let skipped = 0;
  const errors = [];
  for (const file of candidates) {
    const key = stateKey(file);
    if (state[key] === 'ok') {
      skipped += 1;
      continue;
    }
    try {
      pushFile(file, settings, args.dryRun);
      if (!args.dryRun) {
        state[key] = 'ok';
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
      }
      pushed += 1;
    } catch (error) {
      errors.push(`${file.name}：${error.message}`);
      log(`失败：${file.name}：${error.message}`);
    }
  }
  log(`同步结束：上传 ${pushed} 个，跳过 ${skipped} 个，失败 ${errors.length} 个`);
  if (errors.length) {
    log(`失败明细：${errors.join('；')}`);
    return 1;
  }
  return 0;
}

try {
  process.exit(main());
} catch (error) {
  console.error(`[${nowText()}] 失败：${error && error.message ? error.message : error}`);
  process.exit(error.exitCode || 1);
}
