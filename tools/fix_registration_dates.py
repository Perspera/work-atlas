# -*- coding: utf-8 -*-
"""把"登记日期"按波次实际发生日期校正。

背景：早期版本默认业务日取"最近一次登记日"，且日期下拉只列已登记日期，
跨天后新登记会全部落到旧日期上（例如 11-02 登记的波次记到了 10-31）。

判定依据（按优先级）：
  1. 波次生成时间 `波次号生成时间` 的最大日期（最贴近业务日）
  2. `订单日期` 的最大日期
没有数据的波次（待数据）保持原样，不改。

用法：
    python tools/fix_registration_dates.py            # 只看会怎么改（dry-run）
    python tools/fix_registration_dates.py --apply    # 真正执行（会先备份并重建快照）
"""
import os
import shutil
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(BASE, "data", "dashboard.db")
BACKUP_DIR = os.path.join(BASE, "data", "backup")


def wave_date(conn, wave_no):
    row = conn.execute(
        "SELECT MAX(substr(wave_time,1,10)) AS wt, MAX(order_date) AS mx, "
        "MIN(order_date) AS mn, COUNT(*) AS n FROM ship_lines WHERE wave_no=?",
        (wave_no,),
    ).fetchone()
    if not row or not row["n"]:
        return None, row
    return (row["wt"] or row["mx"]), row


def main(argv):
    apply_changes = "--apply" in argv
    if not os.path.exists(DB):
        print("数据库不存在：", DB)
        return 1
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    rows = conn.execute(
        "SELECT id, biz_date, wave_no, created_at FROM wave_registry "
        "WHERE deleted_at IS NULL ORDER BY id"
    ).fetchall()

    plan = []
    skipped_pending = 0
    conflicts = []
    by_target = defaultdict(int)
    for row in rows:
        target, info = wave_date(conn, row["wave_no"])
        if not target:
            skipped_pending += 1
            continue
        if target == row["biz_date"]:
            continue
        other = conn.execute(
            "SELECT id FROM wave_registry WHERE biz_date=? AND wave_no=? AND deleted_at IS NULL AND id<>?",
            (target, row["wave_no"], row["id"]),
        ).fetchone()
        if other:
            conflicts.append((row["wave_no"], row["biz_date"], target))
            continue
        plan.append(
            {
                "id": row["id"],
                "wave_no": row["wave_no"],
                "from": row["biz_date"],
                "to": target,
                "data_min": info["mn"],
                "data_max": info["mx"],
                "wave_time_date": info["wt"],
                "lines": info["n"],
            }
        )
        by_target[(row["biz_date"], target)] += 1

    print("待校正登记：%d 条（待数据跳过 %d 条，冲突跳过 %d 条）"
          % (len(plan), skipped_pending, len(conflicts)))
    if by_target:
        print("按 旧日期 -> 新日期 汇总：")
        for (old, new), count in sorted(by_target.items()):
            print("  %s -> %s : %d 个波次" % (old, new, count))
    if plan:
        print("明细（前 30 条）：")
        for item in plan[:30]:
            print("  #%d %s  %s -> %s  (订单日期 %s~%s，波次生成 %s)"
                  % (item["id"], item["wave_no"], item["from"], item["to"],
                     item["data_min"], item["data_max"], item["wave_time_date"]))
    for wave, old, new in conflicts:
        print("  ! 冲突跳过 %s：%s 已存在，无法从 %s 移入" % (wave, new, old))

    if not plan:
        print("没有需要校正的登记。")
        return 0
    if not apply_changes:
        print("\n（dry-run，未做修改；加 --apply 执行）")
        return 0

    os.makedirs(BACKUP_DIR, exist_ok=True)
    backup = os.path.join(
        BACKUP_DIR, "pre_fixdate_%s.db" % datetime.now().strftime("%Y%m%d_%H%M%S")
    )
    shutil.copy2(DB, backup)
    print("\n已备份：", backup)

    now = db_now()
    affected = set()
    with conn:
        for item in plan:
            conn.execute(
                "UPDATE wave_registry SET biz_date=?, updated_at=? WHERE id=?",
                (item["to"], now, item["id"]),
            )
            affected.add(item["from"])
            affected.add(item["to"])
        # 旧日期的存档已过期，删掉让自动补档按新登记重建
        for day in affected:
            conn.execute("DELETE FROM daily_archive WHERE biz_date=?", (day,))

    print("已移动 %d 条登记；受影响日期：%s" % (len(plan), "、".join(sorted(affected))))

    sys.path.insert(0, BASE)
    import db as dbmod
    import rules

    rules.rebuild_snapshots(conn)
    dbmod.bump_version(conn)
    try:
        import archive

        done = archive.auto_archive(conn)
        if done:
            print("已重新生成历史存档：", "、".join(done))
    except Exception as exc:  # noqa: BLE001
        print("自动补档失败（可在页面手动存档）：", exc)
    print("完成。")
    conn.close()
    return 0


def db_now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
