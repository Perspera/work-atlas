# -*- coding: utf-8 -*-
"""登记类数据：波次、订单组台账、经销商映射"""

import archive
import csv
import db
import ingest
import io
import json
import os
import re
import rules
import tempfile
import urllib.parse

from api.runtime import CONFIG, HUB, ApiError


class DataMixin:

    def api_waves_list(self, _match, query):
        self.require("page.waves")
        date = self.biz_date(query)
        rows = self.conn.execute(
            "SELECT * FROM wave_registry WHERE biz_date=? AND deleted_at IS NULL ORDER BY wave_no",
            (date,),
        ).fetchall()
        data = rules.progress(self.conn, date, self.user["id"], self.with_amount(), CONFIG.get("cutoff_time", "16:00"))
        by_wave = {w["wave_no"]: w for w in data["waves"]}
        result = []
        for r in rows:
            info = by_wave.get(r["wave_no"], {})
            result.append(
                {
                    "id": r["id"],
                    "wave_no": r["wave_no"],
                    "note": r["note"],
                    "carrier_override": r["carrier_override"],
                    "created_at": r["created_at"],
                    "updated_at": r["updated_at"],
                    "groups": info.get("groups", 0),
                    "lines": info.get("lines", 0),
                    "amount": info.get("amount") if self.with_amount() else None,
                    "picked": info.get("picked", 0),
                    "checked": info.get("checked", 0),
                    "out": info.get("out", 0),
                    "rate": info.get("rate", 0.0),
                    "done": info.get("done", False),
                    "pending": info.get("pending", False) or (not info and not rules.wave_has_data(self.conn, r["wave_no"])),
                    "excluded_all": info.get("excluded_all", False),
                    "tms_status": info.get("tms_status"),
                    "tms_carrier": info.get("tms_carrier"),
                }
            )
        self.json_out({"biz_date": date, "rows": result})

    def api_waves_candidates(self, _match, query):
        self.require("page.waves")
        date = self.biz_date(query)
        registered = {
            r["wave_no"]
            for r in self.conn.execute(
                "SELECT wave_no FROM wave_registry WHERE biz_date=? AND deleted_at IS NULL", (date,)
            )
        }
        rows = self.conn.execute(
            "SELECT wave_no, COUNT(*) AS lines, COUNT(DISTINCT group_no) AS groups, "
            "COALESCE(SUM(amount),0) AS amount, MIN(wave_time) AS wave_time, "
            "MIN(order_date) AS order_date, MAX(status) AS status "
            "FROM ship_lines WHERE wave_no IS NOT NULL GROUP BY wave_no ORDER BY wave_no DESC"
        ).fetchall()
        result = []
        for r in rows:
            if r["wave_no"] in registered:
                continue
            result.append(
                {
                    "wave_no": r["wave_no"],
                    "lines": r["lines"],
                    "groups": r["groups"],
                    "amount": round((r["amount"] or 0) / 10000.0, 2) if self.with_amount() else None,
                    "wave_time": r["wave_time"],
                    "order_date": r["order_date"],
                    "status": r["status"],
                }
            )
        self.json_out({"biz_date": date, "rows": result})

    def api_waves_create(self, _match, _query):
        self.require("action.waves.create")
        body = self.read_json()
        date = body.get("date") or db.today_str()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", str(date)):
            raise ApiError(400, "日期格式应为 YYYY-MM-DD")
        raw = body.get("waves") or []
        if isinstance(raw, str):
            raw = re.split(r"[\s,，;；]+", raw)
        waves = [str(w).strip() for w in raw if str(w).strip()]
        if not waves:
            raise ApiError(400, "请提供波次号")
        added, skipped, pending = [], [], []
        for wave in waves:
            if len(wave) > 40 or not re.match(r"^[A-Za-z0-9_.\-]+$", wave):
                skipped.append({"wave_no": wave, "reason": "波次号格式不正确"})
                continue
            existing = self.conn.execute(
                "SELECT id, deleted_at FROM wave_registry WHERE biz_date=? AND wave_no=?",
                (date, wave),
            ).fetchone()
            if existing and not existing["deleted_at"]:
                skipped.append({"wave_no": wave, "reason": "该波次已登记"})
                continue
            if existing:
                self.conn.execute(
                    "UPDATE wave_registry SET deleted_at=NULL, updated_by=?, updated_at=? WHERE id=?",
                    (self.user["id"], db.now_str(), existing["id"]),
                )
            else:
                self.conn.execute(
                    "INSERT INTO wave_registry(biz_date, wave_no, created_by, created_at, updated_by, updated_at) "
                    "VALUES(?,?,?,?,?,?)",
                    (date, wave, self.user["id"], db.now_str(), self.user["id"], db.now_str()),
                )
            added.append(wave)
            if not rules.wave_has_data(self.conn, wave):
                pending.append(wave)
        self.conn.execute("INSERT OR IGNORE INTO meta(key, value) VALUES('data_version','1')")
        db.bump_version(self.conn)
        rules.rebuild_snapshots(self.conn)
        archived = archive.auto_archive(self.conn, self.user)
        db.audit(
            self.conn, self.user, self.client_ip(), "waves.create", date,
            json.dumps({"added": added, "skipped": skipped, "pending": pending}, ensure_ascii=False),
        )
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True, "added": added, "skipped": skipped, "pending": pending, "archived": archived})

    def api_waves_update(self, match, _query):
        self.require("action.waves.update")
        wave_id = int(match.group(1))
        row = self.conn.execute("SELECT * FROM wave_registry WHERE id=?", (wave_id,)).fetchone()
        if not row:
            raise ApiError(404, "波次登记不存在")
        body = self.read_json()
        note = body.get("note", row["note"])
        carrier = body.get("carrier_override", row["carrier_override"])
        if body.get("expected_updated_at") and row["updated_at"] != body["expected_updated_at"]:
            raise ApiError(409, "该波次刚被别人修改，请刷新后再试")
        self.conn.execute(
            "UPDATE wave_registry SET note=?, carrier_override=?, updated_by=?, updated_at=? WHERE id=?",
            (note, carrier, self.user["id"], db.now_str(), wave_id),
        )
        db.bump_version(self.conn)
        rules.rebuild_snapshots(self.conn)
        db.audit(
            self.conn, self.user, self.client_ip(), "waves.update", row["wave_no"],
            json.dumps({"note": note, "carrier_override": carrier}, ensure_ascii=False),
        )
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    def api_waves_delete(self, match, _query):
        self.require("action.waves.delete")
        wave_id = int(match.group(1))
        row = self.conn.execute("SELECT * FROM wave_registry WHERE id=?", (wave_id,)).fetchone()
        if not row:
            raise ApiError(404, "波次登记不存在")
        self.conn.execute(
            "UPDATE wave_registry SET deleted_at=?, updated_by=?, updated_at=? WHERE id=?",
            (db.now_str(), self.user["id"], db.now_str(), wave_id),
        )
        db.bump_version(self.conn)
        rules.rebuild_snapshots(self.conn)
        db.audit(self.conn, self.user, self.client_ip(), "waves.delete", row["wave_no"], row["biz_date"])
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    def api_wave_orders(self, match, _query):
        self.require("page.waves", "page.progress")
        wave_id = int(match.group(1))
        row = self.conn.execute("SELECT * FROM wave_registry WHERE id=?", (wave_id,)).fetchone()
        if not row:
            raise ApiError(404, "波次登记不存在")
        data = rules.order_groups(
            self.conn, row["biz_date"], self.user["id"], self.with_amount(),
            mode="live", wave=row["wave_no"], included="all", sort="reg", page=1, size=1000,
        )
        self.json_out(
            {
                "wave_no": row["wave_no"],
                "pending": not rules.wave_has_data(self.conn, row["wave_no"]),
                "total": data["total"],
                "summary": data["summary"],
                "rows": data["rows"],
            }
        )

    def api_order_groups(self, _match, query):
        self.require("page.orders")
        date = self.biz_date(query)
        mode = (query.get("mode") or ["live"])[0]
        data = rules.order_groups(
            self.conn, date, self.user["id"], self.with_amount(),
            mode="archive" if mode == "archive" else "live",
            wave=(query.get("wave") or [""])[0],
            route=(query.get("route") or [""])[0],
            region=(query.get("region") or [""])[0],
            q=(query.get("q") or [""])[0],
            included=(query.get("included") or ["all"])[0],
            sort=(query.get("sort") or ["reg"])[0],
            page=(query.get("page") or ["1"])[0],
            size=(query.get("size") or ["100"])[0],
        )
        self.json_out(data)

    def api_order_group_save(self, match, query):
        self.require("action.orders.override")
        group_no = urllib.parse.unquote(match.group(1))
        date = self.biz_date(query)
        body = self.read_json()
        existing = self.conn.execute(
            "SELECT * FROM order_overrides WHERE biz_date=? AND group_no=?", (date, group_no)
        ).fetchone()
        if body.get("expected_updated_at") and existing and existing["updated_at"] != body["expected_updated_at"]:
            raise ApiError(409, "该订单组刚被别人修改，请刷新后再试")

        def pick(key, column):
            if key in body:
                value = body.get(key)
                return (str(value).strip() or None) if value is not None else None
            return existing[column] if existing else None

        route = pick("route_override", "route_override")
        region = pick("region_override", "region_override")
        assignee = pick("assign_override", "assign_override")
        note = pick("note", "note")
        if "include" in body:
            include = 1 if body.get("include") else 0
        elif existing:
            include = int(existing["include_flag"])
        else:
            include = 1
        self.conn.execute(
            "INSERT INTO order_overrides(biz_date, group_no, route_override, region_override, "
            "assign_override, note, include_flag, updated_by, updated_at) VALUES(?,?,?,?,?,?,?,?,?) "
            "ON CONFLICT(biz_date, group_no) DO UPDATE SET route_override=excluded.route_override, "
            "region_override=excluded.region_override, assign_override=excluded.assign_override, "
            "note=excluded.note, include_flag=excluded.include_flag, updated_by=excluded.updated_by, "
            "updated_at=excluded.updated_at",
            (date, group_no, route, region, assignee, note, include, self.user["id"], db.now_str()),
        )
        db.bump_version(self.conn)
        rules.rebuild_snapshots(self.conn)
        db.audit(
            self.conn, self.user, self.client_ip(), "order.override", "%s/%s" % (date, group_no),
            json.dumps(
                {"route": route, "region": region, "assignee": assignee, "note": note, "include": include},
                ensure_ascii=False,
            ),
        )
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    def api_order_group_reset(self, match, query):
        self.require("action.orders.override")
        group_no = urllib.parse.unquote(match.group(1))
        date = self.biz_date(query)
        self.conn.execute(
            "DELETE FROM order_overrides WHERE biz_date=? AND group_no=?", (date, group_no)
        )
        db.bump_version(self.conn)
        rules.rebuild_snapshots(self.conn)
        db.audit(self.conn, self.user, self.client_ip(), "order.reset", "%s/%s" % (date, group_no), "")
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    def api_dealers(self, _match, query):
        self.require("page.sources", "action.dealers.manage")
        q = (query.get("q") or [""])[0].strip()
        page = max(1, int((query.get("page") or ["1"])[0] or 1))
        size = min(200, max(10, int((query.get("size") or ["50"])[0] or 50)))
        where, params = "", []
        if q:
            where = "WHERE full_name LIKE ? OR short_name LIKE ? OR region LIKE ? OR route LIKE ?"
            like = "%" + q + "%"
            params = [like] * 4
        total = self.conn.execute("SELECT COUNT(*) AS c FROM dealer_map " + where, params).fetchone()["c"]
        rows = self.conn.execute(
            "SELECT * FROM dealer_map " + where + " ORDER BY full_name LIMIT ? OFFSET ?",
            params + [size, (page - 1) * size],
        ).fetchall()
        self.json_out(
            {
                "total": total,
                "page": page,
                "size": size,
                "rows": [dict(r) for r in rows],
            }
        )

    def api_dealer_save(self, _match, _query):
        self.require("action.dealers.manage")
        body = self.read_json()
        full = (body.get("full_name") or "").strip()
        if not full:
            raise ApiError(400, "缺少经销商全称")
        self.conn.execute(
            "INSERT INTO dealer_map(full_name, short_name, region, route, updated_at) VALUES(?,?,?,?,?) "
            "ON CONFLICT(full_name) DO UPDATE SET short_name=excluded.short_name, region=excluded.region, "
            "route=excluded.route, updated_at=excluded.updated_at",
            (
                full,
                (body.get("short_name") or full).strip(),
                (body.get("region") or "").strip() or None,
                (body.get("route") or "").strip() or None,
                db.now_str(),
            ),
        )
        db.bump_version(self.conn)
        db.audit(self.conn, self.user, self.client_ip(), "dealer.save", full, json.dumps(body, ensure_ascii=False))
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({"ok": True})

    def api_dealers_import(self, _match, _query):
        self.require("action.dealers.manage")
        raw = self.read_body()
        if not raw:
            raise ApiError(400, "没有内容")
        if raw[:4] == b"PK\x03\x04":
            tmp = tempfile.NamedTemporaryFile(prefix="dealers_", suffix=".xlsx", delete=False)
            try:
                tmp.write(raw)
                tmp.close()
                result = ingest.import_dealer_workbook(self.conn, tmp.name)
            except Exception as exc:  # noqa: BLE001
                raise ApiError(400, "Excel 导入失败：%s" % exc)
            finally:
                try:
                    os.remove(tmp.name)
                except OSError:
                    pass
            db.audit(self.conn, self.user, self.client_ip(), "dealers.import", "",
                     "普通 %d / 动力电池 %d" % (result["base"], result["battery"]))
            HUB.broadcast(db.get_version(self.conn))
            self.json_out({
                "ok": True, "count": result["total"], "created": result["base"],
                "updated": result["battery"], "battery": result["battery"],
                "base": result["base"], "skipped": 0, "samples": [],
            })
            return
        text = raw.decode("utf-8-sig", errors="replace")
        reader = csv.reader(io.StringIO(text))
        rows = list(reader)
        if not rows:
            raise ApiError(400, "CSV 为空")
        header = [c.strip() for c in rows[0]]
        idx = {}
        for i, name in enumerate(header):
            if name in ("全称", "经销商全称"):
                idx["full"] = i
            elif name in ("简称", "经销商简称"):
                idx["short"] = i
            elif name == "区域":
                idx["region"] = i
            elif name in ("承运商", "线路", "承运商/线路", "承运商／线路", "承运商/路线"):
                idx["route"] = i
        if "full" not in idx:
            raise ApiError(400, "CSV 需要包含「全称」列")
        created = updated = skipped = 0
        skipped_names = []

        def pick(row, key):
            return row[idx[key]].strip() if key in idx and idx[key] < len(row) else ""

        for row in rows[1:]:
            if not row:
                skipped += 1
                continue
            full = pick(row, "full")
            if not full:
                skipped += 1
                if len(skipped_names) < 10:
                    skipped_names.append(row[:1])
                continue
            existing = self.conn.execute(
                "SELECT * FROM dealer_map WHERE full_name=?", (full,)
            ).fetchone()
            short, region, route = pick(row, "short"), pick(row, "region"), pick(row, "route")
            if existing:
                # 只覆盖非空字段，空值保持原值（避免批量导入把已有映射清空）
                new_short = short or existing["short_name"] or full
                new_region = region or existing["region"]
                new_route = route or existing["route"]
                if (new_short, new_region, new_route) != (
                    existing["short_name"], existing["region"], existing["route"]
                ):
                    self.conn.execute(
                        "UPDATE dealer_map SET short_name=?, region=?, route=?, updated_at=? WHERE full_name=?",
                        (new_short, new_region, new_route, db.now_str(), full),
                    )
                    updated += 1
                else:
                    skipped += 1
            else:
                self.conn.execute(
                    "INSERT INTO dealer_map(full_name, short_name, region, route, updated_at) "
                    "VALUES(?,?,?,?,?)",
                    (full, short or full, region or None, route or None, db.now_str()),
                )
                created += 1
        count = created + updated
        db.bump_version(self.conn)
        db.audit(
            self.conn, self.user, self.client_ip(), "dealers.import", "",
            "新增 %d / 更新 %d / 跳过 %d" % (created, updated, skipped),
        )
        HUB.broadcast(db.get_version(self.conn))
        self.json_out({
            "ok": True, "count": count, "created": created, "updated": updated,
            "skipped": skipped, "samples": skipped_names,
        })

    def api_dealers_unmapped(self, _match, _query):
        self.require("page.sources", "action.dealers.manage")
        rows = self._unmapped_dealers()
        self.json_out({"count": len(rows), "rows": rows[:300]})

    def _unmapped_dealers(self):
        rows = self.conn.execute(
            "SELECT s.dealer_full AS full_name, COUNT(*) AS lines, COALESCE(SUM(s.amount),0) AS amount "
            "FROM ship_lines s "
            "WHERE s.dealer_full IS NOT NULL AND s.dealer_full <> '' "
            "AND NOT EXISTS (SELECT 1 FROM dealer_lookup d WHERE d.key = s.dealer_full) "
            "GROUP BY s.dealer_full ORDER BY lines DESC"
        ).fetchall()
        result = []
        for r in rows:
            result.append(
                {
                    "full_name": r["full_name"],
                    "lines": r["lines"],
                    "amount": round((r["amount"] or 0) / 10000.0, 2) if self.with_amount() else None,
                }
            )
        return result
