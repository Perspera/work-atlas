# -*- coding: utf-8 -*-
"""CSV 导出"""

from backend.domain import battery
from backend.archives import battery_archive
import csv
from backend.core import db
import io
import os
from backend.archives import outbound_archive
import re
from backend.domain import rules
from backend.archives import source_archive
import urllib.parse

from api.runtime import ApiError


class ExportMixin:

    def api_export_summary(self, _match, query):
        """导出与现行「单量表」同版式的 CSV：线路 × 库区（行数/金额）。"""
        self.require("action.export")
        date = self.biz_date(query)
        data = rules.summary_matrix(self.conn, date, self.user["id"], self.with_amount())
        header = ["承运商/线路"]
        for zone in data["zones"]:
            header.append(zone + " 行数")
            if data["with_amount"]:
                header.append(zone + " 金额(万)")
        header.extend(["合计行数", "订单组数"])
        if data["with_amount"]:
            header.append("合计金额(万)")

        rows = [["业务日期", date], header]
        for item in data["routes"]:
            row = [item["label"]]
            for zone in data["zones"]:
                cell = item["cells"].get(zone)
                row.append(cell["lines"] if cell else 0)
                if data["with_amount"]:
                    row.append(cell["amount"] if cell else 0)
            row.extend([item["lines"], item["groups"]])
            if data["with_amount"]:
                row.append(item["amount"])
            rows.append(row)

        row = ["合计"]
        for zone in data["zones"]:
            row.append(data["zone_totals"][zone]["lines"])
            if data["with_amount"]:
                row.append(data["zone_totals"][zone]["amount"])
        row.extend([data["totals"]["lines"], data["totals"]["groups"]])
        if data["with_amount"]:
            row.append(data["totals"]["amount"])
        rows.append(row)

        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerows(rows)
        body = ("\ufeff" + buffer.getvalue()).encode("utf-8")
        filename = "单量表_%s.csv" % date
        self._send(
            200,
            body,
            "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )

    def api_export_battery(self, _match, query):
        self.require("action.export")
        body = battery.export_csv(
            self.conn,
            date_from=(query.get("from") or [""])[0].strip(),
            date_to=(query.get("to") or [""])[0].strip(),
            q=(query.get("q") or [""])[0].strip(),
            status=(query.get("status") or [""])[0].strip(),
            with_amount=self.with_amount(),
        )
        filename = "动力电池登记.csv"
        self._send(200, body, "text/csv; charset=utf-8",
                   {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)})

    def api_export_battery_archive(self, _match, query):
        self.require("action.export")
        body = battery_archive.export_csv(
            self.conn,
            date_from=(query.get("from") or [""])[0].strip(),
            date_to=(query.get("to") or [""])[0].strip(),
            q=(query.get("q") or [""])[0].strip(),
            status=(query.get("status") or [""])[0].strip(),
        )
        filename = "动力电池存档.csv"
        self._send(200, body, "text/csv; charset=utf-8",
                   {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)})

    def api_export_order_groups(self, _match, query):
        """导出订单组台账（13 列，与页面一致；支持实时/存档两种模式）。"""
        self.require("action.export")
        date = self.biz_date(query)
        mode = "archive" if (query.get("mode") or ["live"])[0] == "archive" else "live"
        collected = []
        page = 1
        while True:
            data = rules.order_groups(
                self.conn, date, self.user["id"], self.with_amount(),
                mode=mode, included=(query.get("included") or ["all"])[0],
                wave=(query.get("wave") or [""])[0],
                sort=(query.get("sort") or ["reg"])[0],
                page=page, size=1000,
            )
            collected.extend(data["rows"])
            if len(collected) >= (data.get("total") or 0) or not data["rows"]:
                break
            page += 1

        header = [
            "序号", "订单组号", "经销商", "行数", "金额", "库区", "单据类型",
            "是否免运费", "区域", "承运商", "波次号", "清洗", "指派", "备注", "是否计入",
        ]
        rows = [["业务日期", date, "数据来源", "存档快照" if mode == "archive" else "实时"], header]
        for item in collected:
            rows.append(
                [
                    item.get("seq"), item.get("group_no"), item.get("dealer"), item.get("lines"),
                    item.get("amount") if self.with_amount() else "",
                    item.get("zone"), item.get("doc_type"), item.get("freight_free"),
                    item.get("region"), item.get("route"), item.get("wave_no"),
                    item.get("tms_status"), item.get("assignee"), item.get("note"),
                    "计入" if item.get("included", 1) else "已移出",
                ]
            )
        buffer = io.StringIO()
        csv.writer(buffer).writerows(rows)
        body = ("\ufeff" + buffer.getvalue()).encode("utf-8")
        filename = "订单组台账_%s.csv" % date
        self._send(
            200,
            body,
            "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )

    def api_export_unmapped_dealers(self, _match, _query):
        """导出未映射经销商清单（可直接填好再批量导入）。"""
        self.require("action.dealers.manage")
        rows = self._unmapped_dealers()
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["全称", "简称", "区域", "承运商/线路", "行数", "金额(元)"])
        for item in rows:
            amount = "" if item.get("amount") is None else "%.2f" % (item["amount"] * 10000.0)
            writer.writerow([item["full_name"], "", "", "", item["lines"], amount])
        body = ("\ufeff" + buffer.getvalue()).encode("utf-8")
        db.audit(self.conn, self.user, self.client_ip(), "dealers.unmapped.export", "", "%d 条" % len(rows))
        filename = "未映射经销商_%s.csv" % db.today_str()
        self._send(
            200, body, "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )

    def api_export_archive(self, _match, query):
        """导出归档：type=orders|labor，from/to 为业务日期区间（可同一天）。"""
        self.require("action.export")
        kind = (query.get("type") or ["orders"])[0]
        date_from = (query.get("from") or query.get("date") or [""])[0].strip()
        date_to = (query.get("to") or query.get("date") or [""])[0].strip()
        pattern = r"^\d{4}-\d{2}-\d{2}$"
        if not re.match(pattern, date_from) or not re.match(pattern, date_to):
            raise ApiError(400, "日期格式不正确")
        if date_to < date_from:
            date_from, date_to = date_to, date_from
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        if kind == "labor":
            header = ["作业日期", "人员", "工种", "行数", "订单组数", "自动小时", "采用小时", "人效", "归档时间"]
            rows = self.conn.execute(
                "SELECT * FROM labor_archive WHERE biz_date BETWEEN ? AND ? "
                "ORDER BY biz_date, role, rows DESC",
                (date_from, date_to),
            ).fetchall()
            writer.writerow(header)
            for r in rows:
                writer.writerow(
                    [
                        r["biz_date"], r["person"],
                        "拣货" if r["role"] == "pick" else ("复核" if r["role"] == "check" else r["role"]),
                        r["rows"], r["groups"], r["hours_auto"], r["hours_used"], r["rate"],
                        r["archived_at"],
                    ]
                )
            filename = "人效归档_%s_%s.csv" % (date_from, date_to)
        else:
            header = [
                "业务日期", "序号", "订单组号", "经销商", "行数", "金额", "库区", "单据类型",
                "是否免运费", "区域", "承运商", "波次号", "清洗", "指派", "备注", "是否计入", "归档时间",
            ]
            rows = self.conn.execute(
                "SELECT * FROM daily_archive WHERE biz_date BETWEEN ? AND ? ORDER BY biz_date, seq",
                (date_from, date_to),
            ).fetchall()
            writer.writerow(header)
            for r in rows:
                writer.writerow(
                    [
                        r["biz_date"], r["seq"], r["group_no"], r["dealer_short"], r["lines"],
                        r["amount"] if self.with_amount() else "",
                        r["zone"], r["doc_type"], r["freight_free"], r["region"], r["route"],
                        r["wave_no"], r["tms_status"], r["assignee"], r["note"],
                        "计入" if r["included"] else "已移出", r["archived_at"],
                    ]
                )
            filename = "订单组归档_%s_%s.csv" % (date_from, date_to)
        body = ("\ufeff" + buffer.getvalue()).encode("utf-8")
        db.audit(self.conn, self.user, self.client_ip(), "archive.export", kind,
                 "%s~%s" % (date_from, date_to))
        self._send(
            200,
            body,
            "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )

    def api_export_source_archive(self, _match, query):
        self.require("action.export")
        try:
            archive_id = int((query.get("id") or ["0"])[0])
        except ValueError:
            raise ApiError(400, "归档编号不正确")
        row = source_archive.get(self.conn, archive_id)
        if not row:
            raise ApiError(404, "归档不存在或已被清理")
        body = source_archive.export_csv(self.conn, archive_id)
        if body is None:
            raise ApiError(404, "这条归档没有行数据快照")
        db.audit(self.conn, self.user, self.client_ip(), "source_archive.export",
                 row["name"], "%d 行" % (row["rows"] or 0))
        filename = os.path.splitext(row["name"])[0] + "_行数据.csv"
        self._send(
            200, body, "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )

    def api_export_outbound_archive(self, _match, query):
        self.require("action.export")
        filters = self._outbound_filters(query)
        date = (query.get("date") or [""])[0].strip()
        body = outbound_archive.export_csv(
            self.conn, filters=filters,
            date_col=(query.get("date_col") or [""])[0].strip(),
            date_from=(query.get("from") or [""])[0].strip(),
            date_to=(query.get("to") or [""])[0].strip(),
            biz_date=date or None,
        )
        if body is None:
            raise ApiError(404, "还没有出库文件归档")
        meta = outbound_archive.get_meta(self.conn, date or None) or {}
        db.audit(self.conn, self.user, self.client_ip(), "outbound_archive.export",
                 meta.get("name") or "", "筛选导出")
        filename = os.path.splitext(meta.get("name") or "出库归档")[0] + "_" + (date or "最新") + "_筛选.csv"
        self._send(
            200, body, "text/csv; charset=utf-8",
            {"Content-Disposition": "attachment; filename*=UTF-8''%s" % urllib.parse.quote(filename)},
        )
