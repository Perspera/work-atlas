# -*- coding: utf-8 -*-
"""自动归档单元测试：在数据库副本上验证「扫描变更 → 覆盖受影响日期」。

不连线上库、不改真实数据。

用法：
    python tools/tests/test_archive_refresh.py
"""
import os
import shutil
import sqlite3
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)

import archive_refresh  # noqa: E402
import db  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + str(detail)) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def open_temp_db():
    src = os.path.join(BASE, "data", "dashboard.db")
    tmp = tempfile.mkdtemp(prefix="archive_test_")
    dst = os.path.join(tmp, "dashboard.db")
    shutil.copy2(src, dst)
    # WAL 边车文件一并复制，保证副本完整
    for suffix in ("-wal", "-shm"):
        if os.path.exists(src + suffix):
            shutil.copy2(src + suffix, dst + suffix)
    conn = sqlite3.connect(dst, timeout=30, isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn, tmp


def main():
    conn, tmp = open_temp_db()
    print("测试库：", tmp)
    try:
        dates = [
            r["biz_date"]
            for r in conn.execute(
                "SELECT biz_date FROM wave_registry WHERE deleted_at IS NULL "
                "GROUP BY biz_date ORDER BY biz_date DESC LIMIT 2"
            )
        ]
        if len(dates) < 2:
            print("没有足够的已登记业务日，跳过（需要至少 2 天登记记录）")
            return 0
        target, other = dates[0], dates[1]

        def archived_at(day):
            row = conn.execute(
                "SELECT MAX(archived_at) AS t FROM daily_archive WHERE biz_date=?", (day,)
            ).fetchone()
            return row["t"] if row and row["t"] else None

        # 确保两个日期都有归档，便于观察是否被覆盖
        for day in (target, other):
            conn.execute("DELETE FROM daily_archive WHERE biz_date=?", (day,))
        import archive

        archive.snapshot(conn, target, None, force=True)
        archive.snapshot(conn, other, None, force=True)
        # 故意把两份归档时间改成旧值，便于判断哪一天被覆盖
        for day in (target, other):
            conn.execute(
                "UPDATE daily_archive SET archived_at='2000-01-01 00:00:00' WHERE biz_date=?", (day,)
            )
        before_target = archived_at(target)
        before_other = archived_at(other)

        # 1) 空报告：不该改任何归档
        archive_refresh.refresh(conn, {"added_rows": 0, "changed_rows": 0})
        check("无变更时归档不变", archived_at(target) == before_target and archived_at(other) == before_other,
              "%s / %s" % (archived_at(target), archived_at(other)))

        # 2) 受影响波浪号 → 只覆盖该业务日
        wave = conn.execute(
            "SELECT wave_no FROM wave_registry WHERE biz_date=? AND deleted_at IS NULL LIMIT 1",
            (target,),
        ).fetchone()
        report = {
            "added_rows": 1,
            "changed_rows": 0,
            "affected_waves": [wave["wave_no"]] if wave else [],
            "affected_pick_dates": [],
            "affected_check_dates": [],
        }
        archive_refresh.refresh(conn, report)
        check("受影响业务日被覆盖", archived_at(target) != before_target, str(archived_at(target)))
        check("其它业务日保持不动", archived_at(other) == before_other, str(archived_at(other)))

        # 3) 人效归档：受影响作业日期覆盖
        pick_day = conn.execute(
            "SELECT substr(pick_time,1,10) AS d FROM ship_lines WHERE pick_time<>'' "
            "AND pick_person IS NOT NULL AND pick_person<>'' GROUP BY d ORDER BY COUNT(*) DESC LIMIT 1"
        ).fetchone()
        if pick_day and pick_day["d"]:
            day = pick_day["d"]
            conn.execute("DELETE FROM labor_archive WHERE biz_date=?", (day,))
            import labor_archive

            labor_archive.snapshot(conn, day, None, force=True)
            conn.execute(
                "UPDATE labor_archive SET archived_at='2000-01-01 00:00:00' WHERE biz_date=?", (day,)
            )
            before_labor = conn.execute(
                "SELECT MAX(archived_at) AS t FROM labor_archive WHERE biz_date=?", (day,)
            ).fetchone()["t"]
            archive_refresh.refresh(conn, {"added_rows": 1, "changed_rows": 0,
                                           "affected_waves": [], "affected_pick_dates": [day]})
            after_labor = conn.execute(
                "SELECT MAX(archived_at) AS t FROM labor_archive WHERE biz_date=?", (day,)
            ).fetchone()["t"]
            check("人效归档按作业日期覆盖", after_labor != before_labor, "%s -> %s" % (before_labor, after_labor))
        else:
            check("人效归档按作业日期覆盖", True, "该库没有人员作业数据，跳过")

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
