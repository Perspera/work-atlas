#!/usr/bin/env node
/* 把交付目录里的最新 WMS 文件推送到看板服务器。
 *
 * 默认走 HTTP 上传即入库（server_push.js）：服务器落盘到数据源目录后立刻扫描，
 * 响应里带回行数与状态；也支持 transport=scp 回退到旧的 scp 拷贝方式。
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
const serverPush = require('./server_push');

const ROOT = __dirname;

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

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('用法：node sync_to_server.js --config wms.config.json [--dry-run] [--all]');
    return 0;
  }
  const configPath = resolvePath(args.config, ROOT);
  const config = loadJson(configPath);
  logDir = resolvePath(config.logDir || 'logs', ROOT);
  const settings = serverPush.settingsOf(config);
  if (!serverPush.configured(settings)) {
    log('未配置 serverSync.url（或 target/remoteDir），跳过同步');
    return 0;
  }
  log(`目标：${serverPush.describe(settings)}`);

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
    if (args.dryRun) {
      log(`[dry-run] 将上传 ${file.name}（${file.size} 字节）→ ${serverPush.describe(settings)}`);
      pushed += 1;
      continue;
    }
    try {
      const result = await serverPush.pushFile(file.full, config, log);
      const extra = result.queued
        ? '（已接收，等待后台扫描）'
        : `，入库 ${result.rows} 行，状态 ${result.status || '未知'}`;
      log(`完成：${result.name}（${result.size} 字节）${extra}`);
      state[key] = 'ok';
      saveState(statePath, state);
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

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[${nowText()}] 失败：${error && error.message ? error.message : error}`);
    process.exit(error.exitCode || 1);
  });
