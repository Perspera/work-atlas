# -*- coding: utf-8 -*-
"""启动与后台任务：布局补种、每日备份、目录扫描循环、默认口令检测。

从 server.py 抽出，main() 只负责编排启动顺序。
"""
import json
import os
import shutil
import sqlite3
import time
import traceback

from backend.domain import alerts
from backend.archives import archive_refresh
from backend.core import auth
from backend.core import db
from backend.collect import ingest
from backend.archives import source_archive
from backend.core import templates

from api.runtime import BASE_DIR, CONFIG, HUB, log_line


def ensure_personal_page_layouts(conn):
    """个人页面布局里还残留按组指标时，换成该页新的默认布局（保留"我的布局"）。"""
    for row in conn.execute(
        "SELECT id, page_key, layout_json FROM dashboards "
        "WHERE page_key IS NOT NULL AND owner_user_id IS NOT NULL"
    ).fetchall():
        raw = row["layout_json"] or ""
        if not any(token in raw for token in GROUP_METRICS):
            continue
        template = next(
            (item for item in templates.PAGE_TEMPLATES if item["key"] == row["page_key"]), None
        )
        if not template:
            continue
        layout = json.dumps({"widgets": template["widgets"]}, ensure_ascii=False)
        conn.execute(
            "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
            (layout, db.now_str(), row["id"]),
        )

def ensure_chart_colors(conn):
    """一次性给导航页的单系列柱/折线图补默认彩色（只补没配过色的组件）。

    多系列图表、饼图/漏斗仍走前端多色盘；手动配过色的组件不动。
    """
    if db.get_meta(conn, "chart_colors_v1") == "1":
        return
    updated = 0
    for row in conn.execute(
        "SELECT id, page_key, layout_json FROM dashboards WHERE page_key IS NOT NULL"
    ).fetchall():
        try:
            layout = json.loads(row["layout_json"] or "{}")
        except ValueError:
            continue
        changed = False
        for widget in layout.get("widgets") or []:
            spec = widget.get("spec") or {}
            if widget.get("type") not in ("bar", "line"):
                continue
            if len(spec.get("metrics") or []) != 1:
                continue
            if spec.get("color") or spec.get("color_scheme"):
                continue
            spec["color"] = templates.chart_color(widget.get("id") or "")
            widget["spec"] = spec
            changed = True
        if changed:
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (json.dumps(layout, ensure_ascii=False), db.now_str(), row["id"]),
            )
            updated += 1
    db.set_meta(conn, "chart_colors_v1", "1")
    if updated:
        log_line("单系列图表配色补齐：%d 个看板" % updated)

def ensure_erp_detail_filters(conn):
    """一次性修复历史布局里 erp_detail 组件丢失的 filter.erp_status。"""
    if db.get_meta(conn, "erp_filter_repair_v1") == "1":
        return
    repaired = []
    for row in conn.execute(
        "SELECT id, page_key, owner_user_id, layout_json FROM dashboards"
    ).fetchall():
        try:
            layout = json.loads(row["layout_json"] or "{}")
        except ValueError:
            continue
        changed = False
        for widget in layout.get("widgets") or []:
            spec = widget.get("spec") or {}
            if spec.get("dataset") != "erp_detail":
                continue
            filt = spec.get("filter") or {}
            if filt.get("erp_status") in ("failed", "missing"):
                continue
            label = "%s %s" % (widget.get("id") or "", widget.get("title") or "")
            status = "missing" if ("未回传" in label or "missing" in label) else "failed"
            filt["erp_status"] = status
            spec["filter"] = filt
            spec["dimension"] = ""
            spec["metrics"] = ["rows"]
            widget["spec"] = spec
            changed = True
            repaired.append((row["page_key"] or "dash%s" % row["id"], widget.get("title") or widget.get("id")))
        if changed:
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (json.dumps(layout, ensure_ascii=False), db.now_str(), row["id"]),
            )
    db.set_meta(conn, "erp_filter_repair_v1", "1")
    if repaired:
        db.audit(conn, None, "", "erp_filter.repair", "layout", json.dumps(repaired, ensure_ascii=False))

def ensure_personal_erp_widgets(conn):
    """一次性把新增的 ERP 组件追加到个人页面布局底部（不动原有组件）。

    只跑一次（meta 标记），之后用户删掉也不会再加回来。
    """
    if db.get_meta(conn, "personal_erp_v9") == "1":
        return
    templates_by_key = {item["key"]: item["widgets"] for item in templates.PAGE_TEMPLATES}
    for row in conn.execute(
        "SELECT id, page_key, layout_json FROM dashboards "
        "WHERE page_key IN ('overview', 'progress') AND owner_user_id IS NOT NULL"
    ).fetchall():
        try:
            layout = json.loads(row["layout_json"] or "{}")
        except ValueError:
            continue
        widgets = layout.get("widgets") or []
        existing = {w.get("id") for w in widgets}
        default_widgets = templates_by_key.get(row["page_key"]) or []
        new_widgets = [
            w for w in default_widgets
            if str(w.get("id", "")).startswith("pg-%s-erp" % ("ov" if row["page_key"] == "overview" else "pr"))
            and w.get("id") not in existing
        ]
        if not new_widgets:
            continue
        bottom = 0
        for w in widgets:
            bottom = max(bottom, int(w.get("y") or 0) + int(w.get("h") or 3))
        for w in new_widgets:
            copy = json.loads(json.dumps(w))
            copy["x"] = 0
            copy["w"] = 12
            copy["y"] = bottom
            bottom += int(copy.get("h") or 5)
            widgets.append(copy)
        layout["widgets"] = widgets
        conn.execute(
            "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
            (json.dumps(layout, ensure_ascii=False), db.now_str(), row["id"]),
        )
    db.set_meta(conn, "personal_erp_v9", "1")

def ensure_page_layouts_v9(conn):
    """v9：总览/进度补 ERP 回传组件（只在仍是旧默认时替换）。"""
    if _page_layout_version(conn) >= 9:
        return
    sentinels = {
        "overview": ("pg-ov-cycle", "pg-ov-erp-failed", templates.PAGE_OVERVIEW),
        "progress": ("pg-pr-tms", "pg-pr-erp-failed", templates.PAGE_PROGRESS),
    }
    for key, (old_id, new_id, template) in sentinels.items():
        row = conn.execute(
            "SELECT * FROM dashboards WHERE page_key=? AND owner_user_id IS NULL", (key,)
        ).fetchone()
        if not row:
            continue
        try:
            widget_ids = {w.get("id") for w in json.loads(row["layout_json"] or "{}").get("widgets", [])}
        except ValueError:
            widget_ids = set()
        if old_id in widget_ids and new_id not in widget_ids:
            layout = json.dumps({"widgets": template}, ensure_ascii=False)
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (layout, db.now_str(), row["id"]),
            )
    db.set_meta(conn, "page_layout_version", "9")

def _page_layout_version(conn):
    try:
        return int(db.get_meta(conn, "page_layout_version") or 0)
    except (TypeError, ValueError):
        return 0

GROUP_METRICS = {"groups", "all_groups", "registered_today_groups", "unregistered_groups"}

def ensure_page_layouts_v8(conn):
    """v8：取消所有按组统计的组件指标。

    - 页面默认布局里只要还残留组指标，就换成新模板（3 行 KPI：今日订单量/金额、已组波、待组波）
    - 自定义专题看板：从 metrics 里剔除组指标，标题里的"订单组数"等顺手改成行数口径
    """
    ensure_personal_page_layouts(conn)
    if _page_layout_version(conn) >= 8:
        return
    for item in templates.PAGE_TEMPLATES:
        row = conn.execute(
            "SELECT * FROM dashboards WHERE page_key=? AND owner_user_id IS NULL", (item["key"],)
        ).fetchone()
        if not row:
            continue
        raw = row["layout_json"] or ""
        if any(token in raw for token in GROUP_METRICS):
            layout = json.dumps({"widgets": item["widgets"]}, ensure_ascii=False)
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (layout, db.now_str(), row["id"]),
            )
    rename = {"订单组数": "行数", "今日订单量(组)": "今日订单量(行)", "已登记(组)": "已组波行数",
              "漏登记(组)": "待组波行数"}
    for row in conn.execute(
        "SELECT id, layout_json FROM dashboards WHERE page_key IS NULL"
    ).fetchall():
        try:
            layout = json.loads(row["layout_json"] or "{}")
        except ValueError:
            continue
        changed = False
        for widget in layout.get("widgets") or []:
            spec = widget.get("spec") or {}
            metrics = spec.get("metrics")
            if isinstance(metrics, list):
                kept = [m for m in metrics if m not in GROUP_METRICS]
                if len(kept) != len(metrics):
                    spec["metrics"] = kept or ["rows"]
                    changed = True
            title = widget.get("title") or ""
            for old, new in rename.items():
                if old in title:
                    widget["title"] = title.replace(old, new)
                    changed = True
                    break
        if changed:
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (json.dumps(layout, ensure_ascii=False), db.now_str(), row["id"]),
            )
    db.set_meta(conn, "page_layout_version", "8")

def ensure_page_layouts_v7(conn):
    """v7：总览/进度默认布局补上 未拣货行数 / 拣货完成率 / 人均每小时拣货行数。

    只在页面仍是旧默认（含旧哨兵组件、缺新组件）时替换，避免覆盖管理员自定义过的布局。
    """
    if _page_layout_version(conn) >= 7:
        return
    targets = {
        "overview": ("pg-ov-unreg", "pg-ov-unpicked", templates.PAGE_OVERVIEW),
        "progress": ("pg-pr-unchecked", "pg-pr-unpicked", templates.PAGE_PROGRESS),
    }
    for key, (old_id, new_id, template) in targets.items():
        row = conn.execute(
            "SELECT * FROM dashboards WHERE page_key=? AND owner_user_id IS NULL", (key,)
        ).fetchone()
        if not row:
            continue
        try:
            widget_ids = {w.get("id") for w in json.loads(row["layout_json"] or "{}").get("widgets", [])}
        except ValueError:
            widget_ids = set()
        if old_id in widget_ids and new_id not in widget_ids:
            layout = json.dumps({"widgets": template}, ensure_ascii=False)
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (layout, db.now_str(), row["id"]),
            )
    db.set_meta(conn, "page_layout_version", "7")

def ensure_page_layouts_v6(conn):
    """v6：把「人工作业量」默认布局升级为"拣货/复核分开"的版本。

    只在它仍是 v5 默认布局（含 pg-lb-people）时替换，避免覆盖管理员自己发布过的版本。
    """
    if _page_layout_version(conn) >= 6:
        return
    row = conn.execute(
        "SELECT * FROM dashboards WHERE page_key='labor' AND owner_user_id IS NULL"
    ).fetchone()
    if row:
        try:
            widget_ids = {w.get("id") for w in json.loads(row["layout_json"] or "{}").get("widgets", [])}
        except ValueError:
            widget_ids = set()
        if "pg-lb-people" in widget_ids:
            layout = json.dumps({"widgets": templates.PAGE_LABOR}, ensure_ascii=False)
            conn.execute(
                "UPDATE dashboards SET layout_json=?, version=version+1, updated_at=? WHERE id=?",
                (layout, db.now_str(), row["id"]),
            )
    db.set_meta(conn, "page_layout_version", "6")

def maybe_backup(conn):
    """每天把 SQLite 备份一份到 data/backup，保留 backup_keep_days 天。

    - 先写临时文件并做 PRAGMA integrity_check，校验通过才原子替换成正式备份；
    - 每周日额外复制一份到 data/offsite，保留 28 天。
    """
    today = db.today_str()
    if db.get_meta(conn, "last_backup_date") == today:
        return
    try:
        import sqlite3

        os.makedirs(db.BACKUP_DIR, exist_ok=True)
        target = os.path.join(db.BACKUP_DIR, "dashboard_%s.db" % today.replace("-", ""))
        tmp = target + ".tmp"
        if os.path.exists(tmp):
            os.remove(tmp)
        dest = sqlite3.connect(tmp)
        try:
            conn.backup(dest)
            verdict = dest.execute("PRAGMA integrity_check").fetchone()[0]
        finally:
            dest.close()
        if verdict != "ok":
            try:
                os.remove(tmp)
            except OSError:
                pass
            log_line("备份校验失败（%s），已丢弃本次备份，保留上一份：%s" % (verdict, target))
            return
        os.replace(tmp, target)
        keep = int(CONFIG.get("backup_keep_days", 30) or 30)
        cutoff = time.time() - keep * 86400
        for name in os.listdir(db.BACKUP_DIR):
            path = os.path.join(db.BACKUP_DIR, name)
            try:
                if os.path.getmtime(path) < cutoff:
                    os.remove(path)
            except OSError:
                pass
        if time.localtime().tm_wday == 6:
            offsite = os.path.join(BASE_DIR, "data", "offsite")
            os.makedirs(offsite, exist_ok=True)
            shutil.copy2(target, os.path.join(offsite, os.path.basename(target)))
            off_cutoff = time.time() - 28 * 86400
            for name in os.listdir(offsite):
                path = os.path.join(offsite, name)
                try:
                    if os.path.getmtime(path) < off_cutoff:
                        os.remove(path)
                except OSError:
                    pass
            log_line("已生成每周异地副本：%s" % os.path.join(offsite, os.path.basename(target)))
        db.set_meta(conn, "last_backup_date", today)
        log_line("数据库已备份：%s" % target)
    except Exception:  # noqa: BLE001
        log_line("备份失败\n%s" % traceback.format_exc())

def scanner_loop():
    conn = db.connect()
    try:
        source_archive.migrate_storage(conn)
        source_archive.cleanup(conn)
    except Exception:  # noqa: BLE001
        log_line("归档初始化失败\n%s" % traceback.format_exc())
    while True:
        try:
            before = db.get_version(conn)
            report = ingest.scan(conn, CONFIG, wait=False)
            if not report.get("busy"):
                db.set_meta(conn, "last_scan_at", db.now_str())
                db.set_meta(conn, "last_scan_error", "；".join(report.get("errors") or []) or "")
                try:
                    refreshed = archive_refresh.refresh(conn, report)
                    if refreshed.get("orders") or refreshed.get("labor") or refreshed.get("battery_filled"):
                        log_line(
                            "自动归档：订单组 %s；人效 %s；电池 %s（新增 %d 行 / 变更 %d 行）"
                            % (
                                ",".join(refreshed.get("orders") or []) or "-",
                                ",".join(refreshed.get("labor") or []) or "-",
                                ",".join(refreshed.get("battery_filled") or []) or "-",
                                refreshed.get("added_rows") or 0,
                                refreshed.get("changed_rows") or 0,
                            )
                        )
                except Exception:  # noqa: BLE001
                    log_line("自动归档失败\n%s" % traceback.format_exc())
                try:
                    source_archive.cleanup(conn)
                except Exception:  # noqa: BLE001
                    log_line("归档清理失败\n%s" % traceback.format_exc())
            try:
                created = alerts.generate(conn)
                if created:
                    log_line("生成预警通知 %d 条" % created)
            except Exception:  # noqa: BLE001
                log_line("预警生成失败\n%s" % traceback.format_exc())
            after = db.get_version(conn)
            if after != before:
                HUB.broadcast(after)
            auth.cleanup_sessions(conn)
            maybe_backup(conn)
        except Exception:  # noqa: BLE001
            log_line("扫描失败\n%s" % traceback.format_exc())
            try:
                db.set_meta(conn, "last_scan_error", "%s %s" % (db.now_str(), "后台扫描异常，见日志"))
            except Exception:
                pass
        time.sleep(max(15, int(CONFIG.get("scan_sec", 60))))

def flag_default_passwords(conn):
    """一次性把仍在使用交付默认口令的账号标记为必须改密。"""
    if db.get_meta(conn, "default_pwd_flag_v1") == "1":
        return 0
    flagged = 0
    for row in conn.execute("SELECT id, pwd_hash, salt FROM users").fetchall():
        if auth.verify_password("Admin12345", row["pwd_hash"], row["salt"]):
            conn.execute("UPDATE users SET pwd_is_default=1 WHERE id=?", (row["id"],))
            flagged += 1
    db.set_meta(conn, "default_pwd_flag_v1", "1")
    if flagged:
        log_line("检测到 %d 个账号仍在使用默认口令，已要求登录后改密" % flagged)
    return flagged
