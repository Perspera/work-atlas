# -*- coding: utf-8 -*-
"""v12 升级：修复 ERP 明细筛选丢失 + 组件配置模板库。

可重复执行（幂等）。执行前自动备份数据库。

用法：
    python tools/upgrade_v12.py
"""
import os
import shutil
import sys
from datetime import datetime

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE)


def main():
    import db
    import server
    import widgets

    db_path = os.path.join(BASE, "data", "dashboard.db")
    if not os.path.exists(db_path):
        print("数据库不存在，请先启动一次服务：", db_path)
        return 1

    backup_dir = os.path.join(BASE, "data", "backup")
    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(
        backup_dir, "pre_upgrade_v12_%s.db" % datetime.now().strftime("%Y%m%d_%H%M%S")
    )
    shutil.copy2(db_path, backup)
    print("已备份：", backup)

    conn = db.init_db()
    server.ensure_page_dashboards(conn)
    server.ensure_erp_detail_filters(conn)

    repaired = []
    for row in conn.execute("SELECT page_key, owner_user_id, layout_json FROM dashboards"):
        try:
            import json

            for widget in json.loads(row["layout_json"] or "{}").get("widgets") or []:
                spec = widget.get("spec") or {}
                if spec.get("dataset") == "erp_detail":
                    status = (spec.get("filter") or {}).get("erp_status")
                    repaired.append(
                        "%s/%s=%s" % (row["page_key"] or "专题看板", widget.get("title") or widget.get("id"), status)
                    )
        except ValueError:
            continue
    print("ERP 明细组件筛选：", "；".join(repaired) or "（尚未使用）")
    print("组件模板：%d 个；数据集配置元数据：%d 个" % (len(widgets.PRESETS), len(widgets.DATASET_UI)))
    print("")
    print("升级完成：")
    print("  1) 公共/个人进度页的「回传失败明细」「未回传明细」已修正筛选并各自取数")
    print("  2) 「添加组件」提供模板库（今日总览/作业进度/人效/ERP回传/趋势/预警）")
    print("  3) 组件配置改为：数据说明 + 默认值 + 分组/指标 + 数据集筛选 + 实时预览")
    print("  4) 编辑已有组件不再清空未知筛选（ERP明细类型不会再被重置）")
    print("")
    print("提示：浏览器请 Ctrl+F5 强制刷新一次，加载新的前端文件。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
