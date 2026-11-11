# -*- coding: utf-8 -*-
"""动力电池登记：候选订单组 + 备件编码确认状态。"""
import csv
import io
import os
import re

from backend.core import db
from backend.collect import ingest


def _has_parts(conn):
    row = conn.execute("SELECT COUNT(*) AS c FROM battery_parts").fetchone()
    return bool(row and row["c"])


def _battery_filter(has_parts):
    if has_parts:
        return "EXISTS (SELECT 1 FROM battery_parts bp WHERE bp.part_code = s.part_code)"
    return "s.part_name = '动力电池总成'"


def _candidate_sql(conn):
    has_parts = _has_parts(conn)
    where = [
        "TRIM(COALESCE(s.group_no, '')) <> ''",
        "COALESCE(s.part_code, '') <> ''",
        "COALESCE(s.order_date, '') <> ''",
        _battery_filter(has_parts),
    ]
    join_parts = "LEFT JOIN battery_parts bp_name ON bp_name.part_code = s.part_code" if has_parts else ""
    outer_parts = "LEFT JOIN battery_parts bp_name ON bp_name.part_code = c.part_code"
    base = """
WITH cand AS (
  SELECT s.order_date, s.group_no, s.part_code,
         MAX(s.dealer_full) AS dealer_full,
         MAX(s.part_name) AS line_part_name,
         COUNT(*) AS lines,
         COALESCE(SUM(s.qty), 0) AS qty,
         COALESCE(SUM(s.amount), 0) AS amount,
         SUM(CASE WHEN s.pick_time IS NOT NULL AND s.pick_time <> '' THEN 1 ELSE 0 END) AS picked,
         SUM(CASE WHEN (s.check_time IS NOT NULL AND s.check_time <> '')
                    OR (s.out_time IS NOT NULL AND s.out_time <> '') THEN 1 ELSE 0 END) AS checked
  FROM ship_lines s
  %s
  WHERE %s
  GROUP BY s.order_date, s.group_no, s.part_code
),
dealer_keys AS (
  SELECT c.dealer_full AS dealer_full,
         MAX(dm.short_name) AS short_name
  FROM cand c
  LEFT JOIN dealer_map dm ON dm.full_name = c.dealer_full
  GROUP BY c.dealer_full
),
dealer_matched AS (
  SELECT k.dealer_full AS dealer_full,
         b.dealer_full AS map_dealer_full,
         ROW_NUMBER() OVER (
           PARTITION BY k.dealer_full
           ORDER BY (b.dealer_full = k.dealer_full) DESC, b.dealer_full
         ) AS rn
  FROM dealer_keys k
  JOIN battery_dealer_map b
    ON b.dealer_full = k.dealer_full
    OR (k.short_name IS NOT NULL AND k.short_name <> '' AND b.dealer_short = k.short_name)
    OR (k.short_name IS NOT NULL AND k.short_name <> '' AND b.dealer_full = k.short_name)
),
dealer_pick AS (
  SELECT dealer_full, map_dealer_full FROM dealer_matched WHERE rn = 1
)
SELECT c.*,
       COALESCE(bp_name.part_name, c.line_part_name, '-') AS part_name,
       COALESCE(d.dealer_short, dm.short_name, c.dealer_full) AS dealer_short,
       d.zone, d.doc_type, d.freight_free, d.region, d.carrier, d.dest_city, d.address,
       CASE WHEN d.dealer_full IS NULL OR TRIM(COALESCE(d.address, '')) = '' THEN 0 ELSE 1 END AS address_matched,
       CASE WHEN cf.group_no IS NULL THEN 0 ELSE 1 END AS confirmed,
       cf.reg_date, cf.confirmed_at
FROM cand c
%s
LEFT JOIN dealer_map dm ON dm.full_name = c.dealer_full
LEFT JOIN dealer_pick pk ON pk.dealer_full = c.dealer_full
LEFT JOIN battery_dealer_map d ON d.dealer_full = pk.map_dealer_full
LEFT JOIN battery_confirmations cf
       ON cf.order_date = c.order_date AND cf.group_no = c.group_no AND cf.part_code = c.part_code
""" % (join_parts, " AND ".join(where), outer_parts)
    return has_parts, base


def rows(conn, date_from="", date_to="", q="", status="", page=1, page_size=50,
         with_amount=True, order_from="", order_to="", reg_from="", reg_to=""):
    page = max(1, int(page or 1))
    page_size = max(1, min(5000, int(page_size or 50)))
    has_parts, base = _candidate_sql(conn)
    conds, params = [], []
    # 兼容旧调用：不带 order_* 时，from/to 表示订单日期
    order_from = order_from or date_from
    order_to = order_to or date_to
    if order_from:
        conds.append("order_date >= ?")
        params.append(order_from)
    if order_to:
        conds.append("order_date <= ?")
        params.append(order_to)
    if reg_from:
        conds.append("reg_date >= ?")
        params.append(reg_from)
    if reg_to:
        conds.append("reg_date <= ?")
        params.append(reg_to)
    if q:
        like = "%" + str(q).strip() + "%"
        conds.append("(group_no LIKE ? OR dealer_full LIKE ? OR part_code LIKE ? OR part_name LIKE ?)")
        params.extend([like, like, like, like])
    if str(status) in ("confirmed", "pending"):
        conds.append("confirmed = ?")
        params.append(1 if str(status) == "confirmed" else 0)
    where = (" WHERE " + " AND ".join(conds)) if conds else ""
    wrapped = "SELECT * FROM (%s) z%s" % (base, where)
    total = conn.execute("SELECT COUNT(*) AS c FROM (%s) t" % wrapped, params).fetchone()["c"]
    page_count = max(1, (total + page_size - 1) // page_size)
    page = min(page, page_count)
    rows = conn.execute(
        wrapped + " ORDER BY order_date DESC, group_no, part_code LIMIT ? OFFSET ?",
        params + [page_size, (page - 1) * page_size],
    ).fetchall()
    items = []
    for r in rows:
        item = dict(r)
        if not with_amount:
            item["amount"] = None
        item["qty"] = round(float(item.get("qty") or 0), 4)
        item["picked"] = int(item.get("picked") or 0)
        item["checked"] = int(item.get("checked") or 0)
        item["incomplete"] = bool(item["picked"] < int(item.get("lines") or 0) or
                                  item["checked"] < int(item.get("lines") or 0))
        item["dealer_short"] = item.get("dealer_short") or item.get("dealer_full") or ""
        if item.get("amount") is not None:
            item["amount"] = round(float(item.get("amount") or 0), 2)
        items.append(item)
    summary = {
        "lines": sum(int(x.get("lines") or 0) for x in items),
        "qty": round(sum(float(x.get("qty") or 0) for x in items), 4),
        "amount": round(sum(float(x.get("amount") or 0) for x in items), 2) if with_amount else None,
        "picked": sum(int(x.get("picked") or 0) for x in items),
        "checked": sum(int(x.get("checked") or 0) for x in items),
    }
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": page_count,
        "rows": items,
        "summary": summary,
        "parts_count": conn.execute("SELECT COUNT(*) AS c FROM battery_parts").fetchone()["c"],
        "has_parts": has_parts,
    }


def _key(item):
    return (str(item.get("order_date") or ""), str(item.get("group_no") or ""), str(item.get("part_code") or ""))


def _candidate_exists(conn, order_date, group_no, part_code):
    has_parts = _has_parts(conn)
    sql = ("SELECT 1 FROM ship_lines s WHERE s.order_date=? AND s.group_no=? AND s.part_code=? "
           "AND " + _battery_filter(has_parts) + " LIMIT 1")
    return conn.execute(sql, (order_date, group_no, part_code)).fetchone() is not None


def confirm(conn, items, user_id):
    confirmed = skipped = 0
    now = db.now_str()
    for item in items or []:
        order_date, group_no, part_code = _key(item)
        if not order_date or not group_no or not part_code:
            skipped += 1
            continue
        if not _candidate_exists(conn, order_date, group_no, part_code):
            skipped += 1
            continue
        cur = conn.execute(
            "INSERT INTO battery_confirmations(order_date, reg_date, group_no, part_code, confirmed_by, confirmed_at) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(order_date, group_no, part_code) DO UPDATE SET "
            "reg_date=excluded.reg_date, confirmed_by=excluded.confirmed_by, confirmed_at=excluded.confirmed_at",
            (order_date, db.today_str(), group_no, part_code, user_id, now),
        )
        if cur.rowcount and cur.rowcount > 0:
            confirmed += 1
    if confirmed:
        db.bump_version(conn)
    return {"confirmed": confirmed, "skipped": skipped}


def unconfirm(conn, items):
    removed = 0
    for item in items or []:
        order_date, group_no, part_code = _key(item)
        if not order_date or not group_no or not part_code:
            continue
        cur = conn.execute(
            "DELETE FROM battery_confirmations WHERE order_date=? AND group_no=? AND part_code=?",
            (order_date, group_no, part_code),
        )
        removed += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
    if removed:
        db.bump_version(conn)
    return {"removed": removed}


def save_dealer_map(conn, payload):
    full = str((payload or {}).get("dealer_full") or "").strip()
    if not full:
        raise ValueError("缺少经销商全称")
    now = db.now_str()
    values = {
        "dealer_short": str(payload.get("dealer_short") or "").strip(),
        "zone": str(payload.get("zone") or "").strip(),
        "doc_type": str(payload.get("doc_type") or "").strip(),
        "freight_free": str(payload.get("freight_free") or "").strip(),
        "region": str(payload.get("region") or "").strip(),
        "carrier": str(payload.get("carrier") or "").strip(),
        "dest_city": str(payload.get("dest_city") or "").strip(),
        "address": str(payload.get("address") or "").strip(),
    }
    conn.execute(
        "INSERT INTO battery_dealer_map(dealer_full, dealer_short, zone, doc_type, freight_free, region, carrier, dest_city, address, updated_at) "
        "VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dealer_full) DO UPDATE SET "
        "dealer_short=COALESCE(NULLIF(excluded.dealer_short,''), battery_dealer_map.dealer_short), "
        "zone=COALESCE(NULLIF(excluded.zone,''), battery_dealer_map.zone), "
        "doc_type=COALESCE(NULLIF(excluded.doc_type,''), battery_dealer_map.doc_type), "
        "freight_free=COALESCE(NULLIF(excluded.freight_free,''), battery_dealer_map.freight_free), "
        "region=COALESCE(NULLIF(excluded.region,''), battery_dealer_map.region), "
        "carrier=COALESCE(NULLIF(excluded.carrier,''), battery_dealer_map.carrier), "
        "dest_city=COALESCE(NULLIF(excluded.dest_city,''), battery_dealer_map.dest_city), "
        "address=COALESCE(NULLIF(excluded.address,''), battery_dealer_map.address), "
        "updated_at=excluded.updated_at",
        (full, values["dealer_short"], values["zone"], values["doc_type"], values["freight_free"],
         values["region"], values["carrier"], values["dest_city"], values["address"], now),
    )
    db.bump_version(conn)
    return {"dealer_full": full, "dealer_short": values["dealer_short"], "address": values["address"]}


def dealer_lookup(conn, q="", limit=100):
    where, params = "", []
    if q:
        like = "%" + str(q).strip() + "%"
        where = "WHERE dealer_full LIKE ? OR address LIKE ?"
        params = [like, like]
    rows = conn.execute(
        "SELECT * FROM battery_dealer_map " + where + " ORDER BY dealer_full LIMIT ?",
        params + [max(1, min(500, int(limit or 100)))],
    ).fetchall()
    return [dict(r) for r in rows]


def parts_status(conn):
    count = conn.execute("SELECT COUNT(*) AS c FROM battery_parts").fetchone()["c"]
    sample = [dict(r) for r in conn.execute(
        "SELECT part_code, part_name FROM battery_parts ORDER BY part_code LIMIT 20"
    ).fetchall()]
    return {"count": count, "samples": sample}


def import_parts(conn, path):
    """导入备件编码表（xlsx/xlsm/csv）。返回写入/更新数量。"""
    sheets = ingest.read_any(path)
    inserted = 0
    now = db.now_str()
    for _sheet, rows_data in sheets:
        if not rows_data:
            continue
        hdr, mapping, _hits = ingest.find_header(rows_data, {
            "part_code": ["备件编码", "配件编码", "配件偏码", "配件编号"],
            "part_name": ["备件名称", "配件名称"],
        })
        if hdr is None or "part_code" not in mapping:
            continue
        code_idx = mapping.get("part_code")
        name_idx = mapping.get("part_name")
        for row in rows_data[hdr + 1:]:
            code = str(row[code_idx]).strip() if code_idx < len(row) and row[code_idx] is not None else ""
            if not code:
                continue
            name = str(row[name_idx]).strip() if name_idx is not None and name_idx < len(row) and row[name_idx] is not None else ""
            conn.execute(
                "INSERT INTO battery_parts(part_code, part_name, updated_at) VALUES(?,?,?) "
                "ON CONFLICT(part_code) DO UPDATE SET part_name=excluded.part_name, updated_at=excluded.updated_at",
                (code, name, now),
            )
            inserted += 1
    if inserted:
        db.bump_version(conn)
    return inserted


def export_csv(conn, date_from="", date_to="", q="", status="", with_amount=True):
    data = rows(conn, date_from, date_to, q, status, 1, 200000, with_amount)
    out = io.StringIO()
    headers = ["登记日期", "订单组号", "经销商", "备件编码", "备件名称", "行数", "数量", "金额",
               "拣货行数", "复核行数", "库区", "单据类型", "是否免运费", "区域", "承运商", "送达城市", "地址", "状态"]
    writer = csv.writer(out)
    writer.writerow(headers)
    for item in data["rows"]:
        writer.writerow([
            item.get("order_date"), item.get("group_no"), item.get("dealer_short") or item.get("dealer_full"),
            item.get("part_code"), item.get("part_name"), item.get("lines"),
            item.get("qty"), item.get("amount"), item.get("picked"), item.get("checked"),
            item.get("zone"), item.get("doc_type"),
            item.get("freight_free"), item.get("region"), item.get("carrier"),
            item.get("dest_city"), item.get("address"),
            "已登记" if item.get("confirmed") else "待登记",
        ])
    return out.getvalue().encode("utf-8-sig")
