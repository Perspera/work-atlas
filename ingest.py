# -*- coding: utf-8 -*-
"""数据接入：扫描导出目录 → 解析 xlsx/xlsm/csv → 归一并写入 SQLite。

目录契约
    任意文件名.xlsx / .xlsm / .csv
    靠表头识别类型，不依赖文件名：
      发运表：含 订单日期、波次号、订单组号、备件编码、出库时间
      运输单：含 外部单号（波次号）、状态、承运商、订单组号

命令行
    python ingest.py --scan                  # 扫描一次
    python ingest.py --check                 # 打印最近业务日的复算结果（回归用）
    python ingest.py --import-dealers F.csv  # 导入经销商映射
    python ingest.py --register-waves F.txt --date 2026-09-05   # 批量登记波次
"""
import csv
import io
import json
import os
import re
import sys
import threading
from datetime import date, datetime, time, timedelta

import db
import outbound_archive

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
EXCEL_EPOCH = datetime(1899, 12, 30)

# 后台扫描线程与「立即扫描」可能同时触发；用模块级锁串行化，避免同一文件
# 被两个线程同时"先查后插"而撞 UNIQUE 约束（线上真实报错）。
_SCAN_LOCK = threading.Lock()

# ---------------------------------------------------------------- 表头字典
SHIP_HEADERS = {
    "order_date": ["订单日期"],
    "wave_no": ["波次号"],
    "wms_no": ["wms单号"],
    "line_no": ["wms单行号"],
    "group_no": ["订单组号"],
    "dealer_full": ["交货地"],
    "zone": ["区"],
    "doc_type": ["订单类型"],
    "freight_free": ["是否免运费"],
    "part_code": ["备件编码"],
    "part_name": ["备件名称"],
    "qty": ["订单数量"],
    "amount": ["金额"],
    "status": ["状态"],
    "wave_time": ["波次号生成时间"],
    "pick_time": ["拣货时间"],
    "check_time": ["复核时间"],
    "out_time": ["出库时间"],
    "pick_qty": ["拣货数量"],
    "out_qty": ["出库数量"],
    "mode": ["发运方式"],
    "warehouse": ["出库仓库名称"],
    "pick_person": ["拣货人"],
    "check_person": ["复核人"],
    "wave_person": ["组波人"],
    "erp_required": ["是否需要回传erp", "是否需要回传ERP"],
    "erp_status": ["回传erp状态", "回传ERP状态"],
    "erp_message": ["回传erp信息", "回传ERP信息"],
    "erp_time": ["回传erp时间", "回传ERP时间"],
}

TMS_HEADERS = {
    "wave_no": ["外部单号（波次号）", "外部单号(波次号)", "外部单号"],
    "status": ["状态"],
    "carrier": ["承运商"],
    "group_no": ["订单组号"],
}

DEALER_HEADERS = {
    "full_name": ["全称", "经销商全称"],
    "short_name": ["简称", "经销商简称"],
    "region": ["区域"],
    "route": ["承运商", "线路", "承运商/线路"],
}

BATTERY_DEALER_HEADERS = {
    "dealer": ["经销商", "经销商全称"],
    "dealer_short": ["简称", "经销商简称"],
    "doc_type": ["单据类型"],
    "freight_free": ["是否免运费"],
    "region": ["区域"],
    "carrier": ["承运商", "线路"],
    "dest_city": ["送达城市"],
    "address": ["地址"],
}


def norm_header(value):
    if value is None:
        return ""
    s = str(value).strip().replace("\u3000", " ")
    s = s.replace("（", "(").replace("）", ")")
    s = re.sub(r"\s+", "", s)
    return s.lower()


def num(value, default=0.0):
    if value is None or value == "":
        return default
    if isinstance(value, (int, float)):
        return float(value)
    s = str(value).strip().replace(",", "").replace("，", "")
    s = s.replace("¥", "").replace("￥", "").replace("元", "").replace(" ", "")
    if s.endswith("%"):
        try:
            return float(s[:-1]) / 100.0
        except ValueError:
            return default
    try:
        return float(s)
    except ValueError:
        return default


def norm_date(value):
    """归一为 'YYYY-MM-DD'；无法识别返回 None。"""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, (int, float)):
        try:
            return (EXCEL_EPOCH + timedelta(days=float(value))).strftime("%Y-%m-%d")
        except Exception:
            return None
    s = str(value).strip()
    if not s:
        return None
    s = s.replace("/", "-").replace("年", "-").replace("月", "-").replace("日", "")
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        return "%04d-%02d-%02d" % (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.match(r"^(\d{4})(\d{2})(\d{2})$", s)
    if m:
        return "%s-%s-%s" % (m.group(1), m.group(2), m.group(3))
    return None


def norm_dt(value):
    """归一为 'YYYY-MM-DD HH:MM:SS'；无法识别返回 None。"""
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d 00:00:00")
    if isinstance(value, time):
        return value.strftime("1970-01-01 %H:%M:%S")
    if isinstance(value, (int, float)):
        try:
            return (EXCEL_EPOCH + timedelta(days=float(value))).strftime("%Y-%m-%d %H:%M:%S")
        except Exception:
            return None
    s = str(value).strip()
    if not s:
        return None
    s = s.replace("/", "-").replace("年", "-").replace("月", "-").replace("日", "")
    m = re.match(
        r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?", s
    )
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
        hh = int(m.group(4) or 0)
        mm = int(m.group(5) or 0)
        ss = int(m.group(6) or 0)
        return "%04d-%02d-%02d %02d:%02d:%02d" % (y, mo, d, hh, mm, ss)
    # 纯时间 10:24:52 -> 无日期，忽略
    return None


def text(value):
    if value is None:
        return None
    s = str(value).strip()
    return s if s else None


# ---------------------------------------------------------------- 文件读取
def _read_xlsx(path):
    """返回 [(sheetname, rows)]，rows 为二维列表。"""
    from openpyxl import load_workbook

    wb = load_workbook(path, read_only=True, data_only=True)
    try:
        out = []
        for ws in wb.worksheets:
            rows = []
            for row in ws.iter_rows(values_only=True):
                rows.append(list(row))
                if len(rows) > 200000:
                    break
            out.append((ws.title, rows))
        return out
    finally:
        try:
            wb.close()
        except Exception:
            pass


def _read_csv(path):
    raw = None
    for enc in ("utf-8-sig", "gbk", "utf-8", "latin-1"):
        try:
            with open(path, "r", encoding=enc, newline="") as fh:
                raw = fh.read()
            break
        except UnicodeDecodeError:
            continue
    if raw is None:
        raise ValueError("无法识别文件编码")
    delimiter = ","
    sample = raw[:4096]
    for candidate in (",", "\t", ";", "|"):
        if sample.count(candidate) > sample.count(delimiter):
            delimiter = candidate
    reader = csv.reader(io.StringIO(raw), delimiter=delimiter)
    return [("csv", [row for row in reader])]


def read_any(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm"):
        return _read_xlsx(path)
    if ext == ".csv":
        return _read_csv(path)
    raise ValueError("不支持的文件类型：%s" % ext)


def find_header(rows, wanted_groups):
    """在前 15 行里找表头行，返回 (行号, {字段: 列号}, 命中数)。"""
    best = (None, {}, 0)
    for r_idx, row in enumerate(rows[:15]):
        mapping = {}
        for field, aliases in wanted_groups.items():
            alias_norm = {norm_header(a) for a in aliases}
            for c_idx, cell in enumerate(row):
                if norm_header(cell) in alias_norm:
                    mapping[field] = c_idx
                    break
        if len(mapping) > best[2]:
            best = (r_idx, mapping, len(mapping))
    return best


def detect_kind(rows):
    """返回 ('ship'|'tms'|'dealer'|None, header_row, mapping, hits)。"""
    candidates = []
    for kind, spec, must in (
        ("ship", SHIP_HEADERS, ("order_date", "wave_no", "group_no")),
        ("tms", TMS_HEADERS, ("wave_no", "status")),
        ("dealer", DEALER_HEADERS, ("full_name",)),
        ("battery_dealer", BATTERY_DEALER_HEADERS, ("dealer",)),
    ):
        hdr, mapping, hits = find_header(rows, spec)
        if kind == "battery_dealer" and hdr is not None and "dealer" in mapping and "zone" not in mapping:
            # 「动力电池」sheet 第二列没有表头，固定为库区
            mapping["zone"] = 1
        wanted = sum(1 for f in must if f in mapping)
        candidates.append((wanted, hits, kind, hdr, mapping))
    candidates.sort(key=lambda item: (item[0], item[1]), reverse=True)
    wanted, hits, kind, hdr, mapping = candidates[0]
    if wanted >= 1 and hits >= 2:
        return kind, hdr, mapping, hits
    return None, None, {}, 0


# ---------------------------------------------------------------- 解析
def row_get(row, mapping, field):
    idx = mapping.get(field)
    if idx is None or idx >= len(row):
        return None
    return row[idx]


def is_repeated_header(row, header_row, mapping, need=3):
    """导出文件中间可能夹着重复的表头行（分页/分表），不能当成数据。"""
    hits = 0
    for idx in mapping.values():
        if idx is None or idx >= len(row) or idx >= len(header_row):
            continue
        left = norm_header(row[idx])
        if left and left == norm_header(header_row[idx]):
            hits += 1
            if hits >= need:
                return True
    return False


def parse_ship(rows, header_idx, mapping):
    parsed = []
    header_row = rows[header_idx] if 0 <= header_idx < len(rows) else []
    for offset, row in enumerate(rows[header_idx + 1 :]):
        if is_repeated_header(row, header_row, mapping):
            continue
        wave_no = text(row_get(row, mapping, "wave_no"))
        group_no = text(row_get(row, mapping, "group_no")) or ""
        if not wave_no and not group_no:
            # 待组波行（波次号为空）也必须入库；只跳过完全空行
            probes = [
                text(row_get(row, mapping, "wms_no")),
                text(row_get(row, mapping, "part_code")),
                text(row_get(row, mapping, "order_date")),
                text(row_get(row, mapping, "amount")),
            ]
            if not any(probes):
                continue
        wms_no = text(row_get(row, mapping, "wms_no"))
        line_no = text(row_get(row, mapping, "line_no"))
        if not wms_no:
            wms_no = "AUTO-%s-%s-%s-%s" % (
                wave_no or "",
                group_no or "",
                text(row_get(row, mapping, "part_code")) or "",
                line_no or offset,
            )
        parsed.append(
            {
                "order_date": norm_date(row_get(row, mapping, "order_date")),
                "wave_no": wave_no,
                "wms_no": wms_no,
                "line_no": line_no or "",
                "group_no": group_no,
                "dealer_full": text(row_get(row, mapping, "dealer_full")),
                "zone": text(row_get(row, mapping, "zone")),
                "doc_type": text(row_get(row, mapping, "doc_type")),
                "freight_free": text(row_get(row, mapping, "freight_free")),
                "part_code": text(row_get(row, mapping, "part_code")),
                "part_name": text(row_get(row, mapping, "part_name")),
                "qty": num(row_get(row, mapping, "qty")),
                "amount": num(row_get(row, mapping, "amount")),
                "status": text(row_get(row, mapping, "status")),
                "wave_time": norm_dt(row_get(row, mapping, "wave_time")),
                "pick_time": norm_dt(row_get(row, mapping, "pick_time")),
                "check_time": norm_dt(row_get(row, mapping, "check_time")),
                "out_time": norm_dt(row_get(row, mapping, "out_time")),
                "pick_qty": num(row_get(row, mapping, "pick_qty")),
                "out_qty": num(row_get(row, mapping, "out_qty")),
                "mode": text(row_get(row, mapping, "mode")),
                "warehouse": text(row_get(row, mapping, "warehouse")),
                "pick_person": text(row_get(row, mapping, "pick_person")),
                "check_person": text(row_get(row, mapping, "check_person")),
                "wave_person": text(row_get(row, mapping, "wave_person")),
                "erp_required": text(row_get(row, mapping, "erp_required")),
                "erp_status": text(row_get(row, mapping, "erp_status")),
                "erp_message": text(row_get(row, mapping, "erp_message")),
                "erp_time": norm_dt(row_get(row, mapping, "erp_time")),
            }
        )
    return parsed


def parse_tms(rows, header_idx, mapping):
    parsed = []
    header_row = rows[header_idx] if 0 <= header_idx < len(rows) else []
    for row in rows[header_idx + 1 :]:
        if is_repeated_header(row, header_row, mapping, need=2):
            continue
        wave_no = text(row_get(row, mapping, "wave_no"))
        if not wave_no:
            continue
        parsed.append(
            {
                "wave_no": wave_no,
                "status": text(row_get(row, mapping, "status")),
                "carrier": text(row_get(row, mapping, "carrier")),
                "group_no": text(row_get(row, mapping, "group_no")) or "",
            }
        )
    return parsed


# ---------------------------------------------------------------- 写入
SHIP_UPSERT = """
INSERT INTO ship_lines(
  order_date, wave_no, wms_no, line_no, group_no, dealer_full, zone, doc_type,
  freight_free, part_code, part_name, qty, amount, status,
  wave_time, pick_time, check_time, out_time, pick_qty, out_qty, mode, warehouse,
  pick_person, check_person, wave_person,
  erp_required, erp_status, erp_message, erp_time,
  src_file_id, updated_at)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(wms_no, line_no) DO UPDATE SET
  order_date=excluded.order_date, wave_no=excluded.wave_no, group_no=excluded.group_no,
  dealer_full=excluded.dealer_full, zone=excluded.zone, doc_type=excluded.doc_type,
  freight_free=excluded.freight_free, part_code=excluded.part_code, part_name=excluded.part_name,
  qty=excluded.qty, amount=excluded.amount, status=excluded.status,
  wave_time=excluded.wave_time, pick_time=excluded.pick_time, check_time=excluded.check_time,
  out_time=excluded.out_time, pick_qty=excluded.pick_qty, out_qty=excluded.out_qty,
  mode=excluded.mode, warehouse=excluded.warehouse,
  pick_person=excluded.pick_person, check_person=excluded.check_person,
  wave_person=excluded.wave_person,
  erp_required=excluded.erp_required, erp_status=excluded.erp_status,
  erp_message=excluded.erp_message, erp_time=excluded.erp_time,
  src_file_id=excluded.src_file_id, updated_at=excluded.updated_at
"""

TMS_UPSERT = """
INSERT INTO tms_status(wave_no, status, carrier, group_no, src_file_id, imported_at)
VALUES(?,?,?,?,?,?)
ON CONFLICT(wave_no, group_no) DO UPDATE SET
  status=excluded.status, carrier=excluded.carrier,
  src_file_id=excluded.src_file_id, imported_at=excluded.imported_at
"""


# 变更检测：只关心会影响台账/进度/人效/ERP 的字段
SHIP_FP_FIELDS = (
    "order_date", "wave_no", "group_no", "dealer_full", "zone", "doc_type", "freight_free",
    "qty", "amount", "status", "wave_time", "pick_time", "check_time", "out_time",
    "pick_person", "check_person", "wave_person",
    "erp_required", "erp_status", "erp_message", "erp_time", "mode", "warehouse",
)


def _fp(values):
    out = []
    for value in values:
        if isinstance(value, float):
            out.append(round(value, 4))
        elif value is None:
            out.append("")
        else:
            out.append(str(value))
    return tuple(out)


def _row_key(row):
    # 发运行身份：WMS 单号 + 行号。订单组号是这一行的属性，不是身份的一部分；
    # 重导后组号变化时覆盖原行，避免“空组 + 正式组”重复。
    return (
        str(row["wms_no"] or ""),
        str(row["line_no"] or ""),
    )


def _date_part(value):
    text = str(value or "")
    return text[:10] if len(text) >= 10 and text[4:5] == "-" else None


def _existing_ship_map(conn, rows):
    wms_nos = sorted({r["wms_no"] for r in rows if r["wms_no"]})
    existing = {}
    columns = ", ".join(SHIP_FP_FIELDS)
    for start in range(0, len(wms_nos), 400):
        part = wms_nos[start : start + 400]
        marks = ",".join("?" * len(part))
        for row in conn.execute(
            "SELECT wms_no, line_no, group_no, %s FROM ship_lines WHERE wms_no IN (%s)"
            % (columns, marks),
            part,
        ):
            existing[_row_key(row)] = _fp([row[c] for c in SHIP_FP_FIELDS])
    return existing


def _upsert_ship(conn, rows, file_id):
    now = db.now_str()
    existing = _existing_ship_map(conn, rows)
    changes = {"added": 0, "changed": 0, "waves": set(), "pick_dates": set(), "check_dates": set()}
    payload = []
    for r in rows:
        key = _row_key(r)
        fingerprint = _fp([r[c] for c in SHIP_FP_FIELDS])
        previous = existing.get(key)
        is_new = previous is None
        is_changed = previous is not None and previous != fingerprint
        if is_new or is_changed:
            changes["added" if is_new else "changed"] += 1
            if r["wave_no"]:
                changes["waves"].add(r["wave_no"])
            for field, bucket in (("pick_time", "pick_dates"), ("check_time", "check_dates")):
                day = _date_part(r[field])
                if day:
                    changes[bucket].add(day)
        payload.append(
            (
                r["order_date"], r["wave_no"], r["wms_no"], r["line_no"], r["group_no"],
                r["dealer_full"], r["zone"], r["doc_type"], r["freight_free"],
                r["part_code"], r["part_name"], r["qty"], r["amount"], r["status"],
                r["wave_time"], r["pick_time"], r["check_time"], r["out_time"],
                r["pick_qty"], r["out_qty"], r["mode"], r["warehouse"],
                r["pick_person"], r["check_person"], r["wave_person"],
                r["erp_required"], r["erp_status"], r["erp_message"], r["erp_time"],
                file_id, now,
            )
        )
    conn.executemany(SHIP_UPSERT, payload)
    return changes


def _upsert_tms(conn, rows, file_id):
    now = db.now_str()
    existing = {}
    waves = sorted({r["wave_no"] for r in rows if r["wave_no"]})
    for start in range(0, len(waves), 400):
        part = waves[start : start + 400]
        marks = ",".join("?" * len(part))
        for row in conn.execute(
            "SELECT wave_no, group_no, status, carrier FROM tms_status WHERE wave_no IN (%s)" % marks,
            part,
        ):
            existing[(str(row["wave_no"] or ""), str(row["group_no"] or ""))] = _fp(
                [row["status"], row["carrier"]]
            )
    changes = {"added": 0, "changed": 0, "waves": set(), "pick_dates": set(), "check_dates": set()}
    payload = []
    for r in rows:
        key = (str(r["wave_no"] or ""), str(r["group_no"] or ""))
        fingerprint = _fp([r["status"], r["carrier"]])
        previous = existing.get(key)
        if previous is None:
            changes["added"] += 1
        elif previous != fingerprint:
            changes["changed"] += 1
        else:
            payload.append((r["wave_no"], r["status"], r["carrier"], r["group_no"], file_id, now))
            continue
        changes["waves"].add(r["wave_no"])
        payload.append((r["wave_no"], r["status"], r["carrier"], r["group_no"], file_id, now))
    conn.executemany(TMS_UPSERT, payload)
    return changes


# ---------------------------------------------------------------- 扫描
def resolve_dirs(config):
    dirs = []
    base = BASE_DIR

    def add(p):
        if not p:
            return
        full = p if os.path.isabs(p) else os.path.join(base, p)
        if os.path.isdir(full) and full not in dirs:
            dirs.append(full)

    for p in config.get("source_dirs", []):
        add(p)
    # 主目录不可达时用 UNC 回退
    if not any(os.path.isdir(p) for p in config.get("source_dirs", []) or []):
        for p in config.get("source_dir_fallbacks", []) or []:
            add(p)
    for p in config.get("sample_dirs", []) or []:
        add(p)
    return dirs


def iter_files(dirs):
    files = []
    for root in dirs:
        try:
            for name in sorted(os.listdir(root)):
                if name.startswith("~$") or name.startswith("."):
                    continue
                path = os.path.join(root, name)
                if os.path.isfile(path) and os.path.splitext(name)[1].lower() in (
                    ".xlsx",
                    ".xlsm",
                    ".csv",
                ):
                    files.append(path)
        except OSError:
            continue
    return files


def scan(conn, config, force=False, verbose=True, wait=True):
    """扫描入口：串行化，避免后台线程与手动刷新同时导入。

    wait=False 时拿不到锁直接返回 {"busy": True}（后台线程用）；
    wait=True 时最多等 120 秒（手动「立即扫描」用）。
    """
    acquired = _SCAN_LOCK.acquire(blocking=wait, timeout=120 if wait else -1)
    if not acquired:
        return {
            "busy": True,
            "dirs": resolve_dirs(config),
            "scanned": 0,
            "imported": 0,
            "updated": 0,
            "skipped": 0,
            "errors": [],
            "kinds": {},
        }
    try:
        return _scan_locked(conn, config, force=force, verbose=verbose)
    finally:
        _SCAN_LOCK.release()


def _scan_locked(conn, config, force=False, verbose=True):
    dirs = resolve_dirs(config)
    report = {
        "dirs": dirs,
        "reachable": [d for d in dirs if os.path.isdir(d)],
        "scanned": 0,
        "imported": 0,
        "updated": 0,
        "skipped": 0,
        "errors": [],
        "kinds": {},
        "added_rows": 0,
        "changed_rows": 0,
        "affected_waves": [],
        "affected_pick_dates": [],
        "affected_check_dates": [],
        "archived_files": [],
        "archive_errors": [],
        "removed_stale_rows": 0,
        "files": [],
    }
    change_acc = {"added": 0, "changed": 0, "waves": set(), "pick_dates": set(), "check_dates": set()}
    archive_dates, archive_waves = set(), set()
    # 每个业务日期保留最新完整文件中的行；旧版本中已不存在的行在扫描末尾清理
    ship_snapshots = {}
    if not dirs:
        report["errors"].append("没有可用的数据源目录")
        return report

    entries = []
    seen = set()
    for path in iter_files(dirs):
        try:
            stat = os.stat(path)
        except OSError:
            continue
        # 同一份文件被拷到多个目录时只导入一次（按 名称+大小+修改时间 去重）
        key = (os.path.basename(path), stat.st_size, round(stat.st_mtime, 3))
        if key in seen:
            continue
        seen.add(key)
        entries.append((path, stat.st_size, stat.st_mtime))
    entries.sort(key=lambda item: item[2])  # 旧文件先写，新文件后写覆盖

    for path, size, mtime in entries:
        report["scanned"] += 1
        row = conn.execute("SELECT * FROM source_files WHERE path=?", (path,)).fetchone()
        unchanged = (
            row is not None
            and row["size"] == size
            and abs((row["mtime"] or 0) - mtime) < 0.001
            and row["status"] == "ok"
        )
        if unchanged and not force:
            report["skipped"] += 1
            continue
        try:
            sheets = read_any(path)
        except Exception as exc:  # noqa: BLE001
            report["errors"].append("%s：读取失败 %s" % (os.path.basename(path), exc))
            _save_file_row(conn, path, size, mtime, None, 0, "error", "读取失败：%s" % exc, row)
            continue

        total = 0
        kinds = set()
        problems = []
        file_dates = set()
        ship_keys_by_date = {}
        for sheet_name, rows in sheets:
            if not rows:
                continue
            kind, header_idx, mapping, hits = detect_kind(rows)
            if not kind:
                continue
            try:
                if kind == "ship":
                    parsed = parse_ship(rows, header_idx, mapping)
                    changes = _upsert_ship(conn, parsed, 0)
                    change_acc["added"] += changes["added"]
                    change_acc["changed"] += changes["changed"]
                    change_acc["waves"] |= changes["waves"]
                    change_acc["pick_dates"] |= changes["pick_dates"]
                    change_acc["check_dates"] |= changes["check_dates"]
                    for item in parsed:
                        if item.get("order_date"):
                            archive_dates.add(item["order_date"])
                            file_dates.add(item["order_date"])
                            ship_keys_by_date.setdefault(item["order_date"], set()).add(_row_key(item))
                elif kind == "tms":
                    parsed = parse_tms(rows, header_idx, mapping)
                    changes = _upsert_tms(conn, parsed, 0)
                    change_acc["added"] += changes["added"]
                    change_acc["changed"] += changes["changed"]
                    change_acc["waves"] |= changes["waves"]
                    for item in parsed:
                        if item.get("wave_no"):
                            archive_waves.add(item["wave_no"])
                elif kind == "battery_dealer":
                    parsed = _import_battery_dealer_rows(conn, rows, header_idx, mapping)
                else:
                    parsed = _import_dealer_rows(conn, rows, header_idx, mapping)
                total += len(parsed)
                kinds.add(kind)
            except Exception as exc:  # noqa: BLE001
                problems.append("%s 解析失败：%s" % (sheet_name, exc))

        if not kinds:
            report["errors"].append("%s：未识别出表头（需要 发运表 或 运输单状态 的列名）" % os.path.basename(path))
            _save_file_row(conn, path, size, mtime, None, 0, "unknown", "未识别表头", row)
            continue

        kind_str = "+".join(sorted(kinds))
        file_id = _save_file_row(
            conn, path, size, mtime, kind_str, total,
            "ok" if not problems else "partial",
            "；".join(problems) or None, row,
            ",".join(sorted(file_dates)),
        )
        for day, keys in ship_keys_by_date.items():
            previous = ship_snapshots.get(day)
            if previous is None or mtime >= previous[0]:
                ship_snapshots[day] = (mtime, keys)
        # 回填 src_file_id
        for table, key in (("ship_lines", "wms_no"), ("tms_status", "wave_no")):
            if table == "ship_lines" and "ship" in kinds:
                conn.execute(
                    "UPDATE ship_lines SET src_file_id=? WHERE src_file_id=0", (file_id,)
                )
            if table == "tms_status" and "tms" in kinds:
                conn.execute("UPDATE tms_status SET src_file_id=? WHERE src_file_id=0", (file_id,))
        try:
            if "ship" in kinds and "出库流程节点时间跟踪" in os.path.basename(path):
                info = outbound_archive.save_from_sheets(
                    conn, path, sheets, biz_date=(max(file_dates) if file_dates else None)
                )
                if info.get("archived"):
                    report["archived_files"].append(info.get("name"))
                elif info.get("error"):
                    report["archive_errors"].append("%s：%s" % (os.path.basename(path), info["error"]))
        except Exception as exc:  # noqa: BLE001
            report["archive_errors"].append("%s：归档失败 %s" % (os.path.basename(path), exc))
        report["kinds"][kind_str] = report["kinds"].get(kind_str, 0) + total
        report["files"].append({
            "name": os.path.basename(path),
            "kind": kind_str,
            "rows": total,
            "biz_dates": sorted(file_dates),
            "status": "partial" if problems else "ok",
        })
        if row is None:
            report["imported"] += 1
        else:
            report["updated"] += 1
        if verbose:
            print("  已导入 %-40s %-10s %6d 行" % (os.path.basename(path), kind_str, total))

    for day, (mtime, wanted_keys) in ship_snapshots.items():
        rows = conn.execute(
            "SELECT id, wms_no, line_no FROM ship_lines WHERE order_date=?", (day,)
        ).fetchall()
        stale = [r["id"] for r in rows if _row_key(r) not in wanted_keys]
        for start in range(0, len(stale), 400):
            part = stale[start:start + 400]
            marks = ",".join("?" * len(part))
            conn.execute("DELETE FROM ship_lines WHERE id IN (%s)" % marks, part)
        report["removed_stale_rows"] += len(stale)

    report["added_rows"] = change_acc["added"]
    report["changed_rows"] = change_acc["changed"]
    report["affected_waves"] = sorted(change_acc["waves"])
    report["affected_pick_dates"] = sorted(change_acc["pick_dates"])
    report["affected_check_dates"] = sorted(change_acc["check_dates"])

    if report["imported"] or report["updated"] or force:
        db.bump_version(conn)
        try:
            import rules

            rules.rebuild_snapshots(conn)
        except Exception as exc:  # noqa: BLE001
            report["errors"].append("快照重建失败：%s" % exc)
    return report


def _save_file_row(conn, path, size, mtime, kind, rows, status, error, existing, biz_dates=""):
    """幂等写入文件台账：并发扫描时也不会撞 UNIQUE(path)。"""
    now = db.now_str()
    conn.execute(
        "INSERT INTO source_files(path, name, size, mtime, kind, rows, status, error, imported_at, biz_dates) "
        "VALUES(?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(path) DO UPDATE SET name=excluded.name, size=excluded.size, mtime=excluded.mtime, "
        "kind=excluded.kind, rows=excluded.rows, status=excluded.status, error=excluded.error, "
        "imported_at=excluded.imported_at, biz_dates=excluded.biz_dates",
        (path, os.path.basename(path), size, mtime, kind, rows, status, error, now, biz_dates),
    )
    row = conn.execute("SELECT id FROM source_files WHERE path=?", (path,)).fetchone()
    return row["id"] if row else None


# ---------------------------------------------------------------- 经销商映射
def _import_dealer_rows(conn, rows, header_idx, mapping):
    """把经销商映射行写入 dealer_map，返回占位列表（长度=条数）。"""
    now = db.now_str()
    count = 0
    for row in rows[header_idx + 1 :]:
        full = text(row_get(row, mapping, "full_name"))
        if not full:
            continue
        conn.execute(
            "INSERT INTO dealer_map(full_name, short_name, region, route, updated_at) "
            "VALUES(?,?,?,?,?) ON CONFLICT(full_name) DO UPDATE SET "
            "short_name=excluded.short_name, region=excluded.region, route=excluded.route, "
            "updated_at=excluded.updated_at",
            (
                full,
                text(row_get(row, mapping, "short_name")) or full,
                text(row_get(row, mapping, "region")),
                text(row_get(row, mapping, "route")),
                now,
            ),
        )
        count += 1
    return [None] * count


def _import_battery_dealer_rows(conn, rows, header_idx, mapping):
    now = db.now_str()
    count = 0
    for row in rows[header_idx + 1:]:
        dealer = text(row_get(row, mapping, "dealer"))
        if not dealer:
            continue
        conn.execute(
            "INSERT INTO battery_dealer_map(dealer_full, dealer_short, zone, doc_type, freight_free, region, carrier, dest_city, address, updated_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dealer_full) DO UPDATE SET "
            "dealer_short=COALESCE(NULLIF(excluded.dealer_short,''), battery_dealer_map.dealer_short), "
            "zone=COALESCE(NULLIF(excluded.zone,''), battery_dealer_map.zone), "
            "doc_type=COALESCE(NULLIF(excluded.doc_type,''), battery_dealer_map.doc_type), "
            "freight_free=COALESCE(NULLIF(excluded.freight_free,''), battery_dealer_map.freight_free), "
            "region=COALESCE(NULLIF(excluded.region,''), battery_dealer_map.region), "
            "carrier=COALESCE(NULLIF(excluded.carrier,''), battery_dealer_map.carrier), "
            "dest_city=COALESCE(NULLIF(excluded.dest_city,''), battery_dealer_map.dest_city), "
            "address=COALESCE(NULLIF(excluded.address,''), battery_dealer_map.address), "
            "updated_at=excluded.updated_at",
            (
                dealer,
                text(row_get(row, mapping, "dealer_short")),
                text(row_get(row, mapping, "zone")),
                text(row_get(row, mapping, "doc_type")),
                text(row_get(row, mapping, "freight_free")),
                text(row_get(row, mapping, "region")),
                text(row_get(row, mapping, "carrier")),
                text(row_get(row, mapping, "dest_city")),
                text(row_get(row, mapping, "address")),
                now,
            ),
        )
        count += 1
    return [None] * count


def import_dealer_workbook(conn, path):
    """导入 dealers.xlsx：普通经销商 + 动力电池地址映射。"""
    sheets = read_any(path)
    base = battery = 0
    for _name, rows in sheets:
        hdr, mapping, hits = find_header(rows, DEALER_HEADERS)
        if hdr is not None and "full_name" in mapping:
            base += len(_import_dealer_rows(conn, rows, hdr, mapping))
            continue
        bhdr, bmapping, bhits = find_header(rows, BATTERY_DEALER_HEADERS)
        if bhdr is not None and "dealer" in bmapping:
            if "zone" not in bmapping:
                bmapping["zone"] = 1
            battery += len(_import_battery_dealer_rows(conn, rows, bhdr, bmapping))
    db.bump_version(conn)
    return {"base": base, "battery": battery, "total": base + battery}


def import_dealers(conn, path):
    result = import_dealer_workbook(conn, path)
    return result["base"]


# ---------------------------------------------------------------- CLI
def _print_report(report):
    print("数据源目录：")
    for d in report.get("dirs") or []:
        print("  %s %s" % ("OK " if os.path.isdir(d) else "不可达", d))
    print(
        "扫描 %d 个文件：新导入 %d，更新 %d，未变 %d"
        % (
            report.get("scanned", 0),
            report.get("imported", 0),
            report.get("updated", 0),
            report.get("skipped", 0),
        )
    )
    for kind, rows in (report.get("kinds") or {}).items():
        print("  类型 %-10s %d 行" % (kind, rows))
    for err in report.get("errors") or []:
        print("  ! %s" % err)


def check(conn):
    import rules

    dates = [
        r["biz_date"]
        for r in conn.execute(
            "SELECT DISTINCT biz_date FROM wave_registry WHERE deleted_at IS NULL ORDER BY biz_date"
        )
    ]
    all_dates = [
        r["order_date"]
        for r in conn.execute(
            "SELECT DISTINCT order_date FROM ship_lines WHERE order_date IS NOT NULL ORDER BY order_date"
        )
    ]
    print("发运表日期：", ", ".join(all_dates[-8:]) or "（空）")
    print("已登记业务日：", ", ".join(dates[-8:]) or "（空）")
    target = dates[-1] if dates else (all_dates[-1] if all_dates else db.today_str())
    data = rules.dashboard_bundle(conn, target, None)
    kpi = data["kpi"]
    print("\n业务日 %s 复算结果：" % target)
    print("  登记波次      %d" % kpi["waves"])
    print("  订单组        %d" % kpi["groups"])
    print("  行数          %d" % kpi["lines"])
    print("  金额(万元)    %.2f" % ((kpi.get("amount") or 0) / 10000.0))
    print("  已拣行数      %d" % kpi["picked"])
    print("  已复核行数    %d" % kpi["checked"])
    print("  已出库行数    %d" % kpi["out"])
    print("  出库完成率    %.1f%%" % (kpi["out_rate"] * 100))
    print("  发货完成组    %d (%.1f%%)" % (kpi["ship_groups"], kpi["ship_rate"] * 100))
    print("  状态分布：")
    for item in data["status"]:
        print("    %-8s %d" % (item["label"], item["value"]))
    print("  TMS 命中波次  %d / %d" % (kpi["tms_waves"], kpi["waves"]))


def register_waves(conn, path, biz_date, user_id=None):
    with open(path, "r", encoding="utf-8-sig") as fh:
        raw = fh.read()
    waves = [w for w in re.split(r"[\s,，;；]+", raw) if w]
    added = 0
    for wave in waves:
        cur = conn.execute(
            "INSERT INTO wave_registry(biz_date, wave_no, created_by, created_at, updated_by, updated_at) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(biz_date, wave_no) DO UPDATE SET deleted_at=NULL, "
            "updated_at=excluded.updated_at",
            (biz_date, wave, user_id, db.now_str(), user_id, db.now_str()),
        )
        added += 1 if cur.rowcount else 0
    db.bump_version(conn)
    import rules

    rules.rebuild_snapshots(conn)
    return added


def main(argv):
    import config_loader

    config = config_loader.load()
    conn = db.init_db()
    if "--scan" in argv or len(argv) == 1:
        report = scan(conn, config)
        _print_report(report)
    if "--check" in argv:
        check(conn)
    if "--import-dealers" in argv:
        path = argv[argv.index("--import-dealers") + 1]
        print("导入经销商映射：%d 条" % import_dealers(conn, path))
    if "--register-waves" in argv:
        path = argv[argv.index("--register-waves") + 1]
        biz_date = db.today_str()
        if "--date" in argv:
            biz_date = argv[argv.index("--date") + 1]
        print("登记波次 %s：%d 条" % (biz_date, register_waves(conn, path, biz_date)))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
