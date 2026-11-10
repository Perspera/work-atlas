# -*- coding: utf-8 -*-
"""扫描文件归档：把数据源目录里识别到的文件留一份副本 + 行数据快照。

规则（与用户确认）：
- **只归档数据**：把扫描到的行数据写成 jsonl.gz 快照（含表头），不保留原始 xlsx/csv
- 同一个文件路径只保留**最新一版**（内容 sha256 相同则跳过，不重复存）
- 默认保留 7 天，过期自动清理（DB 记录 + 本地快照）
- 归档失败不影响扫描导入，只在报告里记一条告警
"""
import gzip
import hashlib
import io
import json
import os
import re
import shutil
from datetime import date, datetime, time, timedelta

import db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
ARCHIVE_DIR = os.path.join(DATA_DIR, "source_archive")
PREVIEW_ROWS = 100
KEEP_DAYS = 7
STORAGE_META_KEY = "source_archive_storage_v1"


def _rel(path):
    return os.path.relpath(path, DATA_DIR).replace("\\", "/")


def _abs(rel):
    return os.path.join(DATA_DIR, rel.replace("/", os.sep))


def _safe_name(name):
    base = re.sub(r'[\\/:*?"<>|]+', "_", name or "file")
    stem, ext = os.path.splitext(base)
    return (stem[:80] or "file") + ext


def _jval(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.strftime("%Y-%m-%d %H:%M:%S")
    if isinstance(value, date):
        return value.strftime("%Y-%m-%d")
    if isinstance(value, time):
        return value.strftime("%H:%M:%S")
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


def _sheet_meta(rows):
    meta = []
    for index, sheet in enumerate(rows or []):
        name, values = sheet[0], sheet[1] or []
        if not values:
            continue
        headers = [_jval(c) for c in values[0]]
        meta.append({"name": name or ("Sheet%d" % (index + 1)), "headers": headers, "rows": max(0, len(values) - 1)})
    return meta


def _preview(rows):
    sheets = []
    for index, sheet in enumerate(rows or []):
        name, values = sheet[0], sheet[1] or []
        if not values:
            continue
        sheets.append(
            {
                "name": name or ("Sheet%d" % (index + 1)),
                "headers": [_jval(c) for c in values[0]],
                "rows": [[_jval(c) for c in row] for row in values[1 : PREVIEW_ROWS + 1]],
            }
        )
    return {"sheets": sheets}


def _write_rows(rows_path, rows):
    total = 0
    with gzip.open(rows_path, "wt", encoding="utf-8", newline="\n") as fh:
        for index, sheet in enumerate(rows or []):
            name, values = sheet[0], sheet[1] or []
            for row in values[1:] if values else []:
                fh.write(json.dumps({"sheet": name or ("Sheet%d" % (index + 1)),
                                     "row": [_jval(c) for c in row]}, ensure_ascii=False))
                fh.write("\n")
                total += 1
    return total


def _biz_dates(conn, order_dates, waves):
    dates = {d for d in (order_dates or []) if d}
    waves = [w for w in (waves or []) if w]
    for start in range(0, len(waves), 400):
        part = waves[start : start + 400]
        marks = ",".join("?" * len(part))
        for row in conn.execute(
            "SELECT DISTINCT biz_date FROM wave_registry WHERE deleted_at IS NULL AND wave_no IN (%s)" % marks,
            part,
        ):
            if row["biz_date"]:
                dates.add(row["biz_date"])
    return ",".join(sorted(dates))


def archive(conn, path, kind, sheets, order_dates=None, waves=None, source_file_id=None):
    """归档一个文件：只写行数据快照 + DB 记录（每个路径只留最新一版）。"""
    name = os.path.basename(path)
    try:
        stat = os.stat(path)
    except OSError as exc:
        return {"name": name, "archived": False, "error": "读取文件失败：%s" % exc}
    try:
        sha = _sha256(path)
    except OSError as exc:
        return {"name": name, "archived": False, "error": "计算指纹失败：%s" % exc}

    existing = conn.execute("SELECT * FROM source_archive WHERE path=?", (path,)).fetchone()
    if existing and existing["sha256"] == sha:
        return {"name": name, "archived": False, "skipped": True}

    day = datetime.now().strftime("%Y%m%d")
    safe = _safe_name(name)
    stem, _ext = os.path.splitext(safe)
    rel_rows = "source_archive/rows/%s/%s.%s.jsonl.gz" % (day, stem, sha[:8])
    abs_rows = _abs(rel_rows)
    os.makedirs(os.path.dirname(abs_rows), exist_ok=True)

    try:
        total = _write_rows(abs_rows, sheets)
    except OSError as exc:
        return {"name": name, "archived": False, "error": "写行快照失败：%s" % exc}
    try:
        stored_bytes = os.path.getsize(abs_rows)
    except OSError:
        stored_bytes = 0

    now = db.now_str()
    values = (
        path, name, kind, stat.st_size, sha, total, now,
        None, rel_rows, stored_bytes,
        json.dumps(_sheet_meta(sheets), ensure_ascii=False),
        json.dumps(_preview(sheets), ensure_ascii=False),
        _biz_dates(conn, order_dates, waves), source_file_id, None,
    )
    conn.execute(
        "INSERT INTO source_archive(path, name, kind, size, sha256, rows, scan_at, file_path, rows_path, "
        "stored_bytes, sheets_json, preview_json, biz_dates, source_file_id, error) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) "
        "ON CONFLICT(path) DO UPDATE SET name=excluded.name, kind=excluded.kind, size=excluded.size, "
        "sha256=excluded.sha256, rows=excluded.rows, scan_at=excluded.scan_at, "
        "file_path=NULL, rows_path=excluded.rows_path, stored_bytes=excluded.stored_bytes, "
        "sheets_json=excluded.sheets_json, preview_json=excluded.preview_json, "
        "biz_dates=excluded.biz_dates, source_file_id=excluded.source_file_id, error=excluded.error",
        values,
    )
    # 覆盖成功后删除旧版本快照（每个文件只留最新）；顺带清掉历史原文件副本
    if existing:
        for old in (existing["file_path"], existing["rows_path"]):
            if old and old != rel_rows:
                try:
                    target = _abs(old)
                    if os.path.isfile(target):
                        os.remove(target)
                except OSError:
                    pass
    return {
        "name": name,
        "archived": True,
        "rows": total,
        "size": stat.st_size,
        "stored_bytes": stored_bytes,
        "sha256": sha,
        "kind": kind,
        "error": None,
    }


def migrate_storage(conn):
    """一次性迁移：删除历史上保存的原始文件副本，只保留行数据快照。"""
    if db.get_meta(conn, STORAGE_META_KEY) == "1":
        return {"skipped": True}
    legacy_dir = os.path.join(ARCHIVE_DIR, "files")
    removed_dir = False
    if os.path.isdir(legacy_dir):
        shutil.rmtree(legacy_dir, ignore_errors=True)
        removed_dir = True
    updated = 0
    for row in conn.execute(
        "SELECT id, rows_path FROM source_archive WHERE file_path IS NOT NULL OR stored_bytes IS NULL OR stored_bytes=0"
    ).fetchall():
        stored = 0
        if row["rows_path"]:
            try:
                stored = os.path.getsize(_abs(row["rows_path"]))
            except OSError:
                pass
        conn.execute(
            "UPDATE source_archive SET file_path=NULL, stored_bytes=? WHERE id=?", (stored, row["id"])
        )
        updated += 1
    db.set_meta(conn, STORAGE_META_KEY, "1")
    return {"removed_files_dir": removed_dir, "updated": updated}


def cleanup(conn, keep_days=KEEP_DAYS):
    """删除超过保留期的归档（DB 记录 + 本地快照），顺带清历史原文件副本与孤儿文件。"""
    cutoff = (datetime.now() - timedelta(days=max(0, int(keep_days)))).strftime("%Y-%m-%d %H:%M:%S")
    removed = 0
    # 兜底：历史版本可能还带着原文件副本，直接删掉并置空
    for row in conn.execute("SELECT id, file_path FROM source_archive WHERE file_path IS NOT NULL"):
        try:
            target = _abs(row["file_path"])
            if os.path.isfile(target):
                os.remove(target)
        except OSError:
            pass
        conn.execute("UPDATE source_archive SET file_path=NULL WHERE id=?", (row["id"],))
    for row in conn.execute("SELECT id, rows_path FROM source_archive WHERE scan_at < ?", (cutoff,)):
        if row["rows_path"]:
            try:
                target = _abs(row["rows_path"])
                if os.path.isfile(target):
                    os.remove(target)
            except OSError:
                pass
        conn.execute("DELETE FROM source_archive WHERE id=?", (row["id"],))
        removed += 1
    # 孤儿文件（DB 里没有引用的副本/快照）
    referenced = set()
    for row in conn.execute("SELECT rows_path FROM source_archive"):
        rel = row["rows_path"]
        if rel:
            referenced.add(os.path.normcase(_abs(rel)))
    orphans = 0
    if os.path.isdir(ARCHIVE_DIR):
        for root, _dirs, files in os.walk(ARCHIVE_DIR):
            for name in files:
                full = os.path.join(root, name)
                if os.path.normcase(full) not in referenced:
                    try:
                        os.remove(full)
                        orphans += 1
                    except OSError:
                        pass
    if removed or orphans:
        db.set_meta(conn, "last_source_archive_cleanup", db.now_str())
    return {"removed": removed, "orphans": orphans, "keep_days": keep_days}


def logical_file_key(name):
    """把带日期/复制序号的同一业务文件归到一个逻辑文件名。"""
    stem = os.path.splitext(os.path.basename(name or ""))[0]
    stem = re.sub(r"\s*\(\d+\)\s*$", "", stem)
    stem = re.sub(r"[-_ ]?\d{4}[-_.]\d{1,2}[-_.]\d{1,2}$", "", stem)
    stem = re.sub(r"[-_ ]?\d{8}$", "", stem)
    return stem.strip() or os.path.basename(name or "")


def list_archives(conn, kind=None, q=None, date_from=None, date_to=None):
    conds, params = [], []
    if kind and kind != "all":
        conds.append("kind = ?")
        params.append(kind)
    if q:
        conds.append("(name LIKE ? OR path LIKE ?)")
        like = "%" + q + "%"
        params.extend([like, like])
    if date_from:
        conds.append("substr(scan_at,1,10) >= ?")
        params.append(date_from)
    if date_to:
        conds.append("substr(scan_at,1,10) <= ?")
        params.append(date_to)
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    rows = conn.execute(
        "SELECT id, name, kind, size, sha256, rows, scan_at, biz_dates, error, rows_path, stored_bytes "
        "FROM source_archive" + where + " ORDER BY scan_at DESC, id DESC",
        params,
    ).fetchall()
    items, total_bytes = [], 0
    for row in rows:
        stored = int(row["stored_bytes"] or 0)
        if not stored and row["rows_path"]:
            try:
                stored = os.path.getsize(_abs(row["rows_path"]))
            except OSError:
                stored = 0
        total_bytes += stored
        items.append(
            {
                "id": row["id"], "name": row["name"], "kind": row["kind"],
                "size": row["size"], "stored_bytes": stored,
                "sha256": row["sha256"], "rows": row["rows"], "scan_at": row["scan_at"],
                "biz_dates": row["biz_dates"], "error": row["error"],
                "has_rows": 1 if row["rows_path"] else 0,
            }
        )
    return {
        "rows": items,
        "total": len(rows),
        "bytes": total_bytes,
        "keep_days": KEEP_DAYS,
        "last_cleanup": db.get_meta(conn, "last_source_archive_cleanup", ""),
    }


def get(conn, archive_id):
    return conn.execute("SELECT * FROM source_archive WHERE id=?", (archive_id,)).fetchone()


def preview(conn, archive_id, limit=PREVIEW_ROWS):
    row = get(conn, archive_id)
    if not row:
        return None
    try:
        data = json.loads(row["preview_json"] or "{}")
    except ValueError:
        data = {}
    sheets = data.get("sheets") or []
    for sheet in sheets:
        sheet["rows"] = sheet.get("rows", [])[: max(1, int(limit or PREVIEW_ROWS))]
    return {
        "id": row["id"],
        "name": row["name"],
        "kind": row["kind"],
        "rows": row["rows"],
        "scan_at": row["scan_at"],
        "biz_dates": row["biz_dates"],
        "sheets": sheets,
        "error": row["error"],
    }


def iter_rows(conn, archive_id):
    row = get(conn, archive_id)
    if not row or not row["rows_path"]:
        return
    path = _abs(row["rows_path"])
    if not os.path.isfile(path):
        return
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            yield json.loads(line)


def export_csv(conn, archive_id):
    row = get(conn, archive_id)
    if not row:
        return None
    names, headers = [], {}
    try:
        meta = json.loads(row["sheets_json"] or "[]")
    except ValueError:
        meta = []
    for sheet in meta:
        names.append(sheet.get("name") or "")
        headers[sheet.get("name") or ""] = sheet.get("headers") or []
    buffer = io.StringIO()
    import csv as _csv

    writer = _csv.writer(buffer)
    multi = len(names) > 1
    sheet_names = names or [""]
    writer.writerow((["工作表"] if multi else []) + headers.get(sheet_names[0], []))
    for item in iter_rows(conn, archive_id):
        sheet = item.get("sheet") or ""
        values = item.get("row") or []
        if multi:
            writer.writerow([sheet] + values)
        else:
            writer.writerow(values)
    return ("\ufeff" + buffer.getvalue()).encode("utf-8")


def summary(conn):
    row = conn.execute(
        "SELECT COUNT(*) AS c, COALESCE(SUM(stored_bytes),0) AS b, MAX(scan_at) AS latest "
        "FROM source_archive"
    ).fetchone()
    return {
        "count": row["c"] if row else 0,
        "bytes": row["b"] if row else 0,
        "latest_at": row["latest"] if row else None,
        "keep_days": KEEP_DAYS,
        "last_cleanup": db.get_meta(conn, "last_source_archive_cleanup", ""),
    }
