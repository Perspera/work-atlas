# -*- coding: utf-8 -*-
"""内置看板模板（系统首次启动为管理员种下公共默认看板）。

布局是 12 列栅格：x 为列（0-11），y 为行（每行 60px），w/h 为跨格数。
KPI 卡固定 3 行高，图表 5 行高，表格按内容给 5-8 行。
"""
import zlib

# 单系列柱状/折线图的默认取色：避免所有图表都落在第一种深蓝上，视觉过于单调。
CHART_PALETTE = ["#2ec4b6", "#e0b100", "#8e44ad", "#ff5d8f", "#ff9f1c", "#0e7490"]


def chart_color(widget_id):
    """按组件 id 稳定取色：同一个图表在各环境、各布局里颜色保持一致。"""
    return CHART_PALETTE[zlib.crc32(str(widget_id).encode("utf-8")) % len(CHART_PALETTE)]


def _w(wid, wtype, title, spec, x, y, w, h):
    # 单系列图表默认给一个固定颜色；多系列仍走前端默认多色盘。
    if wtype in ("bar", "line") and len(spec.get("metrics") or []) == 1:
        spec.setdefault("color", chart_color(wid))
    return {
        "id": wid,
        "type": wtype,
        "title": title,
        "spec": spec,
        "x": x,
        "y": y,
        "w": w,
        "h": h,
    }


OVERVIEW = {
    "name": "今日总览",
    "is_default": 1,
    "widgets": [
        _w("ov-groups", "kpi", "拣货完成率", {"dataset": "orders", "metrics": ["picked_rate"]}, 0, 0, 2, 3),
        _w("ov-lines", "kpi", "发运行数", {"dataset": "orders", "metrics": ["rows"]}, 2, 0, 2, 3),
        _w("ov-amount", "kpi", "单量金额", {"dataset": "orders", "metrics": ["amount"]}, 4, 0, 2, 3),
        _w("ov-waves", "kpi", "登记波次行数", {"dataset": "waves", "metrics": ["rows"]}, 6, 0, 2, 3),
        _w("ov-out", "kpi", "出库完成率", {"dataset": "orders", "metrics": ["out_rate"]}, 8, 0, 2, 3),
        _w("ov-tms", "kpi", "运输单释放率", {"dataset": "waves", "metrics": ["tms_rate"]}, 10, 0, 2, 3),
        _w(
            "ov-funnel",
            "funnel",
            "作业进度漏斗",
            {"dataset": "orders", "dimension": None, "metrics": ["rows"]},
            0, 3, 6, 5,
        ),
        _w(
            "ov-hourly",
            "line",
            "每小时拣货 / 出库",
            {"dataset": "lines", "dimension": "hour", "metrics": ["rows"], "limit": 24},
            6, 3, 6, 5,
        ),
        _w(
            "ov-status",
            "pie",
            "发运状态分布",
            {"dataset": "lines", "dimension": "status", "metrics": ["rows"], "limit": 8},
            0, 8, 4, 5,
        ),
        _w(
            "ov-routes",
            "bar",
            "线路单量排行",
            {"dataset": "orders", "dimension": "route", "metrics": ["rows"], "limit": 10},
            4, 8, 5, 5,
        ),
        _w(
            "ov-zones",
            "bar",
            "库区分布",
            {"dataset": "orders", "dimension": "zone", "metrics": ["rows"], "limit": 8},
            9, 8, 3, 5,
        ),
    ],
}

PROGRESS = {
    "name": "作业进度",
    "is_default": 0,
    "widgets": [
        _w("pr-out", "kpi", "已出库行数", {"dataset": "orders", "metrics": ["out"]}, 0, 0, 3, 3),
        _w("pr-picked", "kpi", "已拣货行数", {"dataset": "orders", "metrics": ["picked"]}, 3, 0, 3, 3),
        _w("pr-pending", "kpi", "未出库行数", {"dataset": "orders", "metrics": ["pending"]}, 6, 0, 3, 3),
        _w("pr-rate", "kpi", "出库完成率", {"dataset": "orders", "metrics": ["out_rate"]}, 9, 0, 3, 3),
        _w(
            "pr-waves",
            "table",
            "波次进度",
            {"dataset": "waves", "dimension": "wave", "metrics": ["rows", "picked", "checked", "out_rate"],
             "limit": 60, "sort": {"by": "label", "dir": "asc"}},
            0, 3, 7, 8,
        ),
        _w("pr-alerts", "alert", "超时未出库", {"dataset": "alerts"}, 7, 3, 5, 8),
        _w(
            "pr-routes",
            "progress",
            "线路完成率",
            {"dataset": "orders", "dimension": "route", "metrics": ["out_rate", "rows"], "limit": 12},
            0, 11, 5, 5,
        ),
        _w(
            "pr-tms",
            "bar",
            "运输单承运商",
            {"dataset": "waves", "dimension": "carrier_tms", "metrics": ["rows"], "limit": 8},
            5, 11, 7, 5,
        ),
    ],
}

VOLUME = {
    "name": "单量分析",
    "is_default": 0,
    "widgets": [
        _w(
            "vo-route",
            "bar",
            "线路行数",
            {"dataset": "orders", "dimension": "route", "metrics": ["rows"], "limit": 12},
            0, 0, 6, 5,
        ),
        _w(
            "vo-zone",
            "pie",
            "库区占比",
            {"dataset": "orders", "dimension": "zone", "metrics": ["rows"], "limit": 8},
            6, 0, 3, 5,
        ),
        _w(
            "vo-region",
            "bar",
            "区域单量",
            {"dataset": "orders", "dimension": "region", "metrics": ["rows"], "limit": 10},
            9, 0, 3, 5,
        ),
        _w(
            "vo-doc",
            "table",
            "单据类型",
            {"dataset": "orders", "dimension": "doc_type", "metrics": ["rows", "amount"], "limit": 10},
            0, 5, 6, 5,
        ),
        _w(
            "vo-dealer",
            "table",
            "经销商 Top20",
            {"dataset": "orders", "dimension": "dealer", "metrics": ["rows", "amount"], "limit": 20},
            6, 5, 6, 6,
        ),
    ],
}

TREND = {
    "name": "趋势",
    "is_default": 0,
    "widgets": [
        _w(
            "tr-lines",
            "line",
            "每日行数",
            {"dataset": "trend", "metrics": ["rows"], "limit": 30},
            0, 0, 6, 5,
        ),
        _w(
            "tr-amount",
            "line",
            "每日金额(万元)",
            {"dataset": "trend", "metrics": ["amount"], "limit": 30},
            6, 0, 6, 5,
        ),
        _w(
            "tr-rate",
            "line",
            "每日出库完成率",
            {"dataset": "trend", "metrics": ["out_rate"], "limit": 30},
            0, 5, 6, 5,
        ),
        _w(
            "tr-groups",
            "line",
            "每日发运完成率",
            {"dataset": "trend", "metrics": ["ship_rate"], "limit": 30},
            6, 5, 6, 5,
        ),
    ],
}

TEMPLATES = [OVERVIEW, PROGRESS, VOLUME, TREND]


# ============================================================
# 导航页默认看板（v5）：每个分析页都变成可编辑看板
# page_key -> layout
# ============================================================
PAGE_OVERVIEW = [
    # 今日订单量 / 登记覆盖（金额 + 行数，全部按行统计）
    _w("pg-ov-all", "kpi", "今日订单量(行)", {"dataset": "coverage", "metrics": ["rows"], "compare": True}, 0, 0, 2, 3),
    _w("pg-ov-amount", "kpi", "今日订单金额", {"dataset": "coverage", "metrics": ["amount"], "compare": True}, 2, 0, 2, 3),
    _w("pg-ov-reg-lines", "kpi", "已组波行数", {"dataset": "coverage", "metrics": ["registered_lines"], "compare": True}, 4, 0, 2, 3),
    _w("pg-ov-reg-amount", "kpi", "已组波金额", {"dataset": "coverage", "metrics": ["registered_amount"], "compare": True}, 6, 0, 2, 3),
    _w("pg-ov-unreg-lines", "kpi", "待组波行数", {"dataset": "coverage", "metrics": ["unregistered_lines"]}, 8, 0, 2, 3),
    _w("pg-ov-unreg-amount", "kpi", "待组波金额", {"dataset": "coverage", "metrics": ["unregistered_amount"]}, 10, 0, 2, 3),
    # 作业进度
    _w("pg-ov-picked", "kpi", "已拣货行数", {"dataset": "orders", "metrics": ["picked"], "compare": True}, 0, 3, 2, 3),
    _w("pg-ov-unpicked", "kpi", "未拣货行数", {"dataset": "orders", "metrics": ["unpicked"], "compare": True}, 2, 3, 2, 3),
    _w("pg-ov-pick-rate", "kpi", "拣货完成率", {"dataset": "orders", "metrics": ["picked_rate"]}, 4, 3, 2, 3),
    _w("pg-ov-checked", "kpi", "已复核行数", {"dataset": "orders", "metrics": ["checked"], "compare": True}, 6, 3, 2, 3),
    _w("pg-ov-check-rate", "kpi", "复核完成率", {"dataset": "orders", "metrics": ["checked_rate"]}, 8, 3, 2, 3),
    _w("pg-ov-out-rate", "kpi", "出库完成率", {"dataset": "orders", "metrics": ["out_rate"]}, 10, 3, 2, 3),
    _w("pg-ov-out", "kpi", "已出库行数", {"dataset": "orders", "metrics": ["out"]}, 0, 6, 2, 3),
    _w("pg-ov-cover-rate", "kpi", "登记覆盖率", {"dataset": "coverage", "metrics": ["coverage_rate"]}, 2, 6, 2, 3),
    _w("pg-ov-percap", "kpi", "人均每小时拣货行数", {"dataset": "labor", "metrics": ["pick_rate"]}, 4, 6, 2, 3),
    _w("pg-ov-erp-failed", "kpi", "回传失败行数", {"dataset": "lines", "metrics": ["erp_failed_lines"]}, 6, 6, 2, 3),
    _w("pg-ov-erp-missing", "kpi", "未回传行数", {"dataset": "lines", "metrics": ["erp_missing_lines"]}, 8, 6, 2, 3),
    _w("pg-ov-funnel", "funnel", "作业进度漏斗", {}, 0, 9, 6, 5),
    _w("pg-ov-hourly", "line", "每小时拣货 / 复核", {"dataset": "lines", "dimension": "hour", "metrics": ["picked", "checked"], "limit": 24}, 6, 9, 6, 5),
    _w("pg-ov-status", "pie", "发运状态分布", {"dataset": "lines", "dimension": "status", "metrics": ["rows"], "limit": 8}, 0, 14, 4, 5),
    _w("pg-ov-routes", "bar", "线路行数排行", {"dataset": "orders", "dimension": "route", "metrics": ["rows"], "limit": 10}, 4, 14, 5, 5),
    _w("pg-ov-zones", "bar", "库区分布", {"dataset": "orders", "dimension": "zone", "metrics": ["rows"], "limit": 8}, 9, 14, 3, 5),
    _w("pg-ov-cycle", "table", "线路时效(h)", {"dataset": "orders", "dimension": "route", "metrics": ["rows", "cycle_avg", "cycle_max", "checked_rate"], "limit": 12}, 0, 19, 12, 6),
    _w("pg-ov-erp", "bar", "ERP 回传状态（行数/金额）",
       {"dataset": "lines", "dimension": "erp_status", "metrics": ["rows", "amount"], "limit": 8}, 0, 25, 6, 5),
    _w("pg-ov-erp-rate", "table", "ERP 回传状态汇总",
       {"dataset": "lines", "dimension": "erp_status", "metrics": ["rows", "amount", "erp_failed_lines"],
        "limit": 8}, 6, 25, 6, 5),
    _w("pg-ov-battery", "table", "今日动力电池登记",
       {"dataset": "battery", "limit": 200}, 0, 30, 12, 7),
]

PAGE_PROGRESS = [
    _w("pg-pr-picked", "kpi", "已拣货行数", {"dataset": "orders", "metrics": ["picked"]}, 0, 0, 2, 3),
    _w("pg-pr-unpicked", "kpi", "未拣货行数", {"dataset": "orders", "metrics": ["unpicked"]}, 2, 0, 2, 3),
    _w("pg-pr-pick-rate", "kpi", "拣货完成率", {"dataset": "orders", "metrics": ["picked_rate"]}, 4, 0, 2, 3),
    _w("pg-pr-checked", "kpi", "已复核行数", {"dataset": "orders", "metrics": ["checked"]}, 6, 0, 2, 3),
    _w("pg-pr-unchecked", "kpi", "未复核行数", {"dataset": "orders", "metrics": ["unchecked"]}, 8, 0, 2, 3),
    _w("pg-pr-check-rate", "kpi", "复核完成率", {"dataset": "orders", "metrics": ["checked_rate"]}, 10, 0, 2, 3),
    _w("pg-pr-out", "kpi", "已出库行数", {"dataset": "orders", "metrics": ["out"]}, 0, 3, 2, 3),
    _w("pg-pr-out-rate", "kpi", "出库完成率", {"dataset": "orders", "metrics": ["out_rate"]}, 2, 3, 2, 3),
    _w("pg-pr-cycle", "kpi", "全链路 平均(h)", {"dataset": "orders", "metrics": ["cycle_avg"]}, 4, 3, 2, 3),
    _w("pg-pr-cyclemax", "kpi", "全链路 最长(h)", {"dataset": "orders", "metrics": ["cycle_max"]}, 6, 3, 2, 3),
    _w("pg-pr-percap", "kpi", "人均每小时拣货行数", {"dataset": "labor", "metrics": ["pick_rate"]}, 8, 3, 2, 3),
    _w("pg-pr-waves", "table", "波次进度",
       {"dataset": "waves", "dimension": "wave",
        "metrics": ["rows", "picked", "checked", "picked_rate", "checked_rate"],
        "limit": 60, "sort": {"by": "label", "dir": "asc"}}, 0, 6, 7, 8),
    _w("pg-pr-alerts", "alert", "超时未复核", {"dataset": "alerts"}, 7, 6, 5, 8),
    _w("pg-pr-routes", "progress", "线路复核完成率",
       {"dataset": "orders", "dimension": "route", "metrics": ["checked_rate", "rows"], "limit": 12}, 0, 14, 5, 5),
    _w("pg-pr-tms", "bar", "运输单承运商",
       {"dataset": "waves", "dimension": "carrier_tms", "metrics": ["rows"], "limit": 8}, 5, 14, 7, 5),
    _w("pg-pr-erp", "bar", "ERP 回传状态（行数/金额）",
       {"dataset": "lines", "dimension": "erp_status", "metrics": ["rows", "amount"], "limit": 8}, 0, 19, 6, 5),
    _w("pg-pr-erp-failed", "table", "回传失败明细（订单组）",
       {"dataset": "erp_detail", "filter": {"erp_status": "failed"}, "limit": 200}, 6, 19, 6, 8),
    _w("pg-pr-erp-missing", "table", "未回传明细（订单组）",
       {"dataset": "erp_detail", "filter": {"erp_status": "missing"}, "limit": 200}, 0, 27, 12, 8),
]

PAGE_VOLUME = [
    _w("pg-vo-route", "bar", "线路行数", {"dataset": "orders", "dimension": "route", "metrics": ["rows"], "limit": 12}, 0, 0, 6, 5),
    _w("pg-vo-zone", "pie", "库区占比", {"dataset": "orders", "dimension": "zone", "metrics": ["rows"], "limit": 8}, 6, 0, 3, 5),
    _w("pg-vo-region", "bar", "区域单量", {"dataset": "orders", "dimension": "region", "metrics": ["rows"], "limit": 10}, 9, 0, 3, 5),
    _w("pg-vo-doc", "table", "单据类型", {"dataset": "orders", "dimension": "doc_type", "metrics": ["rows", "amount"], "limit": 10}, 0, 5, 5, 6),
    _w("pg-vo-dealer", "table", "经销商 Top20", {"dataset": "orders", "dimension": "dealer", "metrics": ["rows", "amount"], "limit": 20}, 5, 5, 7, 8),
]

PAGE_LABOR = [
    _w("pg-lb-pick-people", "kpi", "拣货人数", {"dataset": "labor", "metrics": ["pick_people"]}, 0, 0, 2, 3),
    _w("pg-lb-pick-rows", "kpi", "拣货行数", {"dataset": "labor", "metrics": ["pick_rows"]}, 2, 0, 2, 3),
    _w("pg-lb-pick-rate", "kpi", "拣货人效(行/小时)", {"dataset": "labor", "metrics": ["pick_rate"]}, 4, 0, 2, 3),
    _w("pg-lb-check-people", "kpi", "复核人数", {"dataset": "labor", "metrics": ["check_people"]}, 6, 0, 2, 3),
    _w("pg-lb-check-rows", "kpi", "复核行数", {"dataset": "labor", "metrics": ["check_rows"]}, 8, 0, 2, 3),
    _w("pg-lb-check-rate", "kpi", "复核人效(行/小时)", {"dataset": "labor", "metrics": ["check_rate"]}, 10, 0, 2, 3),
    _w("pg-lb-pick", "bar", "拣货人作业量（行）",
       {"dataset": "labor", "dimension": "person", "metrics": ["pick_rows"], "limit": 15}, 0, 3, 6, 6),
    _w("pg-lb-check", "bar", "复核人作业量（行）",
       {"dataset": "labor", "dimension": "person", "metrics": ["check_rows"], "limit": 15}, 6, 3, 6, 6),
    _w("pg-lb-hour", "line", "每小时拣货 / 复核行数",
       {"dataset": "labor_hour", "dimension": "hour", "metrics": ["pick_rows", "check_rows"], "limit": 24}, 0, 9, 12, 5),
    _w("pg-lb-table", "table", "人员明细（拣货 / 复核分开）",
       {"dataset": "labor", "dimension": "person",
        "metrics": ["pick_rows", "pick_hours", "pick_rate", "check_rows", "check_hours", "check_rate"],
        "limit": 100}, 0, 14, 12, 8),
]

PAGE_TREND = [
    _w("pg-tr-rows", "line", "每日行数", {"dataset": "trend", "metrics": ["rows"], "limit": 30}, 0, 0, 6, 5),
    _w("pg-tr-amount", "line", "每日金额(万元)", {"dataset": "trend", "metrics": ["amount"], "limit": 30}, 6, 0, 6, 5),
    _w("pg-tr-check", "line", "每日复核完成率", {"dataset": "trend", "metrics": ["out_rate"], "limit": 30}, 0, 5, 6, 5),
    _w("pg-tr-groups", "line", "每日发运完成率", {"dataset": "trend", "metrics": ["ship_rate"], "limit": 30}, 6, 5, 6, 5),
]

PAGE_TEMPLATES = [
    {"key": "overview", "name": "今日总览", "widgets": PAGE_OVERVIEW},
    {"key": "labor", "name": "人工作业量", "widgets": PAGE_LABOR},
]
