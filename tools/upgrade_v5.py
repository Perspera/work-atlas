# -*- coding: utf-8 -*-
"""v5 升级脚本：人员列、页面看板、预警配置、大屏配置。

可重复执行（幂等）。执行前自动备份数据库。

用法：
    python tools/upgrade_v5.py
"""
import os
import shutil
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)


def main():
    import db
    import alerts
    import templates

    db_path = os.path.join(BASE, "data", "dashboard.db")
    if not os.path.exists(db_path):
        print("数据库不存在，请先启动一次服务：", db_path)
        return 1

    backup_dir = os.path.join(BASE, "data", "backup")
    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(
        backup_dir, "pre_upgrade_v5_%s.db" % datetime.now().strftime("%Y%m%d_%H%M%S")
    )
    shutil.copy2(db_path, backup)
    print("已备份：", backup)

    conn = db.init_db()
    print("表结构已升级（人员列 / 页面槽位 / 预警 / 工时校正）")

    # 页面默认看板
    import server

    server.ensure_page_dashboards(conn)
    rows = conn.execute(
        "SELECT page_key, name, version FROM dashboards WHERE page_key IS NOT NULL "
        "AND owner_user_id IS NULL ORDER BY page_key"
    ).fetchall()
    print("页面默认看板：", [(r["page_key"], r["name"], "v%d" % r["version"]) for r in rows])

    # 线路默认截止时间（上午 12:00 / 下午 17:00 / 其他 16:00）
    routes = [r["route"] for r in conn.execute(
        "SELECT DISTINCT COALESCE(route,'未映射') AS route FROM dealer_map WHERE route IS NOT NULL"
    )]
    if alerts.ensure_settings(conn, routes):
        print("已为 %d 条线路补默认截止时间" % len(routes))
    else:
        print("线路截止时间已存在，未改动")

    # 大屏默认配置
    if not db.get_meta(conn, "screen_config"):
        db.set_meta(conn, "screen_config",
                    '{"items": ["overview", "progress", "labor", "volume", "trend"], '
                    '"interval": 15, "sound": true}')
        print("已写入大屏默认配置（轮播 5 个页面，15 秒/页）")

    print("")
    print("升级完成。启动服务后：")
    print("  1) 每个导航分析页右上角有「编辑布局」，管理员保存后可「发布为全员默认」")
    print("  2) 「预警中心」里设线路截止时间与负责人（默认上午线 12:00、下午线 17:00）")
    print("  3) 顶栏「大屏」进入轮播模式，Esc 退出")
    print("  4) 人工作业量页可对某人当天工时做人工校正")
    return 0


if __name__ == "__main__":
    sys.exit(main())
