# -*- coding: utf-8 -*-
"""业务口径：单量、作业进度、运输单、预警、趋势。

所有查询都在服务端完成，并统一注入「数据范围」过滤；金额是否可看由调用方
传入 with_amount 控制（无权限时整段不返回，而不是前端隐藏）。
"""
import json
from datetime import datetime

from backend.core import auth
from backend.core import db

BASE_LINES = """
SELECT s.id AS line_id,
       s.order_date, s.wave_no,
       -- 订单组号缺失的行（导出没填）按 wms 单号单独成组，避免几百行被并成一个空组
       COALESCE(NULLIF(s.group_no, ''), 'NOGROUP-' || s.wms_no) AS group_no,
       s.group_no AS group_no_raw,
       s.wms_no, s.line_no,
       s.dealer_full,
       COALESCE(m.short_name, s.dealer_full) AS dealer_short,
       COALESCE(ov.region_override,
                CASE WHEN s.doc_type = '调拨出库' THEN '省外调拨' ELSE m.region END) AS region,
       COALESCE(ov.route_override, wr.carrier_override,
                CASE WHEN s.doc_type = '调拨出库' THEN '顺丰速运' ELSE m.route END) AS route,
       COALESCE(ov.assign_override, wr.carrier_override, t.carrier) AS assignee,
       COALESCE(ov.include_flag, 1) AS include_flag,
       ov.note AS group_note,
       s.zone, s.doc_type, s.freight_free, s.part_code, s.part_name,
       s.qty, s.amount, s.status,
       s.wave_time, s.pick_time, s.check_time, s.out_time, s.pick_qty, s.out_qty,
       s.pick_person, s.check_person, s.wave_person, s.warehouse,
       s.erp_required, s.erp_status, s.erp_message, s.erp_time,
       t.status AS tms_status, t.carrier AS tms_carrier,
       wr.note AS wave_note, wr.id AS wave_reg_id
FROM ship_lines s
LEFT JOIN dealer_lookup m ON m.key = s.dealer_full
LEFT JOIN wave_registry wr
       ON wr.wave_no = s.wave_no AND wr.biz_date = ? AND wr.deleted_at IS NULL
LEFT JOIN order_overrides ov
       ON ov.biz_date = ? AND ov.group_no = COALESCE(NULLIF(s.group_no, ''), 'NOGROUP-' || s.wms_no)
LEFT JOIN (
       SELECT wave_no, MAX(status) AS status, MAX(carrier) AS carrier
       FROM tms_status GROUP BY wave_no
) t ON t.wave_no = s.wave_no
WHERE s.wave_no IN (
       SELECT wave_no FROM wave_registry WHERE biz_date = ? AND deleted_at IS NULL
)
"""

# 当日全量口径：同一套维度增强，但只按订单日期过滤，不要求波次已登记
BASE_DAY = BASE_LINES.replace(
    "WHERE s.wave_no IN (\n"
    "       SELECT wave_no FROM wave_registry WHERE biz_date = ? AND deleted_at IS NULL\n"
    ")",
    "WHERE s.order_date = ?",
)

DIM_EXPR = {
    "route": "route",
    "zone": "zone",
    "region": "region",
    "doc_type": "doc_type",
    "dealer": "dealer_short",
    "wave": "wave_no",
    "carrier_tms": "tms_carrier",
    "tms_status": "tms_status",
    "status": "status",
    "hour": "substr(out_time, 12, 2)",
    "date": "order_date",
    "pick_person": "pick_person",
    "check_person": "check_person",
    "warehouse": "warehouse",
    "freight_free": "freight_free",
    "erp_status": "COALESCE(erp_status, '未记录')",
}

DIM_LABEL = {
    "route": "承运商/线路",
    "zone": "库区",
    "region": "区域",
    "doc_type": "单据类型",
    "dealer": "经销商",
    "wave": "波次",
    "carrier_tms": "运输承运商",
    "tms_status": "运输单状态",
    "status": "发运状态",
    "hour": "小时",
    "date": "日期",
    "pick_person": "拣货人",
    "check_person": "复核人",
    "warehouse": "仓库",
    "freight_free": "是否免运费",
    "erp_status": "ERP回传状态",
}

FILTERABLE = (
    "region", "route", "zone", "doc_type", "wave", "status", "carrier_tms",
    "tms_status", "pick_person", "check_person", "warehouse", "freight_free",
    "erp_status",
)


# ---------------------------------------------------------------- 基础
def _scope_map(conn, user_id):
    """把用户（自身+组）的数据范围合并成 {dim: set(values)}。"""
    merged = {}
    if user_id is None:
        return merged
    for dim, values_json in auth.scope_rows(conn, user_id):
        try:
            values = json.loads(values_json)
        except Exception:
            values = []
        if not isinstance(values, list) or not values:
            continue
        merged.setdefault(dim, set()).update(str(v) for v in values)
    return merged


def _in_clause(column, values, params):
    values = [str(v) for v in values]
    if not values:
        return "0=1"
    params.extend(values)
    return "%s IN (%s)" % (column, ",".join("?" * len(values)))


def _scope_conds(conn, user_id, filters, params, include_excluded=False):
    """数据范围 + 组件筛选条件（供"已登记口径"和"当日全量口径"共用）。"""
    conds = []
    scopes = _scope_map(conn, user_id)
    if not include_excluded:
        conds.append("COALESCE(f.include_flag, 1) = 1")

    waves_owned = "own" in scopes.get("waves", set())
    explicit_waves = sorted(v for v in scopes.get("waves", set()) if v != "own")

    for dim in ("region", "route", "zone", "doc_type"):
        if dim in scopes:
            conds.append(_in_clause("f." + dim, sorted(scopes[dim]), params))

    wave_conds = []
    if waves_owned:
        wave_conds.append(
            "f.wave_no IN (SELECT wave_no FROM wave_registry "
            "WHERE deleted_at IS NULL AND created_by = ?)"
        )
        params.append(user_id)
    if explicit_waves:
        wave_conds.append(_in_clause("f.wave_no", explicit_waves, params))
    if wave_conds:
        conds.append("(" + " OR ".join(wave_conds) + ")")

    for dim, value in (filters or {}).items():
        if dim not in FILTERABLE:
            continue
        if dim == "carrier_tms":
            column = "f.tms_carrier"
        elif dim == "tms_status":
            column = "f.tms_status"
        else:
            column = "f." + dim
        if isinstance(value, (list, tuple, set)):
            values = [v for v in value if v not in (None, "")]
            if values:
                conds.append(_in_clause(column, values, params))
        elif value not in (None, ""):
            conds.append(_in_clause(column, [value], params))
    return conds


def lines_sql(conn, biz_date, user_id=None, filters=None, include_excluded=False):
    """返回（已注入数据范围与筛选的）行级事实 SELECT（已登记波次口径）。"""
    params = [biz_date, biz_date, biz_date]
    conds = _scope_conds(conn, user_id, filters, params, include_excluded)
    # 已登记口径：只要波次在所选业务日登记，波次内的行都算（不按订单日期过滤）
    sql = "SELECT f.* FROM (%s) f" % BASE_LINES
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    return sql, params


def day_lines_sql(conn, biz_date, user_id=None, filters=None, include_excluded=True):
    """当日全量口径（不按波次登记过滤，按订单日期），用于"今日订单量/漏登记"。"""
    params = [biz_date, biz_date, biz_date]
    conds = ["f.order_date = ?"]
    params.append(biz_date)
    conds.extend(_scope_conds(conn, user_id, filters, params, include_excluded))
    sql = "SELECT f.* FROM (%s) f WHERE " % BASE_DAY + " AND ".join(conds)
    return sql, params


def groups_sql(conn, biz_date, user_id=None, filters=None, include_excluded=False):
    """订单组级事实。

    未编号（订单组号为空）的行仍保留在行级数据中，但不形成订单组；
    订单组登记、订单组数、已登记行数/金额都只看有最终订单组号的行。
    """
    line_sql, params = lines_sql(conn, biz_date, user_id, filters, include_excluded)
    line_sql = "SELECT f.* FROM (%s) f WHERE COALESCE(TRIM(f.group_no_raw), '') <> ''" % line_sql
    sql = """
SELECT group_no,
       MAX(wave_no) AS wave_no,
       MAX(dealer_short) AS dealer_short,
       MAX(dealer_full) AS dealer_full,
       MAX(region) AS region,
       MAX(route) AS route,
       MAX(assignee) AS assignee,
       MAX(include_flag) AS include_flag,
       MAX(group_note) AS group_note,
       MAX(wave_reg_id) AS wave_reg_id,
       MAX(zone) AS zone,
       MAX(doc_type) AS doc_type,
       MAX(freight_free) AS freight_free,
       COUNT(*) AS lines,
       SUM(amount) AS amount,
       SUM(qty) AS qty,
       SUM(CASE WHEN pick_time IS NOT NULL AND pick_time <> '' THEN 1 ELSE 0 END) AS picked,
       -- 已复核 = 有复核时间 或 已出库（导出里少数行没有复核时间但已发货）
       SUM(CASE WHEN (check_time IS NOT NULL AND check_time <> '')
                  OR (out_time IS NOT NULL AND out_time <> '') THEN 1 ELSE 0 END) AS checked,
       SUM(CASE WHEN out_time IS NOT NULL AND out_time <> '' THEN 1 ELSE 0 END) AS out_lines,
       SUM(CASE WHEN (check_time IS NULL OR check_time = '')
                  AND (out_time IS NULL OR out_time = '') THEN 1 ELSE 0 END) AS unchecked,
       MAX(erp_required) AS erp_required,
       MAX(CASE WHEN erp_status = '回传ERP失败' THEN 3
                WHEN erp_status = '未回传ERP' THEN 2
                WHEN erp_status = '回传ERP成功' THEN 1 ELSE 0 END) AS erp_rank,
       MAX(erp_message) AS erp_message,
       MAX(erp_time) AS erp_time,
       SUM(CASE WHEN erp_status = '回传ERP失败' THEN 1 ELSE 0 END) AS erp_failed_lines,
       SUM(CASE WHEN erp_status = '未回传ERP' THEN 1 ELSE 0 END) AS erp_missing_lines,
       SUM(CASE WHEN erp_status = '回传ERP失败' THEN amount ELSE 0 END) AS erp_failed_amount,
       SUM(CASE WHEN erp_status = '未回传ERP' THEN amount ELSE 0 END) AS erp_missing_amount,
       MAX(tms_status) AS tms_status,
       MAX(tms_carrier) AS tms_carrier,
       MAX(status) AS status,
       MAX(wave_note) AS note,
       MIN(wave_time) AS wave_time,
       MIN(pick_time) AS pick_time,
       MIN(check_time) AS check_time,
       MAX(out_time) AS out_time,
       -- 时效（小时）：组级"开始→结束"跨度，空值表示该节点缺失
       CASE WHEN MIN(wave_time) <> '' AND MIN(pick_time) <> ''
            THEN (julianday(MIN(pick_time)) - julianday(MIN(wave_time))) * 24.0 END AS pick_lag_h,
       CASE WHEN MIN(pick_time) <> '' AND MIN(check_time) <> ''
            THEN (julianday(MIN(check_time)) - julianday(MIN(pick_time))) * 24.0 END AS check_lag_h,
       CASE WHEN MIN(check_time) <> '' AND MAX(out_time) <> ''
            THEN (julianday(MAX(out_time)) - julianday(MIN(check_time))) * 24.0 END AS out_lag_h,
       CASE WHEN MIN(wave_time) <> '' AND MAX(out_time) <> ''
            THEN (julianday(MAX(out_time)) - julianday(MIN(wave_time))) * 24.0 END AS cycle_h
FROM (%s)
GROUP BY group_no
""" % line_sql
    return sql, params


def _row_dict(row):
    return {k: row[k] for k in row.keys()} if row is not None else {}


# ---------------------------------------------------------------- KPI
def registered_waves(conn, biz_date):
    return [
        r["wave_no"]
        for r in conn.execute(
            "SELECT wave_no FROM wave_registry WHERE biz_date=? AND deleted_at IS NULL "
            "ORDER BY wave_no",
            (biz_date,),
        )
    ]


def tms_wave_set(conn):
    return {r["wave_no"] for r in conn.execute("SELECT DISTINCT wave_no FROM tms_status")}


def pending_waves(conn, biz_date):
    """已登记但当前发运表里还没有数据的波次。"""
    rows = conn.execute(
        "SELECT w.wave_no FROM wave_registry w WHERE w.biz_date=? AND w.deleted_at IS NULL "
        "AND NOT EXISTS (SELECT 1 FROM ship_lines s WHERE s.wave_no = w.wave_no) "
        "ORDER BY w.id",
        (biz_date,),
    ).fetchall()
    return [r["wave_no"] for r in rows]


def wave_has_data(conn, wave_no):
    return bool(
        conn.execute("SELECT 1 FROM ship_lines WHERE wave_no=? LIMIT 1", (wave_no,)).fetchone()
    )


def data_range(conn):
    row = conn.execute(
        "SELECT MIN(order_date) AS mn, MAX(order_date) AS mx, "
        "COUNT(DISTINCT order_date) AS days FROM ship_lines WHERE order_date IS NOT NULL"
    ).fetchone()
    return {"min": row["mn"], "max": row["mx"], "days": row["days"] or 0}


# ---------------------------------------------------------------- 今日订单量 / 漏登记
def pending_lines(conn, biz_date, user_id=None, filters=None):
    """待组波：所选订单日期中，波次号为空/NULL 的明细行。"""
    day_sql, day_params = day_lines_sql(conn, biz_date, user_id, filters)
    sql = day_sql + " AND (f.wave_no IS NULL OR TRIM(f.wave_no) = '')"
    row = conn.execute(
        "SELECT COUNT(*) AS lines, COUNT(DISTINCT f.group_no) AS groups, "
        "COALESCE(SUM(f.amount),0) AS amount FROM (%s) f" % sql,
        day_params,
    ).fetchone()
    return {
        "lines": row["lines"] or 0,
        "groups": row["groups"] or 0,
        "amount": float(row["amount"] or 0),
    }


def pending_detail(conn, biz_date, user_id=None, page=1, page_size=50, filters=None):
    """待组波明细分页（空波次号行）。"""
    page = max(1, int(page or 1))
    page_size = max(1, min(200, int(page_size or 50)))
    day_sql, day_params = day_lines_sql(conn, biz_date, user_id, filters)
    where = day_sql + " AND (f.wave_no IS NULL OR TRIM(f.wave_no) = '')"
    summary = conn.execute(
        "SELECT COUNT(*) AS lines, COUNT(DISTINCT f.group_no) AS groups, "
        "COALESCE(SUM(f.amount),0) AS amount FROM (%s) f" % where,
        day_params,
    ).fetchone()
    total = summary["lines"] or 0
    pages = max(1, (total + page_size - 1) // page_size) if total else 1
    if page > pages:
        page = pages
    rows = conn.execute(
        "SELECT f.order_date, f.group_no, f.wms_no, f.dealer_short, f.route, f.zone, "
        "f.doc_type, f.amount, f.qty, f.status, f.pick_time, f.check_time, f.out_time, "
        "f.wave_no, f.wms_no AS line_ref "
        "FROM (%s) f ORDER BY f.order_date, f.group_no, f.wms_no "
        "LIMIT ? OFFSET ?" % where,
        day_params + [page_size, (page - 1) * page_size],
    ).fetchall()
    return {
        "date": biz_date,
        "lines": total,
        "groups": summary["groups"] or 0,
        "amount": float(summary["amount"] or 0),
        "page": page,
        "page_size": page_size,
        "pages": pages,
        "rows": [{k: r[k] for k in r.keys()} for r in rows],
    }


def coverage(conn, biz_date, user_id=None):
    """今日订单量（当日全量） vs 已登记（波次覆盖）。"""
    day_sql, day_params = day_lines_sql(conn, biz_date, user_id)
    reg_sql, reg_params = lines_sql(conn, biz_date, user_id)

    def one(sql, params):
        row = conn.execute(
            "SELECT COUNT(*) AS lines, COUNT(DISTINCT group_no) AS groups, "
            "COALESCE(SUM(amount),0) AS amount FROM (%s) f" % sql,
            params,
        ).fetchone()
        return {
            "lines": row["lines"] or 0,
            "groups": row["groups"] or 0,
            "amount": float(row["amount"] or 0),
        }

    today = one(day_sql, day_params)
    # 已登记：只看“波次登记在所选业务日”，不限制行自身的订单日期
    registered_sql = reg_sql + " AND COALESCE(TRIM(f.group_no_raw), '') <> ''"
    registered_today = one(registered_sql, reg_params)
    registered_all = registered_today
    pending = pending_lines(conn, biz_date, user_id)
    return {
        "biz_date": biz_date,
        "today": today,
        "registered_today": registered_today,
        "registered_all": registered_all,
        "pending": pending,
        "unregistered": pending,
        "coverage_rate": ((today["lines"] - pending["lines"]) / today["lines"]) if today["lines"] else 0.0,
    }


# ---------------------------------------------------------------- 人工作业量
BASE_WORK = """
SELECT s.id AS line_id, s.order_date, s.wave_no,
       COALESCE(NULLIF(s.group_no, ''), 'NOGROUP-' || s.wms_no) AS group_no,
       s.dealer_full,
       COALESCE(m.short_name, s.dealer_full) AS dealer_short,
       COALESCE(ov.region_override,
                CASE WHEN s.doc_type = '调拨出库' THEN '省外调拨' ELSE m.region END) AS region,
       COALESCE(ov.route_override, wr.carrier_override,
                CASE WHEN s.doc_type = '调拨出库' THEN '顺丰速运' ELSE m.route END) AS route,
       COALESCE(ov.include_flag, 1) AS include_flag,
       s.zone, s.doc_type,
       s.pick_person, s.check_person, s.pick_time, s.check_time
FROM ship_lines s
LEFT JOIN dealer_lookup m ON m.key = s.dealer_full
LEFT JOIN wave_registry wr
       ON wr.wave_no = s.wave_no AND wr.biz_date = ? AND wr.deleted_at IS NULL
LEFT JOIN order_overrides ov
       ON ov.biz_date = ? AND ov.group_no = COALESCE(NULLIF(s.group_no, ''), 'NOGROUP-' || s.wms_no)
WHERE {where}
"""

WORK_ROLE = {
    "pick": ("s.pick_person", "s.pick_time", "pick_person", "pick_time"),
    "check": ("s.check_person", "s.check_time", "check_person", "check_time"),
}


def work_lines_sql(conn, biz_date, user_id=None, role="pick", filters=None,
                   include_excluded=False):
    """按**作业时间日期**取人员作业行（拣货看拣货时间，复核看复核时间）。

    与业务日期口径不同：一个波次跨天时，行会按各自实际作业日期落到不同天。
    """
    person_sql, time_sql, _p, _t = WORK_ROLE.get(role, WORK_ROLE["pick"])
    params = [biz_date, biz_date, biz_date]
    base_where = "substr(%s,1,10) = ? AND %s IS NOT NULL AND %s <> ''" % (
        time_sql, person_sql, person_sql,
    )
    conds = _scope_conds(conn, user_id, filters, params, include_excluded)
    sql = "SELECT f.* FROM (%s) f" % BASE_WORK.format(where=base_where)
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    return sql, params


def work_break_ranges(conn, biz_date):
    """把全局休息时段展开成当天的 (开始, 结束) datetime 列表。"""
    try:
        base = datetime.strptime(biz_date, "%Y-%m-%d")
    except (TypeError, ValueError):
        return []
    ranges = []
    for row in conn.execute(
        "SELECT start_time, end_time FROM work_breaks WHERE enabled=1 ORDER BY start_time"
    ):
        try:
            sh, sm = str(row["start_time"]).split(":")[:2]
            eh, em = str(row["end_time"]).split(":")[:2]
            start = base.replace(hour=int(sh), minute=int(sm), second=0)
            end = base.replace(hour=int(eh), minute=int(em), second=0)
        except (ValueError, AttributeError):
            continue
        if end <= start:
            continue
        ranges.append((start, end))
    return ranges


def labor_gap_minutes(conn):
    try:
        return max(1, min(240, int(db.get_meta(conn, "labor_gap_minutes") or 30)))
    except (TypeError, ValueError):
        return 30


def _parse_dt(text):
    if not text:
        return None
    try:
        return datetime.strptime(str(text)[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def work_minutes(points, gap_cap=30, breaks=None):
    """按相邻作业时间点累计作业分钟。

    - 相邻间隔 <= 阈值才计入；超过阈值视为休息，不计（不按阈值封顶）
    - 计入的区间再扣除与「全局休息时段」重叠的分钟
    - 只有 1 个时间点（无法推断时长）返回 0
    """
    if not points or len(points) < 2:
        return 0.0
    breaks = breaks or []
    total = 0.0
    for a, b in zip(points, points[1:]):
        if a is None or b is None:
            continue
        gap = (b - a).total_seconds() / 60.0
        if gap <= 0 or gap > gap_cap:
            continue
        overlap = 0.0
        for start, end in breaks:
            lo = max(a, start)
            hi = min(b, end)
            if hi > lo:
                overlap += (hi - lo).total_seconds() / 60.0
        total += max(0.0, gap - overlap)
    return total


def labor_stats(conn, biz_date, user_id=None):
    """按人 × 工种统计当天作业量（拣货 / 复核分开）。

    口径（已与用户确认）：
      - 日期归属：作业时间日期（拣货看 pick_time、复核看 check_time）
      - 行数：该人当天拣/复核的行数（分开计数，不合计）
      - 有效作业小时：该人该工种当天作业记录覆盖的「小时数」（每出现 1 个小时算 1h）
      - 人效 = 行数 ÷ 有效作业小时（行/小时）
      - 人工校正：labor_adjust 里按 (人, 工种) 填的小时优先；role='all' 的老数据同时覆盖两种工种
    """
    people = {}
    hourly = {}
    role_stats = {}

    def slot(person):
        return people.setdefault(
            person,
            {
                "person": person,
                "pick_rows": 0, "pick_groups": 0, "pick_hours": 0.0,
                "pick_adjusted": None, "pick_rate": None,
                "check_rows": 0, "check_groups": 0, "check_hours": 0.0,
                "check_adjusted": None, "check_rate": None,
            },
        )

    gap_cap = labor_gap_minutes(conn)
    breaks = work_break_ranges(conn, biz_date)

    for role in ("pick", "check"):
        sql, params = work_lines_sql(conn, biz_date, user_id, role)
        person_expr = "pick_person" if role == "pick" else "check_person"
        time_expr = "pick_time" if role == "pick" else "check_time"
        rows = conn.execute(
            "SELECT %s AS person, COUNT(*) AS rows, "
            "COUNT(DISTINCT group_no) AS groups "
            "FROM (%s) f GROUP BY person" % (person_expr, sql),
            params,
        ).fetchall()
        # 取每个人的作业时间点，按"相邻间隔累计 → 扣除休息时段"算有效工时
        time_rows = conn.execute(
            "SELECT %s AS person, %s AS t FROM (%s) f ORDER BY person, t"
            % (person_expr, time_expr, sql),
            params,
        ).fetchall()
        per_person = {}
        for tr in time_rows:
            point = _parse_dt(tr["t"])
            if point is None:
                continue
            per_person.setdefault(tr["person"], []).append(point)
        for row in rows:
            item = slot(row["person"])
            item[role + "_rows"] = row["rows"] or 0
            item[role + "_groups"] = row["groups"] or 0
            minutes = work_minutes(per_person.get(row["person"], []), gap_cap, breaks)
            item[role + "_hours"] = round(minutes / 60.0, 4)

        total = conn.execute(
            "SELECT COUNT(*) AS rows, COUNT(DISTINCT group_no) AS groups, "
            "COUNT(DISTINCT %s) AS people FROM (%s) f" % (person_expr, sql),
            params,
        ).fetchone()
        role_stats[role] = {
            "rows": total["rows"] or 0,
            "groups": total["groups"] or 0,
            "people": total["people"] or 0,
        }

        got = conn.execute(
            "SELECT substr(%s,12,2) AS h, COUNT(*) AS n, COUNT(DISTINCT %s) AS p "
            "FROM (%s) f GROUP BY h" % (time_expr, person_expr, sql),
            params,
        ).fetchall()
        for row in got:
            hour = row["h"] or "未记录"
            bucket = hourly.setdefault(
                hour, {"hour": hour, "pick_rows": 0, "check_rows": 0,
                       "pick_people": 0, "check_people": 0}
            )
            bucket[role + "_rows"] = row["n"] or 0
            bucket[role + "_people"] = row["p"] or 0

    adjust = {}
    for row in conn.execute(
        "SELECT person, role, hours FROM labor_adjust WHERE biz_date=? AND hours IS NOT NULL",
        (biz_date,),
    ):
        adjust[(row["person"], row["role"])] = float(row["hours"])

    result = []
    for item in people.values():
        for role in ("pick", "check"):
            rows_count = item[role + "_rows"]
            auto = item[role + "_hours"]
            adjusted = adjust.get((item["person"], role))
            if adjusted is None:
                adjusted = adjust.get((item["person"], "all"))
            used = adjusted if adjusted is not None else auto
            item[role + "_adjusted"] = adjusted
            item[role + "_hours_auto"] = round(auto, 2)
            item[role + "_hours"] = round(used, 2)
            item[role + "_rate"] = (
                round(rows_count / used, 1) if used and used > 0 and rows_count else None
            )
        item["rows"] = item["pick_rows"] + item["check_rows"]
        result.append(item)
    result.sort(key=lambda x: (x["rows"], x["check_rows"], x["pick_rows"]), reverse=True)

    def sum_role(role, key):
        return round(sum(item[role + "_" + key] for item in result), 2) if key.startswith("hours") \
            else sum(item[role + "_" + key] for item in result)

    totals = {
        "people": len(result),
        "rows": sum(item["rows"] for item in result),
        "pick_rows": role_stats["pick"]["rows"],
        "check_rows": role_stats["check"]["rows"],
        "pick_groups": role_stats["pick"]["groups"],
        "check_groups": role_stats["check"]["groups"],
        "pick_people": role_stats["pick"]["people"],
        "check_people": role_stats["check"]["people"],
        "pick_hours": round(sum(item["pick_hours"] for item in result), 2),
        "check_hours": round(sum(item["check_hours"] for item in result), 2),
    }
    totals["pick_rate"] = (
        round(totals["pick_rows"] / totals["pick_hours"], 1) if totals["pick_hours"] else None
    )
    totals["check_rate"] = (
        round(totals["check_rows"] / totals["check_hours"], 1) if totals["check_hours"] else None
    )

    hourly_list = [hourly[h] for h in sorted(hourly)]
    return {
        "biz_date": biz_date,
        "date": biz_date,
        "rows": result,
        "totals": totals,
        "hourly": hourly_list,
    }


def labor_archive_rows(conn, biz_date, user_id=None):
    """把 labor_stats 摊平成 (person, role) 行，供归档使用。"""
    data = labor_stats(conn, biz_date, user_id)
    rows = []
    for item in data["rows"]:
        for role in ("pick", "check"):
            rows.append(
                {
                    "person": item["person"],
                    "role": role,
                    "rows": item[role + "_rows"],
                    "groups": item[role + "_groups"],
                    "hours_auto": item[role + "_hours_auto"],
                    "hours_used": item[role + "_hours"],
                    "rate": item[role + "_rate"],
                }
            )
    return rows


def labor_archive_stats(conn, biz_date):
    """归档口径的人工作业量：结构与 labor_stats 一致（小时趋势为空）。"""
    rows = labor_archive_get(conn, biz_date)
    people = {}
    meta = rows[0]["archived_at"] if rows else None
    for row in rows:
        item = people.setdefault(
            row["person"],
            {
                "person": row["person"],
                "pick_rows": 0, "pick_groups": 0, "pick_hours": 0.0,
                "pick_hours_auto": 0.0, "pick_adjusted": None, "pick_rate": None,
                "check_rows": 0, "check_groups": 0, "check_hours": 0.0,
                "check_hours_auto": 0.0, "check_adjusted": None, "check_rate": None,
            },
        )
        role = row["role"]
        if role not in ("pick", "check"):
            continue
        item[role + "_rows"] = row["rows"] or 0
        item[role + "_groups"] = row["groups"] or 0
        item[role + "_hours"] = row["hours_used"] or 0
        item[role + "_hours_auto"] = row["hours_auto"] or 0
        item[role + "_rate"] = row["rate"]
    result = sorted(
        people.values(), key=lambda x: (x["pick_rows"] + x["check_rows"]), reverse=True
    )
    for item in result:
        item["rows"] = item["pick_rows"] + item["check_rows"]
    totals = {
        "people": len(result),
        "rows": sum(item["rows"] for item in result),
        "pick_rows": sum(item["pick_rows"] for item in result),
        "check_rows": sum(item["check_rows"] for item in result),
        "pick_groups": sum(item["pick_groups"] for item in result),
        "check_groups": sum(item["check_groups"] for item in result),
        "pick_people": sum(1 for item in result if item["pick_rows"]),
        "check_people": sum(1 for item in result if item["check_rows"]),
        "pick_hours": round(sum(item["pick_hours"] for item in result), 2),
        "check_hours": round(sum(item["check_hours"] for item in result), 2),
    }
    totals["pick_rate"] = (
        round(totals["pick_rows"] / totals["pick_hours"], 1) if totals["pick_hours"] else None
    )
    totals["check_rate"] = (
        round(totals["check_rows"] / totals["check_hours"], 1) if totals["check_hours"] else None
    )
    return {
        "biz_date": biz_date,
        "date": biz_date,
        "mode": "archive",
        "rows": result,
        "hourly": [],
        "totals": totals,
        "archived_at": meta,
        "archived_rows": len(rows),
    }


def labor_archive_dates(conn):
    return [
        {"biz_date": r["biz_date"], "rows": r["n"], "archived_at": r["ts"]}
        for r in conn.execute(
            "SELECT biz_date, COUNT(*) AS n, MAX(archived_at) AS ts FROM labor_archive "
            "GROUP BY biz_date ORDER BY biz_date DESC"
        )
    ]


def labor_archive_get(conn, biz_date):
    return [
        dict(r)
        for r in conn.execute(
            "SELECT * FROM labor_archive WHERE biz_date=? ORDER BY role, rows DESC", (biz_date,)
        )
    ]


# ---------------------------------------------------------------- 线路完成情况（预警用）
def route_completion(conn, biz_date, user_id=None):
    """按线路的复核完成率（按行数），预警引擎与看板共用。"""
    gsql, gp = groups_sql(conn, biz_date, user_id)
    rows = conn.execute(
        "SELECT COALESCE(route,'未映射') AS route, COUNT(*) AS groups, "
        "COALESCE(SUM(lines),0) AS lines, COALESCE(SUM(checked),0) AS checked "
        "FROM (%s) g GROUP BY route ORDER BY lines DESC" % gsql,
        gp,
    ).fetchall()
    result = []
    for r in rows:
        lines = r["lines"] or 0
        checked = r["checked"] or 0
        result.append(
            {
                "route": r["route"],
                "groups": r["groups"] or 0,
                "lines": lines,
                "checked": checked,
                "remaining": max(0, lines - checked),
                "rate": (checked / lines) if lines else 0.0,
                "done": lines > 0 and checked >= lines,
            }
        )
    return result


def kpi(conn, biz_date, user_id=None, with_amount=True):
    gsql, gp = groups_sql(conn, biz_date, user_id)
    row = conn.execute(
        "SELECT COUNT(*) AS groups, "
        "COALESCE(SUM(lines),0) AS lines, COALESCE(SUM(amount),0) AS amount, "
        "COALESCE(SUM(picked),0) AS picked, COALESCE(SUM(checked),0) AS checked, "
        "COALESCE(SUM(out_lines),0) AS out_lines, "
        "COALESCE(SUM(CASE WHEN out_lines >= lines THEN 1 ELSE 0 END),0) AS ship_groups "
        "FROM (%s) g" % gsql,
        gp,
    ).fetchone()
    waves = registered_waves(conn, biz_date)
    pending_list = pending_waves(conn, biz_date)
    tms = tms_wave_set(conn)
    lines = row["lines"] or 0
    groups = row["groups"] or 0
    out_lines = row["out_lines"] or 0
    result = {
        "groups": groups,
        "lines": lines,
        "picked": row["picked"] or 0,
        "checked": row["checked"] or 0,
        "out": out_lines,
        "out_rate": (out_lines / lines) if lines else 0.0,
        "picked_rate": ((row["picked"] or 0) / lines) if lines else 0.0,
        "checked_rate": ((row["checked"] or 0) / lines) if lines else 0.0,
        "ship_groups": row["ship_groups"] or 0,
        "ship_rate": ((row["ship_groups"] or 0) / groups) if groups else 0.0,
        "waves": len(waves),
        "pending_waves": len(pending_list),
        "tms_waves": sum(1 for w in waves if w in tms),
        "tms_rate": (sum(1 for w in waves if w in tms) / len(waves)) if waves else 0.0,
        "pending": lines - out_lines,
    }
    if with_amount:
        result["amount"] = row["amount"] or 0.0
    return result


def previous_biz_date(conn, biz_date):
    row = conn.execute(
        "SELECT biz_date FROM wave_registry WHERE deleted_at IS NULL AND biz_date < ? "
        "GROUP BY biz_date ORDER BY biz_date DESC LIMIT 1",
        (biz_date,),
    ).fetchone()
    return row["biz_date"] if row else None


# ---------------------------------------------------------------- 总览
def overview(conn, biz_date, user_id=None, with_amount=True):
    k = kpi(conn, biz_date, user_id, with_amount)
    prev_date = previous_biz_date(conn, biz_date)
    prev = kpi(conn, prev_date, user_id, with_amount) if prev_date else None

    line_sql, params = lines_sql(conn, biz_date, user_id)

    status_rows = conn.execute(
        "SELECT COALESCE(status,'未知') AS label, COUNT(*) AS value FROM (%s) "
        "GROUP BY label ORDER BY value DESC" % line_sql,
        params,
    ).fetchall()

    hour_rows = conn.execute(
        "SELECT substr(pick_time,12,2) AS h, COUNT(*) AS c FROM (%s) "
        "WHERE pick_time IS NOT NULL AND pick_time<>'' GROUP BY h" % line_sql,
        params,
    ).fetchall()
    hour_out = conn.execute(
        "SELECT substr(out_time,12,2) AS h, COUNT(*) AS c FROM (%s) "
        "WHERE out_time IS NOT NULL AND out_time<>'' GROUP BY h" % line_sql,
        params,
    ).fetchall()
    hours = sorted({r["h"] for r in hour_rows if r["h"]} | {r["h"] for r in hour_out if r["h"]})
    pick_map = {r["h"]: r["c"] for r in hour_rows}
    out_map = {r["h"]: r["c"] for r in hour_out}

    route_rows = conn.execute(
        "SELECT COALESCE(route,'未映射') AS label, COUNT(*) AS lines, COALESCE(SUM(amount),0) AS amount "
        "FROM (%s) GROUP BY label ORDER BY lines DESC" % line_sql,
        params,
    ).fetchall()
    zone_rows = conn.execute(
        "SELECT COALESCE(zone,'未映射') AS label, COUNT(*) AS lines, COALESCE(SUM(amount),0) AS amount "
        "FROM (%s) GROUP BY label ORDER BY lines DESC" % line_sql,
        params,
    ).fetchall()

    funnel = [
        {"label": "波次生成", "value": k["lines"]},
        {"label": "已拣货", "value": k["picked"]},
        {"label": "已复核", "value": k["checked"]},
        {"label": "已出库", "value": k["out"]},
    ]

    result = {
        "biz_date": biz_date,
        "kpi": k,
        "prev": prev,
        "prev_date": prev_date,
        "data_range": data_range(conn),
        "status": [{"label": r["label"], "value": r["value"]} for r in status_rows],
        "funnel": funnel,
        "hourly": {
            "categories": hours,
            "series": [
                {"name": "拣货行数", "values": [pick_map.get(h, 0) for h in hours]},
                {"name": "出库行数", "values": [out_map.get(h, 0) for h in hours]},
            ],
        },
        "routes": {
            "categories": [r["label"] for r in route_rows],
            "series": [{"name": "行数", "values": [r["lines"] for r in route_rows]}],
        },
        "zones": {
            "categories": [r["label"] for r in zone_rows],
            "series": [{"name": "行数", "values": [r["lines"] for r in zone_rows]}],
        },
    }
    if with_amount:
        result["routes"]["series"].append(
            {"name": "金额(万元)", "values": [round((r["amount"] or 0) / 10000.0, 2) for r in route_rows]}
        )
        result["zones"]["series"].append(
            {"name": "金额(万元)", "values": [round((r["amount"] or 0) / 10000.0, 2) for r in zone_rows]}
        )
    return result


# ---------------------------------------------------------------- 作业进度
def progress(conn, biz_date, user_id=None, with_amount=True, cutoff="16:00"):
    gsql, gp = groups_sql(conn, biz_date, user_id)

    wave_rows = conn.execute(
        "SELECT wave_no, COUNT(*) AS groups, COALESCE(SUM(lines),0) AS lines, "
        "COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(picked),0) AS picked, "
        "COALESCE(SUM(checked),0) AS checked, COALESCE(SUM(out_lines),0) AS out_lines, "
        "MAX(tms_status) AS tms_status, MAX(tms_carrier) AS tms_carrier, MAX(note) AS note "
        "FROM (%s) g GROUP BY wave_no ORDER BY wave_no" % gsql,
        gp,
    ).fetchall()

    waves = []
    registered = set(registered_waves(conn, biz_date))
    for r in wave_rows:
        waves.append(
            {
                "wave_no": r["wave_no"],
                "groups": r["groups"],
                "lines": r["lines"],
                "amount": round((r["amount"] or 0) / 10000.0, 2) if with_amount else None,
                "picked": r["picked"],
                "checked": r["checked"],
                "out": r["out_lines"],
                "rate": (r["out_lines"] / r["lines"]) if r["lines"] else 0.0,
                "done": r["out_lines"] >= r["lines"],
                "tms_status": r["tms_status"],
                "tms_carrier": r["tms_carrier"],
                "note": r["note"],
            }
        )
    seen = {w["wave_no"] for w in waves}
    for wave in registered - seen:
        has_data = wave_has_data(conn, wave)
        waves.append(
            {
                "wave_no": wave,
                "groups": 0,
                "lines": 0,
                "amount": 0.0 if with_amount else None,
                "picked": 0,
                "checked": 0,
                "out": 0,
                "rate": 0.0,
                "done": False,
                "tms_status": None,
                "tms_carrier": None,
                "note": None,
                "empty": True,
                "pending": not has_data,
                "excluded_all": has_data,
            }
        )

    route_rows = conn.execute(
        "SELECT COALESCE(route,'未映射') AS label, COUNT(*) AS groups, COALESCE(SUM(lines),0) AS lines, "
        "COALESCE(SUM(picked),0) AS picked, COALESCE(SUM(checked),0) AS checked, "
        "COALESCE(SUM(out_lines),0) AS out_lines, COALESCE(SUM(amount),0) AS amount "
        "FROM (%s) g GROUP BY label ORDER BY lines DESC" % gsql,
        gp,
    ).fetchall()

    now_str = db.now_str()
    after_cutoff = now_str[11:16] >= cutoff
    alert_rows = conn.execute(
        "SELECT group_no, wave_no, dealer_short, route, zone, lines, out_lines, amount, "
        "tms_status, tms_carrier, wave_time FROM (%s) g "
        "WHERE out_lines < lines ORDER BY (lines - out_lines) DESC LIMIT 50" % gsql,
        gp,
    ).fetchall()

    line_sql, lp = lines_sql(conn, biz_date, user_id)
    timing = conn.execute(
        "SELECT AVG((julianday(out_time) - julianday(wave_time)) * 24.0) AS avg_h, "
        "MAX(out_time) AS last_out, MAX(wave_time) AS last_wave_time "
        "FROM (%s) WHERE out_time IS NOT NULL AND out_time<>'' "
        "AND wave_time IS NOT NULL AND wave_time<>''" % line_sql,
        lp,
    ).fetchone()
    duration_rows = conn.execute(
        "SELECT (julianday(out_time) - julianday(wave_time)) * 24.0 AS h FROM (%s) "
        "WHERE out_time IS NOT NULL AND out_time<>'' "
        "AND wave_time IS NOT NULL AND wave_time<>''" % line_sql,
        lp,
    ).fetchall()
    durations = sorted(r["h"] for r in duration_rows if r["h"] is not None and r["h"] >= 0)
    median_hours = durations[len(durations) // 2] if durations else 0.0

    return {
        "biz_date": biz_date,
        "waves": waves,
        "routes": [
            {
                "label": r["label"],
                "groups": r["groups"],
                "lines": r["lines"],
                "picked": r["picked"],
                "checked": r["checked"],
                "out": r["out_lines"],
                "rate": (r["out_lines"] / r["lines"]) if r["lines"] else 0.0,
                "amount": round((r["amount"] or 0) / 10000.0, 2) if with_amount else None,
            }
            for r in route_rows
        ],
        "alerts": [
            {
                "group_no": r["group_no"],
                "wave_no": r["wave_no"],
                "dealer": r["dealer_short"],
                "route": r["route"],
                "zone": r["zone"],
                "lines": r["lines"],
                "out": r["out_lines"],
                "remaining": r["lines"] - r["out_lines"],
                "amount": round((r["amount"] or 0) / 10000.0, 2) if with_amount else None,
                "tms_status": r["tms_status"],
                "tms_carrier": r["tms_carrier"],
                "wave_time": r["wave_time"],
            }
            for r in alert_rows
        ],
        "unfinished": [
            {
                "group_no": r["group_no"],
                "wave_no": r["wave_no"],
                "dealer": r["dealer_short"],
                "route": r["route"],
                "lines": r["lines"],
                "remaining": r["lines"] - r["out_lines"],
                "tms_status": r["tms_status"],
            }
            for r in alert_rows[:20]
        ],
        "timing": {
            "avg_hours": round(timing["avg_h"] or 0, 2),
            "median_hours": round(median_hours, 2),
            "last_out": timing["last_out"],
            "last_wave_time": timing["last_wave_time"],
            "cutoff": cutoff,
            "after_cutoff": after_cutoff,
            "alert_count": len(alert_rows),
        },
        "tms": {
            "registered": len(registered),
            "matched": sum(1 for w in registered if w in tms_wave_set(conn)),
            "unmatched": sorted(w for w in registered if w not in tms_wave_set(conn)),
        },
    }


# ---------------------------------------------------------------- 单量分析
def volume(conn, biz_date, user_id=None, with_amount=True):
    gsql, gp = groups_sql(conn, biz_date, user_id)

    def breakdown(dim):
        rows = conn.execute(
            "SELECT COALESCE(%s,'未映射') AS label, COUNT(*) AS groups, "
            "COALESCE(SUM(lines),0) AS lines, COALESCE(SUM(amount),0) AS amount "
            "FROM (%s) g GROUP BY label ORDER BY lines DESC" % (DIM_EXPR.get(dim, dim), gsql),
            gp,
        ).fetchall()
        series = [{"name": "行数", "values": [r["lines"] for r in rows]}]
        if with_amount:
            series.append(
                {"name": "金额(万元)", "values": [round((r["amount"] or 0) / 10000.0, 2) for r in rows]}
            )
        return {
            "categories": [r["label"] for r in rows],
            "series": series,
            "groups": [r["groups"] for r in rows],
        }

    detail_rows = conn.execute(
        "SELECT group_no, wave_no, dealer_short, route, zone, region, doc_type, lines, amount, "
        "picked, checked, out_lines, tms_status FROM (%s) g "
        "ORDER BY lines DESC LIMIT 300" % gsql,
        gp,
    ).fetchall()

    totals = conn.execute(
        "SELECT COUNT(*) AS groups, COALESCE(SUM(lines),0) AS lines, COALESCE(SUM(amount),0) AS amount "
        "FROM (%s) g" % gsql,
        gp,
    ).fetchone()

    return {
        "biz_date": biz_date,
        "totals": {
            "groups": totals["groups"],
            "lines": totals["lines"],
            "amount": round((totals["amount"] or 0) / 10000.0, 2) if with_amount else None,
        },
        "by_route": breakdown("route"),
        "by_zone": breakdown("zone"),
        "by_region": breakdown("region"),
        "by_doc_type": breakdown("doc_type"),
        "top_dealers": breakdown("dealer"),
        "detail": [
            {
                "group_no": r["group_no"],
                "wave_no": r["wave_no"],
                "dealer": r["dealer_short"],
                "route": r["route"],
                "zone": r["zone"],
                "region": r["region"],
                "doc_type": r["doc_type"],
                "lines": r["lines"],
                "amount": round((r["amount"] or 0) / 10000.0, 2) if with_amount else None,
                "progress": (r["out_lines"] / r["lines"]) if r["lines"] else 0.0,
                "tms_status": r["tms_status"],
            }
            for r in detail_rows
        ],
    }


def orders_page(conn, biz_date, user_id=None, with_amount=True, q="", route="", zone="",
                page=1, size=50):
    gsql, gp = groups_sql(conn, biz_date, user_id)
    conds = []
    params = list(gp)
    if q:
        conds.append("(group_no LIKE ? OR dealer_short LIKE ? OR wave_no LIKE ?)")
        like = "%" + q + "%"
        params.extend([like, like, like])
    if route:
        conds.append("COALESCE(route,'未映射') = ?")
        params.append(route)
    if zone:
        conds.append("COALESCE(zone,'未映射') = ?")
        params.append(zone)
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    total = conn.execute("SELECT COUNT(*) AS c FROM (%s) g%s" % (gsql, where), params).fetchone()["c"]
    size = max(1, min(int(size or 50), 500))
    page = max(1, int(page or 1))
    rows = conn.execute(
        "SELECT group_no, wave_no, dealer_short, route, zone, region, doc_type, lines, amount, "
        "picked, checked, out_lines, tms_status FROM (%s) g%s ORDER BY lines DESC LIMIT ? OFFSET ?"
        % (gsql, where),
        params + [size, (page - 1) * size],
    ).fetchall()
    return {
        "total": total,
        "page": page,
        "size": size,
        "rows": [
            {
                "group_no": r["group_no"],
                "wave_no": r["wave_no"],
                "dealer": r["dealer_short"],
                "route": r["route"],
                "zone": r["zone"],
                "region": r["region"],
                "doc_type": r["doc_type"],
                "lines": r["lines"],
                "amount": round((r["amount"] or 0) / 10000.0, 2) if with_amount else None,
                "picked": r["picked"],
                "checked": r["checked"],
                "out": r["out_lines"],
                "progress": (r["out_lines"] / r["lines"]) if r["lines"] else 0.0,
                "tms_status": r["tms_status"],
            }
            for r in rows
        ],
    }


# ---------------------------------------------------------------- 订单组台账
def archive_meta(conn, biz_date):
    row = conn.execute(
        "SELECT MAX(archived_at) AS ts, COUNT(*) AS n FROM daily_archive WHERE biz_date=?",
        (biz_date,),
    ).fetchone()
    return {"archived_at": row["ts"], "archived_rows": row["n"] or 0}


def group_label(group_no):
    """订单组号的展示文案：导出没填组号的行按 wms 单号成组，显示为"未编号"。"""
    text = str(group_no or "")
    if text.startswith("NOGROUP-"):
        return "未编号（%s）" % text[len("NOGROUP-"):]
    return text


ERP_RANK_LABEL = {3: "回传ERP失败", 2: "未回传ERP", 1: "回传ERP成功", 0: "未记录"}


def order_groups(conn, biz_date, user_id=None, with_amount=True, mode="live",
                 wave="", route="", region="", q="", included="all",
                 sort="reg", page=1, size=100, erp=None):
    """订单组台账：字段与现行《单据登记表》一致，默认按波次登记顺序。"""
    try:
        size = int(size or 100)
    except (TypeError, ValueError):
        size = 100
    size = max(1, min(size, 1000))
    try:
        page = max(1, int(page or 1))
    except (TypeError, ValueError):
        page = 1
    offset = (page - 1) * size

    if mode == "archive":
        return _order_groups_archive(
            conn, biz_date, with_amount, wave, route, region, q, included,
            sort, page, size, offset,
        )

    gsql, gp = groups_sql(conn, biz_date, user_id, include_excluded=True)
    conds, extra = [], []
    if wave:
        conds.append("g.wave_no = ?")
        extra.append(wave)
    if route:
        conds.append("COALESCE(g.route,'未映射') = ?")
        extra.append(route)
    if region:
        conds.append("COALESCE(g.region,'未映射') = ?")
        extra.append(region)
    if str(included) in ("1", "0"):
        conds.append("COALESCE(g.include_flag,1) = ?")
        extra.append(int(included))
    if q:
        conds.append("(g.group_no LIKE ? OR g.dealer_short LIKE ? OR g.wave_no LIKE ?)")
        like = "%" + q + "%"
        extra.extend([like, like, like])
    if erp == "failed":
        conds.append("COALESCE(g.erp_rank,0) >= 3")
    elif erp == "missing":
        conds.append("COALESCE(g.erp_rank,0) = 2")

    params = list(gp) + extra
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    base = "SELECT * FROM (%s) g%s" % (gsql, where)
    total = conn.execute("SELECT COUNT(*) AS c FROM (%s) t" % base, params).fetchone()["c"]
    agg = conn.execute(
        "SELECT COALESCE(SUM(lines),0) AS lines, COALESCE(SUM(amount),0) AS amount "
        "FROM (%s) t" % base, params,
    ).fetchone()
    order = "COALESCE(wave_reg_id, 999999), lines DESC, group_no" if sort != "wave" else "wave_no, lines DESC, group_no"
    rows = conn.execute(
        "%s ORDER BY %s LIMIT ? OFFSET ?" % (base, order), params + [size, offset]
    ).fetchall()

    items = []
    for idx, r in enumerate(rows):
        items.append(
            {
                "seq": offset + idx + 1,
                "group_no": r["group_no"],
                "group_no_label": group_label(r["group_no"]),
                "dealer": r["dealer_short"],
                "lines": r["lines"],
                "amount": round(float(r["amount"] or 0), 2) if with_amount else None,
                "zone": r["zone"],
                "doc_type": r["doc_type"],
                "freight_free": r["freight_free"],
                "region": r["region"],
                "route": r["route"],
                "wave_no": r["wave_no"],
                "tms_status": r["tms_status"],
                "assignee": r["assignee"],
                "note": r["group_note"],
                "included": int(r["include_flag"]) if r["include_flag"] is not None else 1,
                "progress": (r["out_lines"] / r["lines"]) if r["lines"] else 0.0,
                "erp_status": ERP_RANK_LABEL.get(int(r["erp_rank"] or 0), "未记录"),
                "erp_message": r["erp_message"],
                "erp_time": r["erp_time"],
                "erp_required": r["erp_required"],
                "erp_failed_lines": r["erp_failed_lines"] or 0,
                "erp_missing_lines": r["erp_missing_lines"] or 0,
            }
        )
    meta = archive_meta(conn, biz_date)
    return {
        "mode": "live",
        "biz_date": biz_date,
        "total": total,
        "page": page,
        "size": size,
        "summary": {
            "groups": total,
            "lines": agg["lines"] or 0,
            "amount": round(float(agg["amount"] or 0), 2) if with_amount else None,
        },
        "rows": items,
        "archived_at": meta["archived_at"],
        "archive_rows": meta["archived_rows"],
    }


def erp_detail(conn, biz_date, user_id=None, status="failed", with_amount=True, limit=300):
    """回传失败 / 未回传的订单组明细，列与「订单组登记」一致 + ERP 状态/信息。"""
    status = "missing" if status == "missing" else "failed"
    try:
        size = max(1, min(int(limit or 300), 500))
    except (TypeError, ValueError):
        size = 300
    data = order_groups(
        conn, biz_date, user_id, with_amount, mode="live", erp=status,
        sort="reg", page=1, size=size,
    )
    rows = []
    for item in data.get("rows") or []:
        rows.append(
            {
                "seq": item["seq"],
                "group_no": item.get("group_no_label") or item["group_no"],
                "dealer": item["dealer"],
                "lines": item["lines"],
                "amount": item["amount"],
                "zone": item["zone"],
                "doc_type": item["doc_type"],
                "freight_free": item["freight_free"],
                "region": item["region"],
                "route": item["route"],
                "wave_no": item["wave_no"],
                "tms_status": item["tms_status"],
                "assignee": item["assignee"],
                "erp_status": item["erp_status"],
                "erp_lines": item["erp_failed_lines"] if status == "failed" else item["erp_missing_lines"],
                "erp_message": item["erp_message"],
                "erp_time": item["erp_time"],
            }
        )
    return {
        "total": data.get("total") or 0,
        "rows": rows,
        "summary": data.get("summary") or {},
        "status": status,
    }


def _order_groups_archive(conn, biz_date, with_amount, wave, route, region, q,
                          included, sort, page, size, offset):
    conds = ["biz_date = ?"]
    params = [biz_date]
    if wave:
        conds.append("wave_no = ?")
        params.append(wave)
    if route:
        conds.append("COALESCE(route,'未映射') = ?")
        params.append(route)
    if region:
        conds.append("COALESCE(region,'未映射') = ?")
        params.append(region)
    if str(included) in ("1", "0"):
        conds.append("included = ?")
        params.append(int(included))
    if q:
        conds.append("(group_no LIKE ? OR dealer_short LIKE ? OR wave_no LIKE ?)")
        like = "%" + q + "%"
        params.extend([like, like, like])
    where = " WHERE " + " AND ".join(conds)
    total = conn.execute(
        "SELECT COUNT(*) AS c FROM daily_archive" + where, params
    ).fetchone()["c"]
    agg = conn.execute(
        "SELECT COALESCE(SUM(lines),0) AS lines, COALESCE(SUM(amount),0) AS amount "
        "FROM daily_archive" + where, params,
    ).fetchone()
    order = "seq" if sort != "wave" else "wave_no, seq"
    rows = conn.execute(
        "SELECT * FROM daily_archive" + where + " ORDER BY %s LIMIT ? OFFSET ?" % order,
        params + [size, offset],
    ).fetchall()
    items = []
    for idx, r in enumerate(rows):
        items.append(
            {
                "seq": r["seq"] if r["seq"] else offset + idx + 1,
                "group_no": r["group_no"],
                "group_no_label": group_label(r["group_no"]),
                "dealer": r["dealer_short"],
                "lines": r["lines"],
                "amount": round(float(r["amount"] or 0), 2) if with_amount else None,
                "zone": r["zone"],
                "doc_type": r["doc_type"],
                "freight_free": r["freight_free"],
                "region": r["region"],
                "route": r["route"],
                "wave_no": r["wave_no"],
                "tms_status": r["tms_status"],
                "assignee": r["assignee"],
                "note": r["note"],
                "included": int(r["included"] if r["included"] is not None else 1),
                "progress": 0.0,
            }
        )
    meta = archive_meta(conn, biz_date)
    return {
        "mode": "archive",
        "biz_date": biz_date,
        "total": total,
        "page": page,
        "size": size,
        "summary": {
            "groups": total,
            "lines": agg["lines"] or 0,
            "amount": round(float(agg["amount"] or 0), 2) if with_amount else None,
        },
        "rows": items,
        "archived_at": meta["archived_at"],
        "archive_rows": meta["archived_rows"],
    }


# ---------------------------------------------------------------- 趋势
def trend(conn, days=30):
    rows = conn.execute(
        "SELECT biz_date, groups, lines, amount, waves, out_rate, ship_rate "
        "FROM daily_snapshot ORDER BY biz_date DESC LIMIT ?",
        (max(1, min(int(days or 30), 365)),),
    ).fetchall()
    rows = list(reversed(rows))
    return {
        "dates": [r["biz_date"] for r in rows],
        "groups": [r["groups"] for r in rows],
        "lines": [r["lines"] for r in rows],
        "amount": [round((r["amount"] or 0) / 10000.0, 2) for r in rows],
        "waves": [r["waves"] for r in rows],
        "out_rate": [r["out_rate"] for r in rows],
        "ship_rate": [r["ship_rate"] for r in rows],
    }


def rebuild_snapshots(conn):
    """为所有已登记业务日刷新每日快照。"""
    dates = [
        r["biz_date"]
        for r in conn.execute(
            "SELECT DISTINCT biz_date FROM wave_registry WHERE deleted_at IS NULL ORDER BY biz_date"
        )
    ]
    for biz_date in dates:
        k = kpi(conn, biz_date, None, True)
        conn.execute(
            "INSERT INTO daily_snapshot(biz_date, groups, lines, amount, waves, out_rate, ship_rate, payload, built_at) "
            "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(biz_date) DO UPDATE SET "
            "groups=excluded.groups, lines=excluded.lines, amount=excluded.amount, waves=excluded.waves, "
            "out_rate=excluded.out_rate, ship_rate=excluded.ship_rate, payload=excluded.payload, "
            "built_at=excluded.built_at",
            (
                biz_date, k["groups"], k["lines"], k["amount"], k["waves"],
                k["out_rate"], k["ship_rate"], json.dumps(k, ensure_ascii=False), db.now_str(),
            ),
        )
    return dates


# ---------------------------------------------------------------- 单量表矩阵
ZONE_ORDER = ["A/Q", "A", "Q", "B", "C", "D", "E", "F"]


def _zone_sort_key(zone):
    try:
        return (ZONE_ORDER.index(zone), "")
    except ValueError:
        return (len(ZONE_ORDER), zone or "")


def summary_matrix(conn, biz_date, user_id=None, with_amount=True):
    """承运商/线路 × 库区 的交叉表，用于打印版单量表与导出。"""
    gsql, gp = groups_sql(conn, biz_date, user_id)
    rows = conn.execute(
        "SELECT COALESCE(route,'未映射') AS route, COALESCE(zone,'未映射') AS zone, "
        "COALESCE(SUM(lines),0) AS lines, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS groups "
        "FROM (%s) g GROUP BY route, zone" % gsql,
        gp,
    ).fetchall()

    zones = sorted({r["zone"] for r in rows}, key=_zone_sort_key)
    by_route = {}
    zone_totals = {z: {"lines": 0, "amount": 0.0} for z in zones}
    grand = {"lines": 0, "amount": 0.0, "groups": 0}
    for r in rows:
        item = by_route.setdefault(
            r["route"], {"label": r["route"], "lines": 0, "amount": 0.0, "groups": 0, "cells": {}}
        )
        lines = r["lines"] or 0
        amount = r["amount"] or 0.0
        item["lines"] += lines
        item["amount"] += amount
        item["groups"] += r["groups"] or 0
        item["cells"][r["zone"]] = {"lines": lines, "amount": amount}
        zone_totals[r["zone"]]["lines"] += lines
        zone_totals[r["zone"]]["amount"] += amount
        grand["lines"] += lines
        grand["amount"] += amount
        grand["groups"] += r["groups"] or 0

    routes = sorted(by_route.values(), key=lambda item: -item["lines"])
    for item in routes:
        item["amount"] = round(item["amount"] / 10000.0, 2) if with_amount else None
        for cell in item["cells"].values():
            cell["amount"] = round(cell["amount"] / 10000.0, 2) if with_amount else None
    return {
        "biz_date": biz_date,
        "routes": routes,
        "zones": zones,
        "zone_totals": {
            z: {
                "lines": v["lines"],
                "amount": round(v["amount"] / 10000.0, 2) if with_amount else None,
            }
            for z, v in zone_totals.items()
        },
        "totals": {
            "lines": grand["lines"],
            "groups": grand["groups"],
            "amount": round(grand["amount"] / 10000.0, 2) if with_amount else None,
        },
        "with_amount": with_amount,
    }


# ---------------------------------------------------------------- 汇总包
def dashboard_bundle(conn, biz_date, user_id, with_amount=True):
    """一次返回总览 + 状态分布（用于 CLI 复算与总览页）。"""
    data = overview(conn, biz_date, user_id, with_amount)
    data["status"] = data["status"]
    return data


def biz_dates(conn):
    """日期选择器用的日期清单：今天 + 已登记 + 已存档 + 有发运数据的日期，倒序。

    关键点：即使今天还没登记，也要出现在列表里——否则用户只能选到"上次登记的日期"，
    新一天的登记会全部记到旧日期上（历史 bug）。
    """
    today = db.today_str()
    bucket = {}

    def slot(day):
        return bucket.setdefault(
            day, {"biz_date": day, "waves": 0, "rows": 0, "archived": False,
                  "data_lines": 0, "labor_rows": 0, "labor_archived": False}
        )

    for r in conn.execute(
        "SELECT biz_date, COUNT(*) AS n FROM wave_registry WHERE deleted_at IS NULL GROUP BY biz_date"
    ):
        slot(r["biz_date"])["waves"] = r["n"]
    for r in conn.execute(
        "SELECT biz_date, COUNT(*) AS n FROM wave_registry WHERE deleted_at IS NOT NULL GROUP BY biz_date"
    ):
        # 只保留"有登记过但已全删"的痕迹，避免日期里出现毫无意义的空档
        slot(r["biz_date"])
    for r in conn.execute("SELECT biz_date, COUNT(*) AS n FROM daily_archive GROUP BY biz_date"):
        slot(r["biz_date"])["archived"] = True
    for r in conn.execute(
        "SELECT order_date AS d, COUNT(*) AS n FROM ship_lines "
        "WHERE order_date IS NOT NULL GROUP BY order_date"
    ):
        slot(r["d"])["data_lines"] = r["n"]
    # 人工作业量的日期锚点是"作业时间"，单独补进日期清单
    for r in conn.execute(
        "SELECT substr(pick_time,1,10) AS d, COUNT(*) AS n FROM ship_lines "
        "WHERE pick_time <> '' AND pick_person IS NOT NULL AND pick_person <> '' GROUP BY d"
    ):
        if r["d"]:
            slot(r["d"])["labor_rows"] += r["n"] or 0
    for r in conn.execute(
        "SELECT substr(check_time,1,10) AS d, COUNT(*) AS n FROM ship_lines "
        "WHERE check_time <> '' AND check_person IS NOT NULL AND check_person <> '' GROUP BY d"
    ):
        if r["d"]:
            slot(r["d"])["labor_rows"] += r["n"] or 0
    for r in conn.execute("SELECT biz_date, COUNT(*) AS n FROM labor_archive GROUP BY biz_date"):
        slot(r["biz_date"])["labor_archived"] = True
    slot(today)

    result = []
    for day in sorted(bucket, reverse=True):
        item = bucket[day]
        item["is_today"] = day == today
        result.append(item)
    return result


def default_biz_date(conn):
    """默认业务日 = 系统当天。

    登记必须落到"今天"，而不是"上一次登记的那天"——否则跨天时新登记会串到昨天。
    想回看历史，用顶部的业务日期选择器；列表里同时包含今天、已登记、已存档和有数据的日期。
    """
    return db.today_str()


# ---------------------------------------------------------------- 单量分析周期
def _as_date(value):
    from datetime import datetime as _dt
    return _dt.strptime(str(value or ""), "%Y-%m-%d").date()


def _shift_year(day, years=-1):
    try:
        return day.replace(year=day.year + years)
    except ValueError:
        return day.replace(year=day.year + years, day=28)


def volume_ranges(anchor, period="today"):
    """返回当前周期、环比周期、同比周期的日期范围。"""
    from datetime import timedelta
    day = _as_date(anchor)
    period = period if period in ("today", "week", "month", "quarter") else "today"
    if period == "today":
        start = end = day
        prev_start = prev_end = day - timedelta(days=1)
        yoy_start = yoy_end = _shift_year(day)
    elif period == "week":
        start = day - timedelta(days=day.weekday())
        end = start + timedelta(days=6)
        prev_start, prev_end = start - timedelta(days=7), end - timedelta(days=7)
        yoy_start, yoy_end = _shift_year(start), _shift_year(end)
    elif period == "month":
        start = day.replace(day=1)
        if start.month == 12:
            nxt = start.replace(year=start.year + 1, month=1, day=1)
        else:
            nxt = start.replace(month=start.month + 1, day=1)
        end = nxt - timedelta(days=1)
        prev_end = start - timedelta(days=1)
        prev_start = prev_end.replace(day=1)
        yoy_start = _shift_year(start)
        yoy_end = _shift_year(end)
    else:
        q = (day.month - 1) // 3
        start = day.replace(month=q * 3 + 1, day=1)
        if q == 3:
            nxt = start.replace(year=start.year + 1, month=1, day=1)
        else:
            nxt = start.replace(month=start.month + 3, day=1)
        end = nxt - timedelta(days=1)
        prev_end = start - timedelta(days=1)
        prev_start = prev_end.replace(month=((prev_end.month - 1) // 3) * 3 + 1, day=1)
        yoy_start = _shift_year(start)
        yoy_end = _shift_year(end)
    return {
        "period": period,
        "start": start.isoformat(), "end": end.isoformat(),
        "prev_start": prev_start.isoformat(), "prev_end": prev_end.isoformat(),
        "yoy_start": yoy_start.isoformat(), "yoy_end": yoy_end.isoformat(),
    }


def _period_base(conn, start, end, user_id):
    params = [start, start, start, end]
    conds = ["f.order_date BETWEEN ? AND ?"]
    # range 条件参数已经放在 base 的占位符中；scope 条件追加
    params = [start, start, start, end]  # wave / override 用锚点，range 用起止
    conds = ["1=1"]
    conds.extend(_scope_conds(conn, user_id, {}, params, include_excluded=True))
    sql = "SELECT f.* FROM (%s) f" % BASE_DAY.replace("WHERE s.order_date = ?", "WHERE s.order_date BETWEEN ? AND ?")
    if conds:
        sql += " WHERE " + " AND ".join(conds)
    return sql, params


def _period_totals(conn, start, end, user_id, with_amount=True):
    base, params = _period_base(conn, start, end, user_id)
    row = conn.execute(
        "SELECT COUNT(*) AS lines, COUNT(DISTINCT CASE WHEN COALESCE(TRIM(group_no_raw),'') <> '' "
        "THEN group_no END) AS groups, COALESCE(SUM(amount),0) AS amount FROM (%s) f" % base,
        params,
    ).fetchone()
    return {
        "lines": int(row["lines"] or 0),
        "groups": int(row["groups"] or 0),
        "amount": round((row["amount"] or 0) / 10000.0, 2) if with_amount else None,
    }


def _period_breakdown(conn, start, end, user_id, dim):
    base, params = _period_base(conn, start, end, user_id)
    expr = DIM_EXPR.get(dim, dim)
    rows = conn.execute(
        "SELECT COALESCE(%s,'未映射') AS label, COUNT(*) AS lines, "
        "COUNT(DISTINCT CASE WHEN COALESCE(TRIM(group_no_raw),'') <> '' THEN group_no END) AS groups, "
        "COALESCE(SUM(amount),0) AS amount FROM (%s) f GROUP BY label ORDER BY lines DESC" % (expr, base),
        params,
    ).fetchall()
    return {
        r["label"]: {
            "lines": int(r["lines"] or 0),
            "groups": int(r["groups"] or 0),
            "amount": round((r["amount"] or 0) / 10000.0, 2),
        }
        for r in rows
    }


def volume_period(conn, anchor, period="today", user_id=None, with_amount=True):
    ranges = volume_ranges(anchor, period)
    current = _period_totals(conn, ranges["start"], ranges["end"], user_id, with_amount)
    prev = _period_totals(conn, ranges["prev_start"], ranges["prev_end"], user_id, with_amount)
    yoy = _period_totals(conn, ranges["yoy_start"], ranges["yoy_end"], user_id, with_amount)
    dims = ["route", "zone", "region", "doc_type", "dealer"]
    breakdowns = {}
    for dim in dims:
        cur = _period_breakdown(conn, ranges["start"], ranges["end"], user_id, dim)
        old = _period_breakdown(conn, ranges["prev_start"], ranges["prev_end"], user_id, dim)
        year = _period_breakdown(conn, ranges["yoy_start"], ranges["yoy_end"], user_id, dim)
        labels = sorted(set(cur) | set(old) | set(year), key=lambda k: -(cur.get(k, {}).get("lines", 0)))
        breakdowns[dim] = [
            {
                "label": label,
                "lines": cur.get(label, {}).get("lines", 0),
                "groups": cur.get(label, {}).get("groups", 0),
                "amount": cur.get(label, {}).get("amount", 0),
                "prev_lines": old.get(label, {}).get("lines", 0),
                "prev_amount": old.get(label, {}).get("amount", 0),
                "yoy_lines": year.get(label, {}).get("lines", 0),
                "yoy_amount": year.get(label, {}).get("amount", 0),
            }
            for label in labels
        ]
    base, params = _period_base(conn, ranges["start"], ranges["end"], user_id)
    detail = conn.execute(
        "SELECT group_no, MAX(wave_no) AS wave_no, MAX(dealer_short) AS dealer_short, "
        "MAX(route) AS route, MAX(zone) AS zone, MAX(region) AS region, MAX(doc_type) AS doc_type, "
        "COUNT(*) AS lines, COALESCE(SUM(amount),0) AS amount FROM (%s) f "
        "WHERE COALESCE(TRIM(group_no_raw),'') <> '' GROUP BY group_no "
        "ORDER BY lines DESC LIMIT 300" % base,
        params,
    ).fetchall()
    return {
        "range": ranges,
        "totals": current,
        "prev": prev,
        "yoy": yoy,
        "breakdowns": breakdowns,
        "detail": [
            {
                "group_no": r["group_no"], "wave_no": r["wave_no"],
                "dealer": r["dealer_short"], "route": r["route"], "zone": r["zone"],
                "region": r["region"], "doc_type": r["doc_type"],
                "lines": int(r["lines"] or 0),
                "amount": round((r["amount"] or 0) / 10000.0, 2) if with_amount else None,
            }
            for r in detail
        ],
        "with_amount": with_amount,
    }
