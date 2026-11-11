# -*- coding: utf-8 -*-
"""v7 升级：自由摆放编辑器 + 拣货指标 + 按分钟计工时（含休息时段）。

可重复执行（幂等）。执行前自动备份数据库。

用法：
    python tools/migrations/upgrade_v7.py
"""
import os
import shutil
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)


def main():
    from backend.core import db
    from backend.archives import labor_archive
    from backend.domain import rules
    from backend import server

    db_path = os.path.join(BASE, "data", "dashboard.db")
    if not os.path.exists(db_path):
        print("数据库不存在，请先启动一次服务：", db_path)
        return 1

    backup_dir = os.path.join(BASE, "data", "backup")
    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(
        backup_dir, "pre_upgrade_v7_%s.db" % datetime.now().strftime("%Y%m%d_%H%M%S")
    )
    shutil.copy2(db_path, backup)
    print("已备份：", backup)

    conn = db.init_db()
    print("表结构已升级：work_breaks（休息时段）/ meta labor_gap_minutes")

    print("间隔阈值：%d 分钟" % rules.labor_gap_minutes(conn))
    breaks = [
        dict(r)
        for r in conn.execute(
            "SELECT start_time, end_time, enabled, note FROM work_breaks ORDER BY start_time"
        )
    ]
    print("休息时段：", breaks)

    server.ensure_page_dashboards(conn)
    server.ensure_page_layouts_v7(conn)
    print("总览/进度默认布局已补「未拣货行数 / 拣货完成率 / 人均每小时拣货行数」")

    # 归档按新工时口径重算（存档是快照，必须覆盖一次）
    dates = [
        r["biz_date"]
        for r in conn.execute("SELECT DISTINCT biz_date FROM labor_archive ORDER BY biz_date")
    ]
    done = []
    for biz_date in dates:
        result = labor_archive.snapshot(conn, biz_date, None, force=True)
        if result.get("ok"):
            done.append(biz_date)
    print("人效存档已按新口径重算：", "、".join(done) if done else "（无历史存档）")

    for biz_date in (db.today_str(), "2026-11-02"):
        totals = rules.labor_stats(conn, biz_date)["totals"]
        print(
            "%s 人效：拣货 %d 行 / %.2fh → %s 行/小时；复核 %d 行 / %.2fh → %s 行/小时"
            % (
                biz_date, totals["pick_rows"], totals["pick_hours"], totals["pick_rate"],
                totals["check_rows"], totals["check_hours"], totals["check_rate"],
            )
        )
    print("")
    print("升级完成：")
    print("  1) 看板编辑器改为自由摆放：拖到哪放哪，不会自动挤动别的组件")
    print("  2) 新增「整理布局」「撤销/重做」（Ctrl+Z / Ctrl+Shift+Z）")
    print("  3) 总览/进度新增：未拣货行数、拣货完成率、人均每小时拣货行数")
    print("  4) 人效工时 = 相邻作业间隔累计（>阈值视为休息不计），并扣除休息时段")
    print("  5) 人工作业量页右上「作业设置」可改阈值与休息时段")
    return 0


if __name__ == "__main__":
    sys.exit(main())
