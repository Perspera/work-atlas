# -*- coding: utf-8 -*-
"""【出库】出库流程节点时间跟踪(配送中心) 文件归档。

- 只归档这一份逻辑文件：扫描读取到的表头 + 全部行数据；
- 同一逻辑文件只保留一份当前内容；文件变化时覆盖旧快照；
- 提供按表头列筛选、日期列区间查询、分页和导出。
"""
import csv
import gzip
import hashlib
import io
import json
import os
import re
import tempfile
from datetime import date, datetime, timedelta

from backend.core import db

from backend import paths

BASE_DIR = paths.BASE_DIR
DATA_DIR = paths.DATA_DIR
ARCHIVE_DIR = paths.OUTBOUND_ARCHIVE_DIR
ROWS_FILE = os.path.join(ARCHIVE_DIR, "rows.jsonl.gz")
LEGACY_META = "outbound_archive_legacy_migrated_v1"
PAGE_SIZE = 50
MAX_PAGE_SIZE = 200


def _jval(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, (int, bool, str)):
        return value
    return str(value)


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(1024 * 1024)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def _write_items(items):
    """把 {sheet,row} 写入临时快照，返回 (临时路径, 行数)。"""
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix="rows_", suffix=".jsonl.gz", dir=ARCHIVE_DIR)
    os.close(fd)
    total = 0
    try:
        with gzip.open(tmp, "wt", encoding="utf-8", newline="\n") as fh:
            for item in items:
                fh.write(json.dumps({"sheet": item.get("sheet") or "", "row": [_jval(c) for c in (item.get("row") or [])]}, ensure_ascii=False))
                fh.write("\n")
                total += 1
    except Exception:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise
    return tmp, total


def _sheets_meta(sheets):
    meta = []
    for index, sheet in enumerate(sheets or []):
        name, values = sheet[0], sheet[1] or []
        if not values:
            continue
        meta.append({
            "name": name or ("Sheet%d" % (index + 1)),
            "headers": [_jval(c) for c in values[0]],
            "rows": max(0, len(values) - 1),
        })
    return meta


def _date_from_path(path, fallback=None):
    name = os.path.basename(str(path or ""))
    match = re.search(r"(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})", name)
    if match:
        return "%s-%s-%s" % match.groups()
    return fallback or date.today().isoformat()


def _snapshot_path(biz_date, sha):
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    return os.path.join(ARCHIVE_DIR, "%s-%s.jsonl.gz" % (biz_date, (sha or "unknown")[:8]))


def save_from_sheets(conn, path, sheets, sha256=None, biz_date=None):
    """扫描到出库文件时保存/覆盖内容；sha 未变则跳过。"""
    name = os.path.basename(path)
    biz_date = _date_from_path(path, biz_date)
    try:
        stat = os.stat(path)
    except OSError as exc:
        return {"archived": False, "error": "读取文件信息失败：%s" % exc}
    sha = sha256 or _sha256(path)
    existing = conn.execute("SELECT * FROM outbound_archive WHERE id=1").fetchone()
    if existing and existing["sha256"] == sha:
        return {"archived": False, "skipped": True, "rows": existing["rows"] or 0}

    meta = _sheets_meta(sheets)
    if not meta:
        return {"archived": False, "error": "文件没有可归档的数据行"}

    items = []
    for index, sheet in enumerate(sheets or []):
        sname, values = sheet[0], sheet[1] or []
        if not values:
            continue
        sheet_name = sname or ("Sheet%d" % (index + 1))
        for row in values[1:]:
            items.append({"sheet": sheet_name, "row": row})
    if not items:
        return {"archived": False, "error": "文件没有可归档的数据行"}

    target_path = _snapshot_path(biz_date, sha)
    tmp = None
    try:
        tmp, total = _write_items(items)
        os.replace(tmp, target_path)
        tmp = None
    except OSError as exc:
        if tmp and os.path.isfile(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
        return {"archived": False, "error": "写归档快照失败：%s" % exc}

    try:
        stored = os.path.getsize(target_path)
    except OSError:
        stored = 0
    now = db.now_str()
    rel = os.path.relpath(target_path, DATA_DIR).replace("\\", "/")
    conn.execute(
        "INSERT INTO outbound_archive_snapshots(biz_date, name, path, sha256, size, rows, sheets_json, "
        "rows_path, stored_bytes, archived_at) VALUES(?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(biz_date, sha256) DO UPDATE SET name=excluded.name, path=excluded.path, "
        "size=excluded.size, rows=excluded.rows, sheets_json=excluded.sheets_json, "
        "rows_path=excluded.rows_path, stored_bytes=excluded.stored_bytes, archived_at=excluded.archived_at",
        (biz_date, name, path, sha, stat.st_size, total, json.dumps(meta, ensure_ascii=False), rel, stored, now),
    )
    # 同一业务日只保留最新一份
    conn.execute("DELETE FROM outbound_archive_snapshots WHERE biz_date=? AND sha256<>?", (biz_date, sha))
    conn.execute("DELETE FROM outbound_archive WHERE id=1")
    conn.execute(
        "INSERT INTO outbound_archive(id, name, path, sha256, size, rows, sheets_json, rows_path, stored_bytes, updated_at) "
        "VALUES(1,?,?,?,?,?,?,?,?,?)",
        (name, path, sha, stat.st_size, total, json.dumps(meta, ensure_ascii=False), rel, stored, now),
    )
    conn.commit()
    return {"archived": True, "rows": total, "size": stat.st_size, "stored_bytes": stored,
            "name": name, "biz_date": biz_date}


def _snapshot_row(conn, biz_date=None):
    if biz_date:
        return conn.execute(
            "SELECT * FROM outbound_archive_snapshots WHERE biz_date=? ORDER BY archived_at DESC, id DESC LIMIT 1",
            (biz_date,),
        ).fetchone()
    row = conn.execute(
        "SELECT * FROM outbound_archive_snapshots ORDER BY biz_date DESC, archived_at DESC LIMIT 1"
    ).fetchone()
    if row:
        return row
    return conn.execute("SELECT * FROM outbound_archive WHERE id=1").fetchone()


def _iter_rows(conn, biz_date=None):
    row = _snapshot_row(conn, biz_date)
    if not row or not row["rows_path"]:
        return
    path = os.path.join(DATA_DIR, row["rows_path"].replace("/", os.sep))
    if not os.path.isfile(path):
        return
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except ValueError:
                continue


def list_dates(conn):
    rows = conn.execute(
        "SELECT biz_date, MAX(rows) AS rows, MAX(archived_at) AS archived_at, MAX(name) AS name "
        "FROM outbound_archive_snapshots GROUP BY biz_date ORDER BY biz_date DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def get_meta(conn, biz_date=None):
    row = _snapshot_row(conn, biz_date)
    if not row:
        return None
    try:
        sheets = json.loads(row["sheets_json"] or "[]")
    except ValueError:
        sheets = []
    sheet = sheets[0] if sheets else {"name": "", "headers": [], "rows": 0}
    headers = sheet.get("headers") or []
    date_cols = [h for h in headers if h and ("日期" in str(h) or "时间" in str(h))]
    return {
        "biz_date": row["biz_date"] if "biz_date" in row.keys() else biz_date,
        "name": row["name"],
        "path": row["path"],
        "sha256": row["sha256"],
        "size": row["size"] or 0,
        "rows": row["rows"] or 0,
        "stored_bytes": row["stored_bytes"] or 0,
        "updated_at": row["updated_at"] if "updated_at" in row.keys() else row["archived_at"],
        "sheets": [{"name": s.get("name"), "headers": s.get("headers") or [], "rows": s.get("rows") or 0} for s in sheets],
        "sheet": sheet.get("name") or "",
        "headers": headers,
        "date_columns": date_cols,
    }


def _date_part(value):
    if value is None or value == "":
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, (int, float)):
        # Excel 日期序列号（1900 日期系统）
        try:
            if 1 <= float(value) <= 100000:
                return (datetime(1899, 12, 30) + timedelta(days=float(value))).strftime("%Y-%m-%d")
        except Exception:
            return ""
    raw = str(value).strip()
    match = re.match(r"^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})", raw)
    if match:
        return "%04d-%02d-%02d" % (int(match.group(1)), int(match.group(2)), int(match.group(3)))
    match = re.match(r"^(\d{4})(\d{2})(\d{2})$", raw)
    if match:
        return "%s-%s-%s" % (match.group(1), match.group(2), match.group(3))
    return ""


def _normalize_filters(raw, headers):
    filters = []
    header_set = {str(h) for h in headers}
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        col = str(item.get("col") or "").strip()
        value = item.get("value")
        if not col or col not in header_set or value is None or str(value) == "":
            continue
        op = "eq" if item.get("op") == "eq" else "contains"
        filters.append({"col": col, "op": op, "value": str(value)})
    return filters[:3]


def _match(row, headers, filters, date_col, date_from, date_to):
    index = {str(h): i for i, h in enumerate(headers)}
    for item in filters:
        i = index[item["col"]]
        value = "" if i >= len(row) or row[i] is None else str(row[i])
        if item["op"] == "eq":
            if value != item["value"]:
                return False
        elif item["value"] not in value:
            return False
    if date_col and (date_from or date_to):
        i = index.get(str(date_col))
        if i is None:
            return False
        current = _date_part(row[i] if i < len(row) else "")
        if not current:
            return False
        if date_from and current < date_from:
            return False
        if date_to and current > date_to:
            return False
    return True


def _load_filtered(conn, filters, date_col, date_from, date_to, biz_date=None):
    meta = get_meta(conn, biz_date)
    if not meta:
        return None, []
    headers = meta["headers"]
    filters = _normalize_filters(filters, headers)
    rows = []
    for item in _iter_rows(conn, biz_date):
        if item.get("sheet") not in ("", meta["sheet"]):
            continue
        row = item.get("row") or []
        if _match(row, headers, filters, date_col, date_from, date_to):
            rows.append(row)
    return meta, rows


def query(conn, filters=None, date_col="", date_from="", date_to="", page=1, page_size=PAGE_SIZE, biz_date=None):
    meta, rows = _load_filtered(conn, filters, date_col, date_from, date_to, biz_date)
    if meta is None:
        return None
    page = max(1, int(page or 1))
    page_size = max(1, min(MAX_PAGE_SIZE, int(page_size or PAGE_SIZE)))
    total = len(rows)
    pages = max(1, (total + page_size - 1) // page_size) if total else 1
    page = min(page, pages)
    start = (page - 1) * page_size
    return {
        "meta": {k: meta[k] for k in ("biz_date", "name", "rows", "updated_at", "headers", "date_columns", "sheet", "sheets")},
        "filters": _normalize_filters(filters, meta["headers"]),
        "date_col": date_col,
        "date_from": date_from,
        "date_to": date_to,
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
        "rows": rows[start : start + page_size],
    }


def export_csv(conn, filters=None, date_col="", date_from="", date_to="", biz_date=None):
    meta, rows = _load_filtered(conn, filters, date_col, date_from, date_to, biz_date)
    if meta is None:
        return None
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(meta["headers"])
    for row in rows:
        writer.writerow(row[: len(meta["headers"])])
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


def purge_legacy(conn):
    """旧 source_archive 功能下线：删除旧归档记录与快照。"""
    if db.get_meta(conn, LEGACY_META) == "1":
        return
    legacy_dir = os.path.join(DATA_DIR, "source_archive")
    try:
        for root, _dirs, files in os.walk(legacy_dir):
            for name in files:
                try:
                    os.remove(os.path.join(root, name))
                except OSError:
                    pass
    except OSError:
        pass
    try:
        conn.execute("DELETE FROM source_archive")
    except Exception:
        pass
    db.set_meta(conn, LEGACY_META, "1")


def seed_from_legacy(conn):
    """首次升级：把旧 source_archive 中最新一份出库流程文件转成新归档。"""
    if conn.execute("SELECT 1 FROM outbound_archive WHERE id=1").fetchone():
        return {"skipped": True}
    try:
        row = conn.execute(
            "SELECT * FROM source_archive WHERE kind LIKE '%ship%' AND name LIKE '%出库流程节点时间跟踪%' "
            "ORDER BY scan_at DESC, id DESC LIMIT 1"
        ).fetchone()
    except Exception:
        return {"skipped": True}
    if not row or not row["rows_path"]:
        return {"skipped": True}
    old = os.path.join(DATA_DIR, row["rows_path"].replace("/", os.sep))
    if not os.path.isfile(old):
        return {"skipped": True}
    try:
        meta = json.loads(row["sheets_json"] or "[]")
    except ValueError:
        meta = []
    if not meta:
        return {"skipped": True}
    items = []
    try:
        with gzip.open(old, "rt", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                item = json.loads(line)
                items.append({"sheet": item.get("sheet") or meta[0].get("name"), "row": item.get("row") or []})
    except (OSError, ValueError):
        return {"skipped": True}
    if not items:
        return {"skipped": True}
    target_path = _snapshot_path(biz_date, sha)
    tmp = None
    try:
        tmp, total = _write_items(items)
        os.replace(tmp, target_path)
        tmp = None
    except OSError:
        return {"skipped": True}
    try:
        stored = os.path.getsize(ROWS_FILE)
    except OSError:
        stored = 0
    now = db.now_str()
    conn.execute(
        "INSERT OR REPLACE INTO outbound_archive(id, name, path, sha256, size, rows, sheets_json, rows_path, stored_bytes, updated_at) "
        "VALUES(1,?,?,?,?,?,?,?,?,?)",
        (row["name"], row["path"], row["sha256"], row["size"] or 0, total,
         json.dumps(meta, ensure_ascii=False), os.path.relpath(ROWS_FILE, DATA_DIR).replace("\\", "/"),
         stored, now),
    )
    conn.commit()
    return {"seeded": True, "rows": total}
def _date_part(value):
    if value is None or value == "":
        return ""
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, (int, float)):
        # Excel 日期序列号（1900 日期系统）
        try:
            if 1 <= float(value) <= 100000:
                return (datetime(1899, 12, 30) + timedelta(days=float(value))).strftime("%Y-%m-%d")
        except Exception:
            return ""
    raw = str(value).strip()
    match = re.match(r"^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})", raw)
    if match:
        return "%04d-%02d-%02d" % (int(match.group(1)), int(match.group(2)), int(match.group(3)))
    match = re.match(r"^(\d{4})(\d{2})(\d{2})$", raw)
    if match:
        return "%s-%s-%s" % (match.group(1), match.group(2), match.group(3))
    return ""


def _normalize_filters(raw, headers):
    filters = []
    header_set = {str(h) for h in headers}
    for item in raw or []:
        if not isinstance(item, dict):
            continue
        col = str(item.get("col") or "").strip()
        value = item.get("value")
        if not col or col not in header_set or value is None or str(value) == "":
            continue
        op = "eq" if item.get("op") == "eq" else "contains"
        filters.append({"col": col, "op": op, "value": str(value)})
    return filters[:3]


def _match(row, headers, filters, date_col, date_from, date_to):
    index = {str(h): i for i, h in enumerate(headers)}
    for item in filters:
        i = index[item["col"]]
        value = "" if i >= len(row) or row[i] is None else str(row[i])
        if item["op"] == "eq":
            if value != item["value"]:
                return False
        elif item["value"] not in value:
            return False
    if date_col and (date_from or date_to):
        i = index.get(str(date_col))
        if i is None:
            return False
        current = _date_part(row[i] if i < len(row) else "")
        if not current:
            return False
        if date_from and current < date_from:
            return False
        if date_to and current > date_to:
            return False
    return True


def _load_filtered(conn, filters, date_col, date_from, date_to, biz_date=None):
    meta = get_meta(conn, biz_date)
    if not meta:
        return None, []
    headers = meta["headers"]
    filters = _normalize_filters(filters, headers)
    rows = []
    for item in _iter_rows(conn, biz_date):
        if item.get("sheet") not in ("", meta["sheet"]):
            continue
        row = item.get("row") or []
        if _match(row, headers, filters, date_col, date_from, date_to):
            rows.append(row)
    return meta, rows


def query(conn, filters=None, date_col="", date_from="", date_to="", page=1, page_size=PAGE_SIZE, biz_date=None):
    meta, rows = _load_filtered(conn, filters, date_col, date_from, date_to, biz_date)
    if meta is None:
        return None
    page = max(1, int(page or 1))
    page_size = max(1, min(MAX_PAGE_SIZE, int(page_size or PAGE_SIZE)))
    total = len(rows)
    pages = max(1, (total + page_size - 1) // page_size) if total else 1
    page = min(page, pages)
    start = (page - 1) * page_size
    return {
        "meta": {k: meta[k] for k in ("biz_date", "name", "rows", "updated_at", "headers", "date_columns", "sheet", "sheets")},
        "filters": _normalize_filters(filters, meta["headers"]),
        "date_col": date_col,
        "date_from": date_from,
        "date_to": date_to,
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": pages,
        "rows": rows[start : start + page_size],
    }


def export_csv(conn, filters=None, date_col="", date_from="", date_to="", biz_date=None):
    meta, rows = _load_filtered(conn, filters, date_col, date_from, date_to, biz_date)
    if meta is None:
        return None
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(meta["headers"])
    for row in rows:
        writer.writerow(row[: len(meta["headers"])])
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


def purge_legacy(conn):
    """旧 source_archive 功能下线：删除旧归档记录与快照。"""
    if db.get_meta(conn, LEGACY_META) == "1":
        return
    legacy_dir = os.path.join(DATA_DIR, "source_archive")
    try:
        for root, _dirs, files in os.walk(legacy_dir):
            for name in files:
                try:
                    os.remove(os.path.join(root, name))
                except OSError:
                    pass
    except OSError:
        pass
    try:
        conn.execute("DELETE FROM source_archive")
    except Exception:
        pass
    db.set_meta(conn, LEGACY_META, "1")


def seed_from_legacy(conn):
    """首次升级：把旧 source_archive 中最新一份出库流程文件转成新归档。"""
    if conn.execute("SELECT 1 FROM outbound_archive WHERE id=1").fetchone():
        return {"skipped": True}
    try:
        row = conn.execute(
            "SELECT * FROM source_archive WHERE kind LIKE '%ship%' AND name LIKE '%出库流程节点时间跟踪%' "
            "ORDER BY scan_at DESC, id DESC LIMIT 1"
        ).fetchone()
    except Exception:
        return {"skipped": True}
    if not row or not row["rows_path"]:
        return {"skipped": True}
    old = os.path.join(DATA_DIR, row["rows_path"].replace("/", os.sep))
    if not os.path.isfile(old):
        return {"skipped": True}
    try:
        meta = json.loads(row["sheets_json"] or "[]")
    except ValueError:
        meta = []
    if not meta:
        return {"skipped": True}
    items = []
    try:
        with gzip.open(old, "rt", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                item = json.loads(line)
                items.append({"sheet": item.get("sheet") or meta[0].get("name"), "row": item.get("row") or []})
    except (OSError, ValueError):
        return {"skipped": True}
    if not items:
        return {"skipped": True}
    target_path = _snapshot_path(biz_date, sha)
    tmp = None
    try:
        tmp, total = _write_items(items)
        os.replace(tmp, target_path)
        tmp = None
    except OSError:
        return {"skipped": True}
    try:
        stored = os.path.getsize(ROWS_FILE)
    except OSError:
        stored = 0
    now = db.now_str()
    conn.execute(
        "INSERT OR REPLACE INTO outbound_archive(id, name, path, sha256, size, rows, sheets_json, rows_path, stored_bytes, updated_at) "
        "VALUES(1,?,?,?,?,?,?,?,?,?)",
        (row["name"], row["path"], row["sha256"], row["size"] or 0, total,
         json.dumps(meta, ensure_ascii=False), os.path.relpath(ROWS_FILE, DATA_DIR).replace("\\", "/"),
         stored, now),
    )
    conn.commit()
    return {"seeded": True, "rows": total}


def backfill_history(conn):
    """首次升级：迁移当前快照，并从 WMS 下载目录补历史日期。"""
    if db.get_meta(conn, "outbound_archive_history_v1") == "1":
        return {"skipped": True}
    imported = []
    current = conn.execute("SELECT * FROM outbound_archive WHERE id=1").fetchone()
    if current and current["rows_path"]:
        biz_date = _date_from_path(current["path"] or current["name"], db.today_str())
        exists = conn.execute(
            "SELECT 1 FROM outbound_archive_snapshots WHERE biz_date=? LIMIT 1", (biz_date,)
        ).fetchone()
        if not exists:
            conn.execute(
                "INSERT INTO outbound_archive_snapshots(biz_date, name, path, sha256, size, rows, sheets_json, "
                "rows_path, stored_bytes, archived_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (biz_date, current["name"], current["path"], current["sha256"], current["size"] or 0,
                 current["rows"] or 0, current["sheets_json"], current["rows_path"],
                 current["stored_bytes"] or 0, current["updated_at"] or db.now_str()),
            )
            imported.append(biz_date)
    base = os.path.join(BASE_DIR, "tools", "wms_download", "downloads")
    try:
        names = sorted(os.listdir(base))
    except OSError:
        names = []
    for day in names:
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", day):
            continue
        folder = os.path.join(base, day)
        if not os.path.isdir(folder):
            continue
        if conn.execute("SELECT 1 FROM outbound_archive_snapshots WHERE biz_date=? LIMIT 1", (day,)).fetchone():
            continue
        for name in sorted(os.listdir(folder)):
            if "出库流程节点时间跟踪" not in name or not name.lower().endswith((".xlsx", ".xlsm")):
                continue
            path = os.path.join(folder, name)
            try:
                from backend.collect import ingest
                sheets = ingest.read_any(path)
                result = save_from_sheets(conn, path, sheets, biz_date=day)
                if result.get("archived"):
                    imported.append(day)
            except Exception:
                continue
            break
    conn.commit()
    db.set_meta(conn, "outbound_archive_history_v1", "1")
    return {"imported": imported}
