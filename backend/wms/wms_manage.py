# -*- coding: utf-8 -*-
"""WMS 自动下载：配置、定时任务、立即运行、状态与日志。"""
import json
import os
import re
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timedelta

from backend import paths

BASE_DIR = paths.BASE_DIR
AUTO_DIR = paths.WMS_TOOLS_DIR
CONFIG_PATH = os.path.join(AUTO_DIR, "wms.config.json")
BACKUP_PATH = CONFIG_PATH + ".bak"
LOG_DIR = os.path.join(AUTO_DIR, "logs")
RUN_LOG = os.path.join(LOG_DIR, "run.log")
TASK_LOG = os.path.join(LOG_DIR, "task.log")
STATUS_PATH = os.path.join(LOG_DIR, "ui-run-status.json")
LOCK_PATH = os.path.join(AUTO_DIR, ".wms_download.lock")
BAT_PATH = os.path.join(AUTO_DIR, "run_wms_download.bat")
VBS_PATH = os.path.join(AUTO_DIR, "run_wms_download.vbs")
TASK_NAME = "WMS-Daily-Download"
DEFAULT_NODE = r"C:\Users\Administrator\node-v22.23.2-win-x64\node.exe"
DEFAULT_CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PYTHON = sys.executable

_LOCK = threading.Lock()
_CURRENT = None
_PROCESS_FLAGS = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW


class WmsError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return default


def _write_json(path, data):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def load_config():
    config = _read_json(CONFIG_PATH)
    if not isinstance(config, dict):
        raise WmsError("WMS 配置文件不存在或不是合法 JSON：%s" % CONFIG_PATH, 500)
    return config


def _valid_time(value):
    return bool(re.match(r"^(?:[01]\d|2[0-3]):[0-5]\d$", str(value or "")))


def _minutes(value):
    h, m = str(value).split(":")
    return int(h) * 60 + int(m)


def _validate_schedule(schedule):
    if not isinstance(schedule, dict):
        raise WmsError("schedule 必须是对象")
    mode = schedule.get("mode") or "interval"
    if mode == "daily":
        times = schedule.get("times")
        if isinstance(times, str):
            times = [x.strip() for x in times.split(",") if x.strip()]
        if not isinstance(times, list) or not times or len(times) > 10:
            raise WmsError("每天执行时间需要 1–10 个 HH:MM")
        clean = []
        for item in times:
            item = str(item).strip()
            if not _valid_time(item):
                raise WmsError("时间格式不正确：%s（应为 HH:MM）" % item)
            if item not in clean:
                clean.append(item)
        clean.sort()
        schedule["mode"] = "daily"
        schedule["times"] = clean
        return schedule
    if mode != "interval":
        raise WmsError("schedule.mode 只能是 daily 或 interval")
    try:
        interval = int(schedule.get("intervalMinutes") or 0)
    except (TypeError, ValueError):
        interval = 0
    if interval < 1 or interval > 1440:
        raise WmsError("间隔分钟必须在 1–1440 之间")
    start = str(schedule.get("startTime") or "")
    end = str(schedule.get("endTime") or "")
    if not _valid_time(start) or not _valid_time(end):
        raise WmsError("开始/结束时间格式应为 HH:MM")
    if _minutes(end) <= _minutes(start):
        raise WmsError("结束时间必须晚于开始时间")
    schedule["mode"] = "interval"
    schedule["intervalMinutes"] = interval
    schedule["startTime"] = start
    schedule["endTime"] = end
    return schedule


def save_config(payload):
    """只更新 UI 白名单字段，保留选择器/登录/validation 等高级配置。"""
    if not isinstance(payload, dict):
        raise WmsError("配置格式不正确")
    config = load_config()
    url = str(payload.get("url") or config.get("url") or "").strip()
    if not re.match(r"^https?://", url, re.I):
        raise WmsError("WMS 地址必须以 http:// 或 https:// 开头")
    date_mode = str(payload.get("dateMode") or config.get("dateMode") or "today")
    if date_mode not in ("today", "yesterday", "fixed", "relative"):
        raise WmsError("查询日期方式不正确")
    fixed = str(payload.get("fixedDate") or config.get("fixedDate") or "").strip()
    relative_days = payload.get("relativeDays", config.get("relativeDays", 0))
    try:
        relative_days = int(relative_days)
    except (TypeError, ValueError):
        raise WmsError("relativeDays 必须是整数")
    if not -365 <= relative_days <= 365:
        raise WmsError("relativeDays 超出范围")
    if date_mode == "fixed" and not re.match(r"^\d{4}-\d{2}-\d{2}$", fixed):
        raise WmsError("固定日期格式应为 YYYY-MM-DD")
    deliver = str(payload.get("deliverDir") or config.get("deliverDir") or "").strip()
    if not deliver or "\x00" in deliver or not os.path.isabs(deliver):
        raise WmsError("下载目录必须是绝对路径（例如 Z:\\\\单据登记\\\\测试）")
    schedule = payload.get("schedule") if isinstance(payload.get("schedule"), dict) else config.get("schedule")
    schedule = _validate_schedule(schedule)

    config["url"] = url
    config["dateMode"] = date_mode
    config["fixedDate"] = fixed
    config["relativeDays"] = relative_days
    config["deliverDir"] = deliver
    config["schedule"] = schedule
    if "headless" in payload:
        config["headless"] = bool(payload["headless"])

    os.makedirs(AUTO_DIR, exist_ok=True)
    try:
        if os.path.isfile(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as src, open(BACKUP_PATH, "w", encoding="utf-8", newline="\n") as dst:
                dst.write(src.read())
    except OSError:
        pass
    _write_json(CONFIG_PATH, config)
    return config


def public_config(config):
    schedule = dict(config.get("schedule") or {})
    return {
        "url": config.get("url") or "",
        "dateMode": config.get("dateMode") or "today",
        "fixedDate": config.get("fixedDate") or "",
        "relativeDays": config.get("relativeDays") or 0,
        "deliverDir": config.get("deliverDir") or "",
        "headless": bool(config.get("headless", True)),
        "schedule": schedule,
        "loginMode": "aTrust SSO / 复用已登录会话" if (config.get("login") or {}).get("skip") else "账号密码",
    }


def _task_xml():
    try:
        result = subprocess.run(
            ["schtasks", "/Query", "/TN", TASK_NAME, "/XML"],
            capture_output=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if result.returncode != 0:
        return None
    raw = result.stdout
    for encoding in ("mbcs", "utf-8"):
        try:
            text = raw.decode(encoding)
            return text
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("mbcs", errors="ignore")


def _task_info():
    if os.name != "nt":
        return {}
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-ScheduledTaskInfo -TaskName '%s' | Select-Object LastRunTime,LastTaskResult,NextRunTime | ConvertTo-Json -Compress" % TASK_NAME],
            capture_output=True, text=True, timeout=15,
        )
        if proc.returncode != 0 or not proc.stdout.strip():
            return {}
        data = json.loads(proc.stdout.strip())
        return data if isinstance(data, dict) else {}
    except (OSError, subprocess.SubprocessError, ValueError):
        return {}


def _fmt_ps_date(value):
    value = str(value or "")
    match = re.match(r"^/Date\((\d+)\)/$", value)
    if match:
        try:
            return datetime.fromtimestamp(int(match.group(1)) / 1000.0).strftime("%Y-%m-%d %H:%M:%S")
        except (ValueError, OSError):
            return value
    return value


def task_status(config=None):
    config = config or load_config()
    xml = _task_xml()
    out = {"installed": bool(xml), "enabled": False, "nextRun": None,
           "launcher": os.path.isfile(VBS_PATH), "bat": os.path.isfile(BAT_PATH)}
    info = _task_info()
    if info:
        out["lastRun"] = _fmt_ps_date(info.get("LastRunTime"))
        out["lastResult"] = info.get("LastTaskResult")
    out["needs_reinstall"] = bool(out["installed"] and (not out["launcher"] or not out["bat"]))
    if not xml:
        out["needs_reinstall"] = False
        return out
    out["enabled"] = "<Enabled>false</Enabled>" not in xml
    start = re.search(r"<StartBoundary>([^<]+)</StartBoundary>", xml)
    if start:
        out["startBoundary"] = start.group(1)
    # 优先按任务计划 XML 计算下次运行，避免“改了配置但没应用任务”时状态不一致
    interval = re.search(r"<Interval>PT(\d+)M</Interval>", xml)
    duration = re.search(r"<Duration>(?:PT)?(\d+)H(?:([0-9]+)M)?</Duration>", xml)
    if start and interval:
        try:
            start_dt = datetime.strptime(start.group(1)[:16], "%Y-%m-%dT%H:%M")
            step = max(1, int(interval.group(1)))
            dur_min = int(duration.group(1)) * 60 + int(duration.group(2) or 0) if duration else 0
            now = datetime.now()
            start_time = start_dt.replace(year=now.year, month=now.month, day=now.day)
            end_time = start_time + timedelta(minutes=dur_min)
            if now < start_time:
                out["nextRun"] = start_time.strftime("%Y-%m-%d %H:%M")
                return out
            if now <= end_time:
                elapsed = int((now - start_time).total_seconds() // 60)
                nxt = start_time + timedelta(minutes=(elapsed // step + 1) * step)
                if nxt <= end_time:
                    out["nextRun"] = nxt.strftime("%Y-%m-%d %H:%M")
                    return out
            out["nextRun"] = (start_time + timedelta(days=1)).strftime("%Y-%m-%d %H:%M")
            return out
        except (ValueError, TypeError):
            pass
    out["nextRun"] = next_run(config)
    return out


def next_run(config):
    schedule = config.get("schedule") or {}
    now = datetime.now()
    if (schedule.get("mode") or "interval") == "daily":
        times = schedule.get("times") or []
        candidates = []
        for item in times:
            if not _valid_time(item):
                continue
            h, m = [int(x) for x in item.split(":")]
            candidate = now.replace(hour=h, minute=m, second=0, microsecond=0)
            if candidate <= now:
                candidate += timedelta(days=1)
            candidates.append(candidate)
        return min(candidates).strftime("%Y-%m-%d %H:%M") if candidates else None
    start = schedule.get("startTime") or "08:00"
    end = schedule.get("endTime") or "21:00"
    try:
        interval = max(1, int(schedule.get("intervalMinutes") or 10))
        sh, sm = [int(x) for x in start.split(":")]
        eh, em = [int(x) for x in end.split(":")]
    except (TypeError, ValueError):
        return None
    today_start = now.replace(hour=sh, minute=sm, second=0, microsecond=0)
    today_end = now.replace(hour=eh, minute=em, second=0, microsecond=0)
    if now < today_start:
        return today_start.strftime("%Y-%m-%d %H:%M")
    if now <= today_end:
        elapsed = int((now - today_start).total_seconds() // 60)
        nxt = today_start + timedelta(minutes=(elapsed // interval + 1) * interval)
        if nxt <= today_end:
            return nxt.strftime("%Y-%m-%d %H:%M")
    tomorrow = today_start + timedelta(days=1)
    return tomorrow.strftime("%Y-%m-%d %H:%M")


def _read_tail(path, lines):
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            data = fh.read().splitlines()
        return data[-max(1, int(lines)):]
    except OSError:
        return []


def last_log_summary():
    lines = _read_tail(RUN_LOG, 200)
    summary = None
    for line in reversed(lines):
        if "完成：" in line or "失败：" in line:
            summary = line
            break
    return summary, lines


def latest_delivery(conn):
    try:
        row = conn.execute(
            "SELECT name, rows, imported_at, status FROM source_files "
            "WHERE name LIKE '%出库流程节点时间跟踪%' ORDER BY imported_at DESC, id DESC LIMIT 1"
        ).fetchone()
        archive = conn.execute(
            "SELECT name, rows, archived_at AS updated_at FROM outbound_archive_snapshots "
            "ORDER BY biz_date DESC, archived_at DESC LIMIT 1"
        ).fetchone()
        return {
            "file": dict(row) if row else None,
            "archive": dict(archive) if archive else None,
        }
    except Exception:
        return {"file": None, "archive": None}


def _pid_alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def _write_status(data):
    os.makedirs(LOG_DIR, exist_ok=True)
    _write_json(STATUS_PATH, data)


def run_status():
    global _CURRENT
    with _LOCK:
        current = _CURRENT
    if current and current.get("proc") is not None:
        proc = current["proc"]
        code = proc.poll()
        if code is None:
            return {
                "running": True,
                "pid": proc.pid,
                "startedAt": current.get("startedAt"),
                "log": current.get("log"),
            }
        data = dict(current.get("status") or {})
        data.update({"running": False, "exitCode": code, "finishedAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S")})
        _write_status(data)
        with _LOCK:
            _CURRENT = None
        return data
    data = _read_json(STATUS_PATH, {}) or {}
    if data.get("running") and not _pid_alive(data.get("pid")):
        data["running"] = False
        data["stale"] = True
        _write_status(data)
    return data


def _node_path(config):
    path = config.get("nodePath") or DEFAULT_NODE
    if os.path.isfile(path):
        return path
    return "node"


def start_run(date=None):
    global _CURRENT
    with _LOCK:
        if _CURRENT and _CURRENT.get("proc") is not None and _CURRENT["proc"].poll() is None:
            raise WmsError("已有 WMS 下载正在运行，请稍后再试", 409)
        if os.path.isfile(LOCK_PATH):
            try:
                with open(LOCK_PATH, "r", encoding="utf-8") as fh:
                    pid = int(fh.read().strip() or 0)
            except (OSError, ValueError):
                pid = 0
            if pid and _pid_alive(pid):
                raise WmsError("已有 WMS 下载进程在运行，请稍后再试", 409)
            try:
                os.remove(LOCK_PATH)
            except OSError:
                pass
        config = load_config()
        node = _node_path(config)
        script = os.path.join(AUTO_DIR, "download_wms.js")
        if not os.path.isfile(script):
            raise WmsError("找不到下载脚本：%s" % script, 500)
        if not config.get("chromePath") and not os.path.isfile(DEFAULT_CHROME):
            raise WmsError("找不到 Chrome：%s" % DEFAULT_CHROME, 500)
        os.makedirs(LOG_DIR, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        log_path = os.path.join(LOG_DIR, "ui-run-%s.log" % stamp)
        cmd = [node, script, "--config", CONFIG_PATH]
        if date:
            cmd.extend(["--date", date])
        with open(log_path, "w", encoding="utf-8", buffering=1) as fh:
            proc = subprocess.Popen(
                cmd, cwd=AUTO_DIR, stdout=fh, stderr=subprocess.STDOUT,
                creationflags=_PROCESS_FLAGS,
            )
        started = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        status = {"running": True, "pid": proc.pid, "startedAt": started, "log": log_path, "date": date or ""}
        _CURRENT = {"proc": proc, "startedAt": started, "log": log_path, "status": status}
        _write_status(status)

        def wait_proc():
            global _CURRENT
            code = proc.wait()
            finished = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            with _LOCK:
                data = dict(status)
                data.update({"running": False, "exitCode": code, "finishedAt": finished})
                _CURRENT = None
            _write_status(data)

        threading.Thread(target=wait_proc, name="wms-run-wait", daemon=True).start()
        return {"started": True, "pid": proc.pid, "startedAt": started, "log": log_path}


def stop_run():
    global _CURRENT
    with _LOCK:
        current = _CURRENT
    if not current or not current.get("proc"):
        raise WmsError("当前没有运行中的 WMS 下载", 409)
    proc = current["proc"]
    if proc.poll() is not None:
        return run_status()
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True)
    else:
        proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    return run_status()


def logs(tail=200):
    tail = max(1, min(1000, int(tail or 200)))
    summary, run_lines = last_log_summary()
    return {
        "run": "\n".join(run_lines[-tail:]),
        "task": "\n".join(_read_tail(TASK_LOG, tail)),
        "summary": summary,
    }


def state(conn, tail=200):
    config = load_config()
    status = run_status()
    summary, _ = last_log_summary()
    task = task_status(config)
    if not task.get("enabled"):
        task["nextRun"] = None
    return {
        "config": public_config(config),
        "task": task,
        "lastRun": status,
        "lastSummary": summary,
        "latest": latest_delivery(conn),
        "logs": logs(tail),
    }


def apply_schedule(action):
    if action == "install":
        if not os.path.isfile(os.path.join(AUTO_DIR, "install_task.py")):
            raise WmsError("找不到定时任务安装器", 500)
        proc = subprocess.run(
            [PYTHON, os.path.join(AUTO_DIR, "install_task.py")],
            cwd=AUTO_DIR, capture_output=True, text=True, timeout=60,
        )
        if proc.returncode != 0:
            raise WmsError("定时任务安装失败：%s" % ((proc.stderr or proc.stdout or "").strip()[:500]), 500)
        return task_status(load_config())
    if action == "enable":
        proc = subprocess.run(["schtasks", "/Change", "/TN", TASK_NAME, "/ENABLE"], capture_output=True, text=True)
    elif action == "disable":
        proc = subprocess.run(["schtasks", "/Change", "/TN", TASK_NAME, "/DISABLE"], capture_output=True, text=True)
    elif action == "remove":
        proc = subprocess.run(["schtasks", "/Delete", "/TN", TASK_NAME, "/F"], capture_output=True, text=True)
    else:
        raise WmsError("未知定时任务操作")
    if proc.returncode != 0:
        raise WmsError("定时任务操作失败：%s" % ((proc.stderr or proc.stdout or "").strip()[:500]), 500)
    return task_status(load_config())
