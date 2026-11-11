# -*- coding: utf-8 -*-
"""扫描文件归档单元测试：数据库副本 + 临时 CSV，不碰线上数据。

用法：
    python tools/tests/test_source_archive.py
"""
import os
import shutil
import sqlite3
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)

from backend.collect import ingest  # noqa: E402
from backend.archives import source_archive  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + str(detail)) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def open_temp_db():
    src = os.path.join(BASE, "data", "dashboard.db")
    tmp = tempfile.mkdtemp(prefix="src_archive_test_")
    dst = os.path.join(tmp, "dashboard.db")
    shutil.copy2(src, dst)
    for suffix in ("-wal", "-shm"):
        if os.path.exists(src + suffix):
            shutil.copy2(src + suffix, dst + suffix)
    conn = sqlite3.connect(dst, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    cols = {r["name"] for r in conn.execute("PRAGMA table_info(source_archive)")}
    if "stored_bytes" not in cols:
        conn.execute("ALTER TABLE source_archive ADD COLUMN stored_bytes INTEGER DEFAULT 0")
    # 归档目录也指向临时目录，避免写进真实 data/
    source_archive.DATA_DIR = tmp
    source_archive.ARCHIVE_DIR = os.path.join(tmp, "source_archive")
    return conn, tmp


def write_csv(path, rows):
    with open(path, "w", encoding="utf-8", newline="") as fh:
        for row in rows:
            fh.write(",".join(row) + "\n")


def main():
    conn, tmp = open_temp_db()
    print("测试目录：", tmp)
    csv_path = os.path.join(tmp, "发运表测试.csv")
    try:
        rows1 = [
            ["订单日期", "波次号", "订单组号", "交货地", "金额"],
            ["2026-11-05", "W1", "G1", "测试经销商A", "100"],
            ["2026-11-05", "W1", "G2", "测试经销商B", "200"],
        ]
        write_csv(csv_path, rows1)
        sheets = ingest.read_any(csv_path)

        info = source_archive.archive(conn, csv_path, "ship", sheets, order_dates=["2026-11-05"])
        row = conn.execute("SELECT * FROM source_archive WHERE path=?", (csv_path,)).fetchone()
        check("首次归档写入记录", info.get("archived") and row is not None, str(info))
        check("归档行数 = 数据行", row["rows"] == 2, row["rows"] if row else None)
        check("不保存原文件副本", bool(row) and not row["file_path"], row["file_path"] if row else None)
        check("不生成 files/ 目录", not os.path.isdir(os.path.join(source_archive.ARCHIVE_DIR, "files")))
        check("快照大小已记录", bool(row) and int(row["stored_bytes"] or 0) > 0, row["stored_bytes"] if row else None)
        check("行快照存在", bool(row and row["rows_path"] and os.path.isfile(source_archive._abs(row["rows_path"]))))

        preview = source_archive.preview(conn, row["id"], limit=10)
        check("预览含表头与数据", bool(preview and preview["sheets"] and
                                     preview["sheets"][0]["headers"][:2] == ["订单日期", "波次号"] and
                                     len(preview["sheets"][0]["rows"]) == 2),
              str(preview)[:120])
        csv_bytes = source_archive.export_csv(conn, row["id"])
        check("导出 CSV 含数据", csv_bytes is not None and "测试经销商A" in csv_bytes.decode("utf-8-sig"),
              (csv_bytes or b"")[:60])
        check("不再提供下载原文件", not hasattr(source_archive, "download_path"))

        old_rows = row["rows_path"]
        old_sha = row["sha256"]

        # 内容不变：跳过
        info2 = source_archive.archive(conn, csv_path, "ship", ingest.read_any(csv_path), order_dates=["2026-11-05"])
        count_same = conn.execute(
            "SELECT COUNT(*) AS c FROM source_archive WHERE path=?", (csv_path,)
        ).fetchone()["c"]
        check("内容不变不重复归档", info2.get("skipped") is True and count_same == 1, str(info2))

        # 内容变化：只留最新一版
        rows2 = rows1 + [["2026-11-05", "W1", "G3", "测试经销商C", "300"]]
        write_csv(csv_path, rows2)
        info3 = source_archive.archive(conn, csv_path, "ship", ingest.read_any(csv_path), order_dates=["2026-11-05"])
        row3 = conn.execute("SELECT * FROM source_archive WHERE path=?", (csv_path,)).fetchone()
        count_after = conn.execute(
            "SELECT COUNT(*) AS c FROM source_archive WHERE path=?", (csv_path,)
        ).fetchone()["c"]
        check("内容变化后仍只有 1 条", row3 is not None and count_after == 1, str(count_after))
        check("最新版本行数更新", row3["rows"] == 3, row3["rows"] if row3 else None)
        check("sha256 已变化", row3["sha256"] != old_sha)
        check("旧版本快照已删除", not os.path.isfile(source_archive._abs(old_rows)))

        # 历史迁移：带 file_path 的旧记录 → 删除文件副本、置空、回填 stored_bytes
        legacy_file = os.path.join(tmp, "legacy_copy.xlsx")
        with open(legacy_file, "wb") as fh:
            fh.write(b"legacy")
        source_archive.ARCHIVE_DIR = os.path.join(tmp, "source_archive")
        os.makedirs(os.path.join(source_archive.ARCHIVE_DIR, "files", "20260101"), exist_ok=True)
        conn.execute(
            "UPDATE source_archive SET file_path=?, stored_bytes=0 WHERE path=?",
            ("source_archive/files/20260101/legacy.xlsx", csv_path),
        )
        # 线上库可能已标记迁移完成，测试里先清标记再验证迁移逻辑
        conn.execute("DELETE FROM meta WHERE key='source_archive_storage_v1'")
        result = source_archive.migrate_storage(conn)
        migrated = conn.execute("SELECT file_path, stored_bytes FROM source_archive WHERE path=?", (csv_path,)).fetchone()
        check("历史迁移删除原文件副本", result.get("removed_files_dir") is True, str(result))
        check("迁移后 file_path 置空且回填大小",
              migrated["file_path"] is None and int(migrated["stored_bytes"] or 0) > 0, dict(migrated))

        # 7 天清理：把扫描时间改成过期
        conn.execute("UPDATE source_archive SET scan_at='2000-01-01 00:00:00' WHERE path=?", (csv_path,))
        result = source_archive.cleanup(conn, keep_days=7)
        left = conn.execute(
            "SELECT COUNT(*) AS c FROM source_archive WHERE path=?", (csv_path,)
        ).fetchone()["c"]
        check("过期归档被清理", result["removed"] >= 1 and left == 0, str(result))
        check("过期文件已删除", not os.path.isfile(source_archive._abs(row3["rows_path"])))

        print("")
        if FAILS:
            print("失败 %d 项：%s" % (len(FAILS), "、".join(FAILS)))
            return 1
        print("全部通过。")
        return 0
    finally:
        conn.close()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
