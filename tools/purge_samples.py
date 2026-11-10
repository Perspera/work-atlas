# -*- coding: utf-8 -*-
"""清理开发/演示期的样本数据，只保留 Z 盘真实数据。

用法：
    python tools/purge_samples.py            # 执行（会先备份）
    python tools/purge_samples.py --dry-run  # 只看会删什么

规则：
 1. 备份 data/dashboard.db 到 data/backup/pre_purge_<时间戳>.db
 2. 删除 source_files 中路径包含「样本」的文件台账，及其导入的 ship_lines / tms_status
 3. 删除 wave_registry / daily_snapshot / daily_archive 中样本业务日（2026-09-04、2026-09-05）
 4. 重建每日快照并打印前后统计
"""
import os
import shutil
import sqlite3
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, "data", "dashboard.db")
BACKUP_DIR = os.path.join(BASE, "data", "backup")
SAMPLE_DATES = ("2026-09-04", "2026-09-05")


def table_exists(conn, name):
    return bool(conn.execute("SELECT name FROM sqlite_master WHERE name=?", (name,)).fetchone())


def main(argv):
    dry = "--dry-run" in argv
    if not os.path.exists(DB):
        print("数据库不存在：", DB)
        return 1
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    file_ids = [
        r["id"]
        for r in conn.execute("SELECT id, path FROM source_files WHERE path LIKE ?", ("%样本%",))
    ]
    stats = {
        "source_files": len(file_ids),
        "ship_lines": 0,
        "tms_status": 0,
        "wave_registry": 0,
        "snapshots": 0,
    }
    if file_ids:
        marks = ",".join("?" * len(file_ids))
        stats["ship_lines"] = conn.execute(
            "SELECT COUNT(*) FROM ship_lines WHERE src_file_id IN (%s)" % marks, file_ids
        ).fetchone()[0]
        stats["tms_status"] = conn.execute(
            "SELECT COUNT(*) FROM tms_status WHERE src_file_id IN (%s)" % marks, file_ids
        ).fetchone()[0]
    for date in SAMPLE_DATES:
        stats["wave_registry"] += conn.execute(
            "SELECT COUNT(*) FROM wave_registry WHERE biz_date=?", (date,)
        ).fetchone()[0]
        stats["snapshots"] += conn.execute(
            "SELECT COUNT(*) FROM daily_snapshot WHERE biz_date=?", (date,)
        ).fetchone()[0]

    print("将清理：")
    for key, value in stats.items():
        print("  %-14s %d" % (key, value))
    if dry:
        print("（dry-run，未做任何修改）")
        return 0

    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup = os.path.join(
        BACKUP_DIR, "pre_purge_%s.db" % datetime.now().strftime("%Y%m%d_%H%M%S")
    )
    shutil.copy2(DB, backup)
    print("已备份到：", backup)

    with conn:
        if file_ids:
            marks = ",".join("?" * len(file_ids))
            conn.execute("DELETE FROM ship_lines WHERE src_file_id IN (%s)" % marks, file_ids)
            conn.execute("DELETE FROM tms_status WHERE src_file_id IN (%s)" % marks, file_ids)
            conn.execute("DELETE FROM source_files WHERE id IN (%s)" % marks, file_ids)
        for date in SAMPLE_DATES:
            conn.execute("DELETE FROM wave_registry WHERE biz_date=?", (date,))
            conn.execute("DELETE FROM daily_snapshot WHERE biz_date=?", (date,))
            if table_exists(conn, "daily_archive"):
                conn.execute("DELETE FROM daily_archive WHERE biz_date=?", (date,))
            if table_exists(conn, "order_overrides"):
                conn.execute("DELETE FROM order_overrides WHERE biz_date=?", (date,))

    print("清理完成。剩余：")
    print("  ship_lines   ", conn.execute("SELECT COUNT(*) FROM ship_lines").fetchone()[0])
    print("  tms_status   ", conn.execute("SELECT COUNT(*) FROM tms_status").fetchone()[0])
    print("  source_files ", conn.execute("SELECT COUNT(*) FROM source_files").fetchone()[0])
    dates = [
        (r[0], r[1])
        for r in conn.execute(
            "SELECT order_date, COUNT(*) FROM ship_lines WHERE order_date IS NOT NULL "
            "GROUP BY order_date ORDER BY order_date"
        )
    ]
    print("  日期范围     ", dates[:1], "...", dates[-1:] if dates else [])

    try:
        sys.path.insert(0, BASE)
        import db as dbmod
        import rules

        conn.row_factory = sqlite3.Row
        rules.rebuild_snapshots(conn)
        dbmod.set_meta(conn, "data_version", int(dbmod.get_meta(conn, "data_version", "1") or 1) + 1)
        print("  已重建每日快照并提升数据版本")
    except Exception as exc:  # noqa: BLE001
        print("  快照重建失败（可稍后在页面点扫描）：", exc)
    conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
