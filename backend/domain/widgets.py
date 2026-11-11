# -*- coding: utf-8 -*-
"""看板组件取数引擎。

前端只提交「数据集 + 维度 + 指标 + 筛选」的声明式 spec，后端用白名单映射成 SQL，
所有用户输入都走参数化，绝不拼接任意列名或表达式。
"""
import json
import threading
import time

from backend.domain import alerts
from backend.domain import battery
from backend.core import db
from backend.domain import rules

# ---------------------------------------------------------------- 结果缓存
# 键里带数据版本号：任何写操作都会自增版本，缓存立即失效；
# 30 秒 TTL 只是兜住并发写入后的短暂窗口，避免读到旧值。
_CACHE = {}
_CACHE_LOCK = threading.Lock()
_CACHE_TTL = 30.0
_CACHE_MAX = 512


def _cache_key(kind, biz_date, user_id, spec, with_amount, archive, version):
    return json.dumps(
        [kind, version, biz_date, user_id, bool(with_amount), bool(archive), spec],
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )


def _cache_get(key):
    now = time.time()
    with _CACHE_LOCK:
        item = _CACHE.get(key)
        if not item:
            return None
        ts, value = item
        if now - ts > _CACHE_TTL:
            _CACHE.pop(key, None)
            return None
        _CACHE[key] = (ts, value)
        return dict(value)


def _cache_put(key, value):
    with _CACHE_LOCK:
        if len(_CACHE) >= _CACHE_MAX and key not in _CACHE:
            oldest = min(_CACHE.items(), key=lambda kv: kv[1][0])[0]
            _CACHE.pop(oldest, None)
        _CACHE[key] = (time.time(), value)

# ---------------------------------------------------------------- 数据集
DATASETS = {
    "orders": {
        "title": "订单组（已登记波次，按组汇总）",
        "dims": ["route", "zone", "region", "doc_type", "dealer", "wave",
                 "carrier_tms", "tms_status", "status", "erp_status"],
    },
    "lines": {
        "title": "发运明细（已登记波次，按行）",
        "dims": ["route", "zone", "region", "doc_type", "dealer", "wave",
                 "carrier_tms", "tms_status", "status", "hour", "date",
                 "pick_person", "check_person", "warehouse", "freight_free", "erp_status"],
    },
    "waves": {
        "title": "波次",
        "dims": ["wave", "route", "carrier_tms", "tms_status", "status"],
    },
    "trend": {"title": "每日趋势", "dims": ["date"]},
    "coverage": {
        "title": "今日订单量 / 登记覆盖",
        "dims": ["route", "zone", "region", "doc_type"],
    },
    "labor": {"title": "人工作业量（按人）", "dims": ["person"]},
    "labor_hour": {"title": "人工作业量（按小时）", "dims": ["hour"]},
    "erp_detail": {"title": "ERP回传明细（按订单组）", "dims": []},
    "battery": {"title": "动力电池登记（当天已登记）", "dims": []},
    "alerts": {"title": "预警清单", "dims": []},
    "overdue": {"title": "超期未复核订单组", "dims": []},
}

# ---------------------------------------------------------------- 指标
METRIC_META = {
    # 数量
    "rows": {"label": "行数", "unit": "行", "kind": "int"},
    "amount": {"label": "金额", "unit": "万元", "kind": "money"},
    "qty": {"label": "数量", "unit": "", "kind": "num"},
    # 进度
    "picked": {"label": "已拣行数", "unit": "行", "kind": "int"},
    "checked": {"label": "已复核行数", "unit": "行", "kind": "int"},
    "out": {"label": "已出库行数", "unit": "行", "kind": "int"},
    "unchecked": {"label": "未复核行数", "unit": "行", "kind": "int"},
    "unpicked": {"label": "未拣货行数", "unit": "行", "kind": "int"},
    "pending": {"label": "未出库行数", "unit": "行", "kind": "int"},
    "checked_rate": {"label": "复核完成率", "unit": "", "kind": "pct"},
    "picked_rate": {"label": "拣货完成率", "unit": "", "kind": "pct"},
    "out_rate": {"label": "出库完成率", "unit": "", "kind": "pct"},
    "tms_rate": {"label": "运输单释放率", "unit": "", "kind": "pct"},
    # 时效（小时）
    "pick_lag_avg": {"label": "波次→拣货 平均(h)", "unit": "h", "kind": "hours"},
    "check_lag_avg": {"label": "拣货→复核 平均(h)", "unit": "h", "kind": "hours"},
    "out_lag_avg": {"label": "复核→出库 平均(h)", "unit": "h", "kind": "hours"},
    "cycle_avg": {"label": "全链路 平均(h)", "unit": "h", "kind": "hours"},
    "cycle_max": {"label": "全链路 最长(h)", "unit": "h", "kind": "hours"},
    # 覆盖
    "registered_lines": {"label": "已组波行数", "unit": "行", "kind": "int"},
    "registered_amount": {"label": "已组波金额", "unit": "万元", "kind": "money"},
    "unregistered_lines": {"label": "待组波行数", "unit": "行", "kind": "int"},
    "unregistered_amount": {"label": "待组波金额", "unit": "万元", "kind": "money"},
    "coverage_rate": {"label": "登记覆盖率", "unit": "", "kind": "pct"},
    # ERP 回传
    "erp_failed_lines": {"label": "回传失败行数", "unit": "行", "kind": "int"},
    "erp_failed_amount": {"label": "回传失败金额", "unit": "万元", "kind": "money"},
    "erp_missing_lines": {"label": "未回传行数", "unit": "行", "kind": "int"},
    "erp_missing_amount": {"label": "未回传金额", "unit": "万元", "kind": "money"},
    # 人员（拣货 / 复核分开）
    "workers": {"label": "作业人数", "unit": "人", "kind": "int"},
    "labor_hours": {"label": "工时", "unit": "h", "kind": "hours"},
    "labor_rate": {"label": "人效(行/小时)", "unit": "行/小时", "kind": "num"},
    "pick_people": {"label": "拣货人数", "unit": "人", "kind": "int"},
    "check_people": {"label": "复核人数", "unit": "人", "kind": "int"},
    "pick_rows": {"label": "拣货行数", "unit": "行", "kind": "int"},
    "check_rows": {"label": "复核行数", "unit": "行", "kind": "int"},
    "pick_hours": {"label": "拣货有效小时", "unit": "h", "kind": "hours"},
    "check_hours": {"label": "复核有效小时", "unit": "h", "kind": "hours"},
    "pick_rate": {"label": "拣货人效(行/小时)", "unit": "行/小时", "kind": "num"},
    "check_rate": {"label": "复核人效(行/小时)", "unit": "行/小时", "kind": "num"},
    # 趋势
    "ship_rate": {"label": "发运完成率", "unit": "", "kind": "pct"},
}

ORDER_METRICS = [
    "rows", "amount", "qty", "picked", "checked", "out", "unchecked",
    "unpicked", "pending", "checked_rate", "picked_rate", "out_rate", "tms_rate",
    "pick_lag_avg", "check_lag_avg", "out_lag_avg", "cycle_avg", "cycle_max",
]
LINE_METRICS = [
    "rows", "amount", "qty", "picked", "checked", "out", "unchecked",
    "unpicked", "pending", "checked_rate", "picked_rate", "out_rate", "tms_rate",
    "erp_failed_lines", "erp_failed_amount", "erp_missing_lines", "erp_missing_amount",
]
WAVE_METRICS = ["rows", "out", "out_rate", "checked", "picked", "amount", "tms_rate"]
TREND_METRICS = ["rows", "amount", "out_rate", "ship_rate"]
COVERAGE_METRICS = [
    "rows", "amount", "registered_lines", "registered_amount",
    "unregistered_lines", "unregistered_amount", "coverage_rate",
]
LABOR_METRICS = [
    "pick_people", "check_people", "pick_rows", "check_rows",
    "pick_hours", "check_hours", "pick_rate", "check_rate", "rows",
]
LABOR_HOUR_METRICS = ["pick_rows", "check_rows", "pick_people", "check_people"]

DATASET_METRICS = {
    "orders": ORDER_METRICS,
    "lines": LINE_METRICS,
    "waves": WAVE_METRICS,
    "trend": TREND_METRICS,
    "coverage": COVERAGE_METRICS,
    "labor": LABOR_METRICS,
    "labor_hour": LABOR_HOUR_METRICS,
    "erp_detail": ["rows"],
    "battery": ["rows", "qty", "amount", "picked", "checked"],
    "alerts": ["rows"],
    "overdue": ["rows"],
}

# ---------------------------------------------------------------- 维度映射（白名单）
GROUP_DIM = {
    "route": "COALESCE(route,'未映射')",
    "zone": "COALESCE(zone,'未映射')",
    "region": "COALESCE(region,'未映射')",
    "doc_type": "COALESCE(doc_type,'未映射')",
    "dealer": "COALESCE(dealer_short,'未映射')",
    "wave": "wave_no",
    "carrier_tms": "COALESCE(tms_carrier,'无运输单')",
    "tms_status": "COALESCE(tms_status,'无运输单')",
    "status": "COALESCE(status,'未知')",
    "erp_status": "CASE COALESCE(erp_rank,0) WHEN 3 THEN '回传ERP失败' WHEN 2 THEN '未回传ERP' "
                  "WHEN 1 THEN '回传ERP成功' ELSE '未记录' END",
}

LINE_DIM = {
    "route": "COALESCE(route,'未映射')",
    "zone": "COALESCE(zone,'未映射')",
    "region": "COALESCE(region,'未映射')",
    "doc_type": "COALESCE(doc_type,'未映射')",
    "dealer": "COALESCE(dealer_short,'未映射')",
    "wave": "wave_no",
    "carrier_tms": "COALESCE(tms_carrier,'无运输单')",
    "tms_status": "COALESCE(tms_status,'无运输单')",
    "status": "COALESCE(status,'未知')",
    "hour": "COALESCE(substr(out_time,12,2),substr(pick_time,12,2),'未作业')",
    "date": "order_date",
    "pick_person": "COALESCE(pick_person,'未记录')",
    "check_person": "COALESCE(check_person,'未记录')",
    "warehouse": "COALESCE(warehouse,'未记录')",
    "freight_free": "COALESCE(freight_free,'未记录')",
    "erp_status": "COALESCE(erp_status,'未记录')",
}

COVERAGE_DIM = {
    "route": "COALESCE(route,'未映射')",
    "zone": "COALESCE(zone,'未映射')",
    "region": "COALESCE(region,'未映射')",
    "doc_type": "COALESCE(doc_type,'未映射')",
}

# ---------------------------------------------------------------- 配置向导元数据
# 只服务前端配置界面，不影响取数；supports 用于过滤当前组件类型可用的数据集。
DATASET_UI = {
    "orders": {
        "group": "订单与波次", "desc": "已登记波次的订单组，按组汇总；适合看线路、库区、区域的单量分布",
        "supports": ["kpi", "bar", "line", "pie", "table", "progress", "detail"],
        "default_dimension": "route", "default_metrics": ["rows"],
        "filters": ["route", "zone", "region", "doc_type"],
    },
    "lines": {
        "group": "订单与波次", "desc": "已登记波次的发运行明细；适合看进度、ERP 回传、人员与小时分布",
        "supports": ["kpi", "bar", "line", "pie", "table", "progress", "detail"],
        "default_dimension": "route", "default_metrics": ["rows"],
        "filters": ["route", "zone", "region", "doc_type"],
    },
    "waves": {
        "group": "订单与波次", "desc": "按波次汇总的行数与作业进度",
        "supports": ["kpi", "bar", "line", "table", "progress"],
        "default_dimension": "wave", "default_metrics": ["rows"],
        "filters": ["route", "zone", "region"],
    },
    "trend": {
        "group": "趋势", "desc": "按业务日期汇总的历史趋势",
        "supports": ["line", "bar"],
        "default_dimension": "date", "default_metrics": ["rows"],
        "filters": [],
    },
    "coverage": {
        "group": "订单与波次", "desc": "今日订单量、已登记/待组波的行数与金额，以及登记覆盖率",
        "supports": ["kpi", "bar", "line", "pie", "table"],
        "default_dimension": "route", "default_metrics": ["coverage_rate"],
        "filters": ["route", "zone", "region", "doc_type"],
    },
    "labor": {
        "group": "作业与人效", "desc": "按作业人员汇总的拣货/复核人数、行数、有效工时与人效",
        "supports": ["kpi", "bar", "line", "table", "detail"],
        "default_dimension": "person", "default_metrics": ["pick_rate"],
        "filters": [],
    },
    "labor_hour": {
        "group": "作业与人效", "desc": "按小时汇总的拣货/复核作业量；适合曲线看作业节奏",
        "supports": ["line", "bar"],
        "default_dimension": "hour", "default_metrics": ["pick_rows"],
        "filters": [],
    },
    "erp_detail": {
        "group": "ERP 回传", "desc": "按订单组列出回传失败或未回传的明细；只能做表格",
        "supports": ["table", "detail"],
        "default_dimension": "", "default_metrics": ["rows"],
        "filters": [
            {"key": "erp_status", "label": "明细类型", "type": "radio",
             "options": [{"value": "failed", "label": "回传失败"}, {"value": "missing", "label": "未回传"}],
             "default": "failed"},
        ],
    },
    "overdue": {
        "group": "今日总览", "desc": "超过预警中心线路截止时间、复核未完成的订单组，表格可配置",
        "supports": ["table"],
        "default_dimension": "", "default_metrics": ["rows"],
        "filters": [],
    },
    "battery": {
        "group": "今日总览", "desc": "当天已登记的动力电池订单组明细；固定列、汇总行、未完成标红",
        "supports": ["table"],
        "default_dimension": "", "default_metrics": ["rows"],
        "filters": [],
    },
    "alerts": {
        "group": "预警", "desc": "当前超时未出库的订单组清单",
        "supports": ["alert"],
        "default_dimension": "", "default_metrics": ["rows"],
        "filters": [],
    },
}

# 模板库：每个模板都是完整、可用的 spec，供“添加组件”直接使用。
PRESETS = [
    {"key": "kpi-orders-lines", "group": "今日总览", "title": "今日订单量（行）", "desc": "订单日期=业务日的全部行数",
     "type": "kpi", "spec": {"dataset": "coverage", "metrics": ["rows"]}, "w": 2, "h": 3},
    {"key": "kpi-orders-amount", "group": "今日总览", "title": "今日订单金额", "desc": "订单日期=业务日的全部金额（万元）",
     "type": "kpi", "spec": {"dataset": "coverage", "metrics": ["amount"]}, "w": 2, "h": 3},
    {"key": "kpi-coverage-rate", "group": "今日总览", "title": "登记覆盖率", "desc": "今日订单中已登记波次的比例",
     "type": "kpi", "spec": {"dataset": "coverage", "metrics": ["coverage_rate"]}, "w": 2, "h": 3},
    {"key": "kpi-picked-rate", "group": "作业进度", "title": "拣货完成率", "desc": "已拣行数 ÷ 已登记行数",
     "type": "kpi", "spec": {"dataset": "orders", "metrics": ["picked_rate"]}, "w": 2, "h": 3},
    {"key": "kpi-checked-rate", "group": "作业进度", "title": "复核完成率", "desc": "已复核行数 ÷ 已登记行数",
     "type": "kpi", "spec": {"dataset": "orders", "metrics": ["checked_rate"]}, "w": 2, "h": 3},
    {"key": "line-hourly", "group": "作业进度", "title": "每小时拣货/复核", "desc": "按小时看两段作业节奏",
     "type": "line", "spec": {"dataset": "lines", "dimension": "hour", "metrics": ["picked", "checked"]}, "w": 6, "h": 5},
    {"key": "table-routes", "group": "作业进度", "title": "线路进度", "desc": "按线路看行数、已复核与完成率",
     "type": "table", "spec": {"dataset": "orders", "dimension": "route", "metrics": ["rows", "checked", "checked_rate"], "limit": 12}, "w": 12, "h": 6},
    {"key": "table-waves", "group": "作业进度", "title": "波次进度", "desc": "按波次看行数、已拣、已复核与完成率",
     "type": "table", "spec": {"dataset": "waves", "dimension": "wave", "metrics": ["rows", "picked", "checked", "checked_rate"], "limit": 20}, "w": 6, "h": 8},
    {"key": "bar-labor-rank", "group": "作业与人效", "title": "拣货人效排行", "desc": "按人看每小时拣货行数",
     "type": "bar", "spec": {"dataset": "labor", "dimension": "person", "metrics": ["pick_rate"], "limit": 12}, "w": 6, "h": 6},
    {"key": "bar-erp-status", "group": "ERP 回传", "title": "ERP 回传状态", "desc": "成功/未回传/失败的行数与金额",
     "type": "bar", "spec": {"dataset": "lines", "dimension": "erp_status", "metrics": ["rows", "amount"], "limit": 8}, "w": 6, "h": 5},
    {"key": "table-erp-failed", "group": "ERP 回传", "title": "回传失败明细", "desc": "回传 ERP 失败的订单组明细",
     "type": "table", "spec": {"dataset": "erp_detail", "filter": {"erp_status": "failed"}, "limit": 200}, "w": 12, "h": 8},
    {"key": "table-erp-missing", "group": "ERP 回传", "title": "未回传明细", "desc": "尚未回传 ERP 的订单组明细",
     "type": "table", "spec": {"dataset": "erp_detail", "filter": {"erp_status": "missing"}, "limit": 200}, "w": 12, "h": 8},
    {"key": "table-overdue", "group": "预警", "title": "超期未复核",
     "desc": "超过线路预警截止时间且复核未完成的订单组", "type": "table",
     "spec": {"dataset": "overdue", "limit": 200}, "w": 6, "h": 7},
    {"key": "table-battery", "group": "今日总览", "title": "今日动力电池登记",
     "desc": "当天已登记动力电池明细，含拣货/复核与汇总行", "type": "table",
     "spec": {"dataset": "battery", "limit": 200}, "w": 12, "h": 8},
    {"key": "line-trend", "group": "趋势", "title": "每日趋势", "desc": "按业务日看单量与完成率变化",
     "type": "line", "spec": {"dataset": "trend", "metrics": ["rows"]}, "w": 12, "h": 6},
]

ALERT_LIMIT = 200


def _allowed_metrics(dataset):
    return set(DATASET_METRICS.get(dataset, list(METRIC_META)))


def normalize_spec(spec):
    """补默认值并做类型收敛；非法内容直接丢弃。"""
    spec = dict(spec or {})
    dataset = spec.get("dataset") or "orders"
    if dataset not in DATASETS:
        dataset = "orders"
    allowed = _allowed_metrics(dataset)

    dims = DATASETS[dataset]["dims"]
    dimension = spec.get("dimension")
    if dimension not in dims:
        dimension = dims[0] if dims else None

    chosen = spec.get("metrics") or ["rows"]
    if isinstance(chosen, str):
        chosen = [chosen]
    metrics = [m for m in chosen if m in allowed]
    if not metrics:
        metrics = ["rows"] if "rows" in allowed else [sorted(allowed)[0]]

    filters = {}
    for key, value in (spec.get("filter") or {}).items():
        if key in rules.FILTERABLE:
            filters[key] = value
    if dataset == "erp_detail":
        dimension = ""
        metrics = ["rows"]
        filters["erp_status"] = "missing" if filters.get("erp_status") == "missing" else "failed"

    sort = spec.get("sort") or {}
    sort_by = sort.get("by") if isinstance(sort, dict) else None
    if sort_by not in metrics + ["label"]:
        sort_by = metrics[0]
    direction = "asc" if str((sort or {}).get("dir", "desc")).lower() == "asc" else "desc"

    try:
        limit = int(spec.get("limit") or 10)
    except (TypeError, ValueError):
        limit = 10
    limit = max(1, min(limit, 200))

    scheme = str(spec.get("color_scheme") or "").strip().lower()
    if scheme not in ("", "macaron", "dopamine"):
        scheme = ""
    color = str(spec.get("color") or "").strip()
    if not __import__("re").match(r"^#[0-9a-fA-F]{6}$", color):
        color = ""
    result = {
        "dataset": dataset,
        "dimension": dimension,
        "metrics": metrics,
        "filter": filters,
        "sort": {"by": sort_by, "dir": direction},
        "limit": limit,
    }
    if scheme:
        result["color_scheme"] = scheme
    if color:
        result["color"] = color
    if spec.get("compare") is True:
        result["compare"] = True
    widths = spec.get("column_widths")
    if isinstance(widths, dict):
        clean_widths = {}
        for key, value in widths.items():
            try:
                px = int(value)
            except (TypeError, ValueError):
                continue
            if 40 <= px <= 600 and str(key).strip():
                clean_widths[str(key).strip()] = px
        if clean_widths:
            result["column_widths"] = clean_widths
    for key in ("column_order", "hidden_columns", "fields"):
        value = spec.get(key)
        if isinstance(value, list):
            clean = []
            for item in value:
                item = str(item or "").strip()
                if item and item not in clean:
                    clean.append(item)
            if clean:
                result[key] = clean
    if spec.get("show_values") is False:
        result["show_values"] = False
    if dataset == "battery" and "hidden_columns" not in result:
        result["hidden_columns"] = ["address", "confirmed", "dealer_full"]
    return result


# ---------------------------------------------------------------- 组/行级聚合
def _group_metric_sql(m):
    """订单组级事实上的指标表达式（alias = metric）。"""
    mapping = {
        "rows": "COALESCE(SUM(lines),0)",
        "amount": "COALESCE(SUM(amount),0)",
        "qty": "COALESCE(SUM(qty),0)",
        "picked": "COALESCE(SUM(picked),0)",
        "checked": "COALESCE(SUM(checked),0)",
        "out": "COALESCE(SUM(out_lines),0)",
        "unchecked": "COALESCE(SUM(lines),0) - COALESCE(SUM(checked),0)",
        "unpicked": "COALESCE(SUM(lines),0) - COALESCE(SUM(picked),0)",
        "pending": "COALESCE(SUM(lines),0) - COALESCE(SUM(out_lines),0)",
        "checked_rate": "CAST(COALESCE(SUM(checked),0) AS REAL)/MAX(COALESCE(SUM(lines),0),1)",
        "picked_rate": "CAST(COALESCE(SUM(picked),0) AS REAL)/MAX(COALESCE(SUM(lines),0),1)",
        "out_rate": "CAST(COALESCE(SUM(out_lines),0) AS REAL)/MAX(COALESCE(SUM(lines),0),1)",
        "tms_rate": "CAST(COUNT(DISTINCT CASE WHEN tms_status IS NOT NULL THEN wave_no END) AS REAL)"
                    "/MAX(COUNT(DISTINCT wave_no),1)",
        "pick_lag_avg": "AVG(pick_lag_h)",
        "check_lag_avg": "AVG(check_lag_h)",
        "out_lag_avg": "AVG(out_lag_h)",
        "cycle_avg": "AVG(cycle_h)",
        "cycle_max": "MAX(cycle_h)",
    }
    return mapping.get(m)


def _line_metric_sql(m):
    mapping = {
        "rows": "COUNT(*)",
        "amount": "COALESCE(SUM(amount),0)",
        "qty": "COALESCE(SUM(qty),0)",
        "picked": "SUM(CASE WHEN pick_time IS NOT NULL AND pick_time<>'' THEN 1 ELSE 0 END)",
        "checked": "SUM(CASE WHEN (check_time IS NOT NULL AND check_time<>'') OR "
                   "(out_time IS NOT NULL AND out_time<>'') THEN 1 ELSE 0 END)",
        "out": "SUM(CASE WHEN out_time IS NOT NULL AND out_time<>'' THEN 1 ELSE 0 END)",
        "unchecked": "SUM(CASE WHEN (check_time IS NULL OR check_time='') AND "
                     "(out_time IS NULL OR out_time='') THEN 1 ELSE 0 END)",
        "unpicked": "SUM(CASE WHEN pick_time IS NULL OR pick_time='' THEN 1 ELSE 0 END)",
        "pending": "SUM(CASE WHEN out_time IS NULL OR out_time='' THEN 1 ELSE 0 END)",
        "checked_rate": "CAST(SUM(CASE WHEN (check_time IS NOT NULL AND check_time<>'') OR "
                        "(out_time IS NOT NULL AND out_time<>'') THEN 1 ELSE 0 END) AS REAL)/MAX(COUNT(*),1)",
        "picked_rate": "CAST(SUM(CASE WHEN pick_time IS NOT NULL AND pick_time<>'' THEN 1 ELSE 0 END) AS REAL)"
                       "/MAX(COUNT(*),1)",
        "out_rate": "CAST(SUM(CASE WHEN out_time IS NOT NULL AND out_time<>'' THEN 1 ELSE 0 END) AS REAL)"
                    "/MAX(COUNT(*),1)",
        "erp_failed_lines": "SUM(CASE WHEN erp_status='回传ERP失败' THEN 1 ELSE 0 END)",
        "erp_failed_amount": "COALESCE(SUM(CASE WHEN erp_status='回传ERP失败' THEN amount ELSE 0 END),0)",
        "erp_missing_lines": "SUM(CASE WHEN erp_status='未回传ERP' THEN 1 ELSE 0 END)",
        "erp_missing_amount": "COALESCE(SUM(CASE WHEN erp_status='未回传ERP' THEN amount ELSE 0 END),0)",
        "tms_rate": "CAST(COUNT(DISTINCT CASE WHEN tms_status IS NOT NULL THEN wave_no END) AS REAL)"
                    "/MAX(COUNT(DISTINCT wave_no),1)",
    }
    return mapping.get(m)


def _aggregate_sql(conn, biz_date, user_id, spec, with_amount):
    metrics = [m for m in spec["metrics"] if with_amount or m != "amount"]
    if not metrics:
        metrics = ["rows"]
    dataset = spec["dataset"]
    dim_map = LINE_DIM if dataset == "lines" else GROUP_DIM
    make = _line_metric_sql if dataset == "lines" else _group_metric_sql
    if dataset == "lines":
        base, params = rules.lines_sql(conn, biz_date, user_id, spec["filter"])
    else:
        base, params = rules.groups_sql(conn, biz_date, user_id, spec["filter"])

    dim = dim_map.get(spec["dimension"]) or list(dim_map.values())[0]
    parts = []
    for m in metrics:
        expr = make(m)
        if not expr:
            continue
        parts.append("%s AS %s" % (expr, m))
    if not parts:
        parts = ["COUNT(*) AS rows"]
        metrics = ["rows"]

    select = ", ".join([dim + " AS label"] + parts)
    sql = "SELECT %s FROM (%s) f GROUP BY label" % (select, base)

    order_col = "label" if spec["sort"]["by"] == "label" else spec["sort"]["by"]
    if order_col not in metrics + ["label"]:
        order_col = "label"
    direction = "ASC" if spec["sort"]["dir"] == "asc" else "DESC"
    # 时间类维度默认按维度升序，图表才是一条时间轴
    if spec["dimension"] in ("hour", "date") and spec["sort"]["by"] != "label":
        order_col, direction = "label", "ASC"
    sql += " ORDER BY %s %s" % (order_col, direction)
    sql += " LIMIT ?"
    params = list(params) + [spec["limit"]]
    return sql, params, metrics


def _format_value(metric, value):
    if value is None:
        value = 0
    if metric == "amount" or str(metric).endswith("_amount"):
        return round(float(value) / 10000.0, 2)
    if str(metric).endswith("_rate"):
        return round(float(value), 4)
    if metric in ("rows", "picked", "checked", "out", "unchecked", "unpicked", "pending",
                  "workers", "registered_lines", "unregistered_lines"):
        return int(value)
    return round(float(value), 2)


# ---------------------------------------------------------------- 特殊数据集
def _trend_series(conn, spec, with_amount):
    data = rules.trend(conn, 30)
    dates = data["dates"]
    wanted = [m for m in spec["metrics"] if with_amount or m != "amount"]
    series = []
    for m in wanted:
        if m == "rows":
            values = data["lines"]
        elif m == "amount":
            values = data["amount"]
        elif m == "out_rate":
            values = [round(v, 4) for v in data["out_rate"]]
        elif m == "ship_rate":
            values = [round(v, 4) for v in data["ship_rate"]]
        else:
            values = [0] * len(dates)
        series.append({"name": METRIC_META[m]["label"], "values": values, "metric": m})
    return {
        "kind": "series", "dataset": "trend", "dimension": "date",
        "categories": dates, "series": series, "spec": spec, "with_amount": with_amount,
    }


def _coverage_series(conn, biz_date, user_id, spec):
    dim = COVERAGE_DIM.get(spec["dimension"], COVERAGE_DIM["route"])
    day_sql, day_params = rules.day_lines_sql(conn, biz_date, user_id, spec["filter"])
    pending_sql = day_sql + " AND (f.wave_no IS NULL OR TRIM(f.wave_no) = '')"
    reg_sql, reg_params = rules.lines_sql(conn, biz_date, user_id, spec["filter"])
    all_rows = conn.execute(
        "SELECT %s AS label, COUNT(*) AS lines, COALESCE(SUM(amount),0) AS amount "
        "FROM (%s) f GROUP BY label" % (dim, day_sql), day_params,
    ).fetchall()
    pending_rows = {
        r["label"]: r
        for r in conn.execute(
            "SELECT %s AS label, COUNT(*) AS lines, COALESCE(SUM(amount),0) AS amount "
            "FROM (%s) f GROUP BY label" % (dim, pending_sql),
            day_params,
        ).fetchall()
    }
    reg_all_rows = {
        r["label"]: r
        for r in conn.execute(
            "SELECT %s AS label, COUNT(*) AS lines, COALESCE(SUM(amount),0) AS amount "
            "FROM (%s) f GROUP BY label" % (dim, reg_sql),
            list(reg_params),
        ).fetchall()
    }
    rows = []
    for r in all_rows:
        label = r["label"]
        pending = pending_rows.get(label)
        reg_all = reg_all_rows.get(label)
        pending_lines = pending["lines"] if pending else 0
        pending_amount = float(pending["amount"]) if pending else 0.0
        rows.append(
            {
                "label": label,
                "rows": r["lines"],
                "amount": float(r["amount"] or 0),
                # 已组波 = 该业务日已登记波次的台账口径（含跨天、含已移出）
                "registered_lines": reg_all["lines"] if reg_all else 0,
                "registered_amount": float(reg_all["amount"]) if reg_all else 0.0,
                # 待组波 = 所选订单日期中波次号为空的行
                "unregistered_lines": pending_lines,
                "unregistered_amount": pending_amount,
                "coverage_rate": ((r["lines"] - pending_lines) / r["lines"]) if r["lines"] else 0.0,
            }
        )

    order_col = "label" if spec["sort"]["by"] == "label" else spec["sort"]["by"]
    reverse = spec["sort"]["dir"] != "asc"
    if spec["sort"]["by"] == "label":
        rows.sort(key=lambda x: str(x["label"]))
        if reverse:
            rows.reverse()
    else:
        rows.sort(key=lambda x: x.get(order_col, 0) or 0, reverse=reverse)
    rows = rows[: spec["limit"]]

    series = []
    for m in spec["metrics"]:
        if m not in COVERAGE_METRICS:
            continue
        values = [_format_value(m, row.get(m, 0)) for row in rows]
        series.append({"name": METRIC_META[m]["label"], "values": values, "metric": m})
    return {
        "kind": "series", "dataset": "coverage", "dimension": spec["dimension"],
        "categories": [str(r["label"]) for r in rows], "series": series,
        "spec": spec, "with_amount": False,
    }


def _labor_payload(conn, biz_date, user_id, archive=False):
    if archive:
        return rules.labor_archive_stats(conn, biz_date)
    return rules.labor_stats(conn, biz_date, user_id)


def _labor_series(conn, biz_date, user_id, spec, archive=False):
    data = _labor_payload(conn, biz_date, user_id, archive)
    rows = data["rows"]
    order_col = "rows" if spec["sort"]["by"] == "label" else spec["sort"]["by"]
    reverse = spec["sort"]["dir"] != "asc"
    if order_col == "person":
        rows = sorted(rows, key=lambda x: x["person"])
    else:
        rows = sorted(rows, key=lambda x: x.get(order_col) or 0, reverse=reverse)
    rows = rows[: spec["limit"]]
    series = []
    for m in spec["metrics"]:
        values = []
        for row in rows:
            v = row.get(m)
            values.append(0 if v is None else (round(v, 2) if isinstance(v, float) else v))
        series.append({"name": METRIC_META[m]["label"], "values": values, "metric": m})
    return {
        "kind": "series", "dataset": "labor", "dimension": "person",
        "categories": [r["person"] for r in rows], "series": series,
        "spec": spec, "with_amount": False,
    }


def _labor_hour_series(conn, biz_date, user_id, spec, archive=False):
    data = _labor_payload(conn, biz_date, user_id, archive)
    rows = data.get("hourly") or []
    series = []
    for m in spec["metrics"]:
        values = [int(row.get(m) or 0) for row in rows]
        series.append({"name": METRIC_META[m]["label"], "values": values, "metric": m})
    return {
        "kind": "series", "dataset": "labor_hour", "dimension": "hour",
        "categories": [str(row["hour"]) + "点" for row in rows], "series": series,
        "spec": spec, "with_amount": False,
    }


def _erp_detail_payload(conn, biz_date, user_id, spec):
    status = (spec.get("filter") or {}).get("erp_status") or "failed"
    status = "missing" if status == "missing" else "failed"
    data = rules.erp_detail(conn, biz_date, user_id, status, True, limit=spec.get("limit") or 300)
    registered = conn.execute(
        "SELECT COUNT(*) AS c FROM wave_registry WHERE biz_date=? AND deleted_at IS NULL", (biz_date,)
    ).fetchone()["c"]
    if data.get("total"):
        empty_text = ""
    elif not registered:
        empty_text = "业务日期 %s 尚未登记波次，登记后这里显示回传明细" % biz_date
    elif status == "missing":
        empty_text = "今天没有未回传的订单组"
    else:
        empty_text = "今天没有回传失败的订单组"
    columns = [
        {"key": "seq", "label": "序号"},
        {"key": "group_no", "label": "订单组号"},
        {"key": "dealer", "label": "经销商"},
        {"key": "lines", "label": "行数", "align": "right"},
        {"key": "amount", "label": "金额(元)", "align": "right"},
        {"key": "zone", "label": "库区"},
        {"key": "doc_type", "label": "单据类型"},
        {"key": "freight_free", "label": "免运费"},
        {"key": "region", "label": "区域"},
        {"key": "route", "label": "承运商"},
        {"key": "wave_no", "label": "波次号"},
        {"key": "tms_status", "label": "清洗"},
        {"key": "assignee", "label": "指派"},
        {"key": "erp_status", "label": "ERP状态"},
        {"key": "erp_lines", "label": "异常行数", "align": "right"},
        {"key": "erp_message", "label": "回传信息"},
        {"key": "erp_time", "label": "回传时间"},
    ]
    return {
        "kind": "rows",
        "dataset": "erp_detail",
        "dimension": None,
        "rows": data["rows"],
        "total": data.get("total"),
        "columns": columns,
        "spec": None,
        "with_amount": True,
        "status": status,
        "filter_status": status,
        "empty_text": empty_text,
    }


def _alerts_payload(conn, biz_date, user_id, with_amount):
    data = rules.progress(conn, biz_date, user_id, with_amount)
    rows = []
    for item in data["alerts"][:ALERT_LIMIT]:
        rows.append(
            {
                "group_no": item["group_no"],
                "wave_no": item["wave_no"],
                "dealer": item["dealer"],
                "route": item["route"],
                "remaining": item["remaining"],
                "lines": item["lines"],
                "amount": item["amount"],
                "tms_status": item["tms_status"] or "未匹配",
            }
        )
    return {
        "kind": "rows", "dataset": "alerts", "dimension": None, "rows": rows,
        "columns": [
            {"key": "group_no", "label": "订单组号"},
            {"key": "dealer", "label": "经销商"},
            {"key": "route", "label": "线路"},
            {"key": "remaining", "label": "未复核行", "align": "right"},
            {"key": "lines", "label": "总行数", "align": "right"},
            {"key": "amount", "label": "金额(万)", "align": "right"},
            {"key": "tms_status", "label": "运输单"},
        ],
        "spec": None,
        "with_amount": with_amount,
    }


def _overdue_payload(conn, biz_date, user_id, with_amount=True):
    """超过预警中心截止时间且复核未完成的订单组。"""
    try:
        states = alerts.status_now(conn, biz_date)
    except Exception:  # noqa: BLE001
        states = []
    deadlines = {
        str(item.get("route") or "未映射"): item
        for item in states if item.get("state") == "overdue"
    }
    if not deadlines:
        return {"kind": "rows", "dataset": "overdue", "dimension": None, "rows": [],
                "columns": _overdue_columns(), "total": 0, "spec": None, "with_amount": with_amount}
    gsql, gp = rules.groups_sql(conn, biz_date, user_id)
    routes = list(deadlines)
    marks = ",".join("?" * len(routes))
    rows = conn.execute(
        "SELECT group_no, wave_no, dealer_short, route, zone, lines, checked, amount, tms_status "
        "FROM (%s) g WHERE COALESCE(route, '未映射') IN (%s) AND checked < lines "
        "ORDER BY (lines - checked) DESC LIMIT 200" % (gsql, marks),
        list(gp) + routes,
    ).fetchall()
    result = []
    for r in rows:
        item = dict(r)
        item["dealer"] = item.get("dealer_short")
        item["remaining"] = max(0, int(item.get("lines") or 0) - int(item.get("checked") or 0))
        item["deadline"] = (deadlines.get(str(item.get("route") or "未映射")) or {}).get("deadline", "")
        item["amount"] = round((item.get("amount") or 0) / 10000.0, 2) if with_amount else None
        item["tms_status"] = item.get("tms_status") or "未匹配"
        item["incomplete"] = True
        result.append(item)
    return {"kind": "rows", "dataset": "overdue", "dimension": None, "rows": result,
            "columns": _overdue_columns(), "total": len(result), "spec": None,
            "with_amount": with_amount}


def _overdue_columns():
    return [
        {"key": "group_no", "label": "订单组号"},
        {"key": "wave_no", "label": "波次号"},
        {"key": "dealer", "label": "经销商"},
        {"key": "route", "label": "线路"},
        {"key": "zone", "label": "库区"},
        {"key": "lines", "label": "总行数", "align": "right"},
        {"key": "checked", "label": "已复核", "align": "right"},
        {"key": "remaining", "label": "未复核", "align": "right"},
        {"key": "amount", "label": "金额(万)", "align": "right"},
        {"key": "deadline", "label": "截止时间"},
        {"key": "tms_status", "label": "运输单"},
    ]


def _battery_payload(conn, biz_date, with_amount=True):
    data = battery.rows(conn, "", "", "", "confirmed", 1, 5000, with_amount,
                        reg_from=biz_date, reg_to=biz_date)
    rows = data.get("rows") or []
    columns = [
        {"key": "order_date", "label": "订单日期"},
        {"key": "reg_date", "label": "登记日期"},
        {"key": "group_no", "label": "订单组号"},
        {"key": "dealer_short", "label": "经销商"},
        {"key": "part_code", "label": "备件编码"},
        {"key": "part_name", "label": "备件名称"},
        {"key": "lines", "label": "行数", "align": "right"},
        {"key": "qty", "label": "数量", "align": "right"},
        {"key": "amount", "label": "金额", "align": "right"},
        {"key": "zone", "label": "库区"},
        {"key": "doc_type", "label": "单据类型"},
        {"key": "freight_free", "label": "是否免运费"},
        {"key": "region", "label": "区域"},
        {"key": "carrier", "label": "承运商"},
        {"key": "dest_city", "label": "送达城市"},
        {"key": "picked", "label": "拣货行数", "align": "right"},
        {"key": "checked", "label": "复核行数", "align": "right"},
        {"key": "address", "label": "地址"},
        {"key": "confirmed", "label": "状态"},
        {"key": "dealer_full", "label": "经销商全称"},
    ]
    summary = {
        "lines": sum(int(r.get("lines") or 0) for r in rows),
        "qty": round(sum(float(r.get("qty") or 0) for r in rows), 4),
        "amount": round(sum(float(r.get("amount") or 0) for r in rows), 2) if with_amount else None,
        "picked": sum(int(r.get("picked") or 0) for r in rows),
        "checked": sum(int(r.get("checked") or 0) for r in rows),
    }
    return {"kind": "rows", "dataset": "battery", "dimension": None, "rows": rows,
            "columns": columns, "total": len(rows), "summary": summary,
            "with_amount": with_amount, "spec": None}


# ---------------------------------------------------------------- 对外入口
def run(conn, biz_date, user_id, spec, with_amount=True, archive=False):
    """执行组件取数，返回统一结构（带缓存，按数据版本失效）。"""
    spec = normalize_spec(spec)
    key = _cache_key("run", biz_date, user_id, spec, with_amount, archive, db.get_version(conn))
    cached = _cache_get(key)
    if cached is not None:
        return cached
    data = _run_uncached(conn, biz_date, user_id, spec, with_amount, archive)
    _cache_put(key, data)
    return data


def _run_uncached(conn, biz_date, user_id, spec, with_amount=True, archive=False):
    dataset = spec["dataset"]

    if dataset == "trend":
        data = _trend_series(conn, spec, with_amount)
        data["spec"] = spec
        return data
    if dataset == "alerts":
        data = _alerts_payload(conn, biz_date, user_id, with_amount)
        data["spec"] = spec
        return data
    if dataset == "coverage":
        data = _coverage_series(conn, biz_date, user_id, spec)
        data["spec"] = spec
        return data
    if dataset == "labor":
        data = _labor_series(conn, biz_date, user_id, spec, archive)
        data["spec"] = spec
        return data
    if dataset == "labor_hour":
        data = _labor_hour_series(conn, biz_date, user_id, spec, archive)
        data["spec"] = spec
        return data
    if dataset == "erp_detail":
        data = _erp_detail_payload(conn, biz_date, user_id, spec)
        data["spec"] = spec
        return data
    if dataset == "battery":
        data = _battery_payload(conn, biz_date, with_amount)
        data["spec"] = spec
        return data
    if dataset == "overdue":
        data = _overdue_payload(conn, biz_date, user_id, with_amount)
        data["spec"] = spec
        return data

    sql, params, metrics = _aggregate_sql(conn, biz_date, user_id, spec, with_amount)
    rows = conn.execute(sql, params).fetchall()

    categories = [str(r["label"]) if r["label"] is not None else "未映射" for r in rows]
    series = []
    for m in metrics:
        values = [_format_value(m, r[m]) for r in rows]
        series.append({"name": METRIC_META[m]["label"], "values": values, "metric": m})

    return {
        "kind": "series",
        "dataset": dataset,
        "dimension": spec["dimension"],
        "categories": categories,
        "series": series,
        "spec": spec,
        "with_amount": with_amount,
    }


def single_value(conn, biz_date, user_id, spec, with_amount=True, archive=False):
    """KPI 组件：单一聚合值（带缓存，按数据版本失效）。"""
    spec = normalize_spec(spec)
    key = _cache_key("kpi", biz_date, user_id, spec, with_amount, archive, db.get_version(conn))
    cached = _cache_get(key)
    if cached is not None:
        return cached
    data = _single_value_uncached(conn, biz_date, user_id, spec, with_amount, archive)
    _cache_put(key, data)
    return data


def _single_value_uncached(conn, biz_date, user_id, spec, with_amount=True, archive=False):
    dataset = spec["dataset"]
    metric = spec["metrics"][0]
    unit = METRIC_META.get(metric, {}).get("unit", "")
    if with_amount:
        pass
    elif metric == "amount":
        allowed = [m for m in spec["metrics"] if m != "amount"]
        metric = allowed[0] if allowed else "rows"

    if dataset == "alerts":
        data = rules.progress(conn, biz_date, user_id, with_amount)
        return {"value": len(data["alerts"]), "metric": "alerts", "label": "预警订单组", "unit": "个"}
    if dataset == "erp_detail":
        detail = rules.erp_detail(conn, biz_date, user_id,
                                  (spec.get("filter") or {}).get("erp_status") or "failed", True, limit=1)
        return {"value": detail.get("total", 0), "metric": "erp_groups", "label": "订单组数", "unit": "组"}
    if dataset == "trend":
        data = _trend_series(conn, dict(spec, metrics=[metric]), with_amount)
        series = data["series"][0]["values"] if data["series"] else [0]
        return {"value": series[-1] if series else 0, "metric": metric,
                "label": METRIC_META[metric]["label"], "unit": METRIC_META[metric].get("unit", "")}
    if dataset == "coverage":
        cov = rules.coverage(conn, biz_date, user_id)
        values = {
            "rows": cov["today"]["lines"],
            "amount": cov["today"]["amount"],
            # 今日“已登记”只算当天已登记波次，不能把其它日期的已登记行算进来
            "registered_lines": cov["registered_today"]["lines"],
            "registered_amount": cov["registered_today"]["amount"],
            "unregistered_lines": cov["unregistered"]["lines"],
            "unregistered_amount": cov["unregistered"]["amount"],
            "coverage_rate": cov["coverage_rate"],
        }
        return {"value": _format_value(metric, values.get(metric, 0)), "metric": metric,
                "label": METRIC_META[metric]["label"], "unit": METRIC_META[metric].get("unit", "")}
    if dataset == "labor":
        data = _labor_payload(conn, biz_date, user_id, archive)
        totals = data["totals"]
        values = {
            "workers": totals.get("people"),
            "rows": totals.get("rows"),
            "pick_people": totals.get("pick_people"),
            "check_people": totals.get("check_people"),
            "pick_rows": totals.get("pick_rows"),
            "check_rows": totals.get("check_rows"),
            "pick_hours": totals.get("pick_hours"),
            "check_hours": totals.get("check_hours"),
            "pick_rate": totals.get("pick_rate"),
            "check_rate": totals.get("check_rate"),
        }
        return {"value": values.get(metric), "metric": metric,
                "label": METRIC_META[metric]["label"], "unit": METRIC_META[metric].get("unit", "")}
    if dataset == "labor_hour":
        rows = _labor_payload(conn, biz_date, user_id, archive).get("hourly") or []
        total = sum(int(row.get(metric) or 0) for row in rows)
        return {"value": total, "metric": metric, "label": METRIC_META[metric]["label"], "unit": METRIC_META[metric].get("unit", "")}

    if dataset == "lines":
        base, params = rules.lines_sql(conn, biz_date, user_id, spec["filter"])
        expr = _line_metric_sql(metric)
    else:
        base, params = rules.groups_sql(conn, biz_date, user_id, spec["filter"])
        expr = _group_metric_sql(metric)
    row = conn.execute("SELECT COALESCE(%s,0) AS v FROM (%s) f" % (expr, base), params).fetchone()
    value = row["v"] if row else 0
    return {"value": _format_value(metric, value), "metric": metric,
            "label": METRIC_META[metric]["label"], "unit": METRIC_META[metric].get("unit", "")}
