# -*- coding: utf-8 -*-
"""SQLite 存储层：建表、连接管理、元数据、审计日志。

设计要点
- 每线程一个连接（http.server 是多线程的），WAL 模式，autocommit + 显式事务。
- 所有时间统一使用本地时区的 'YYYY-MM-DD HH:MM:SS' 文本，便于字符串比较。
"""
import json
import os
import shutil
import sqlite3
import sys
import threading
from datetime import datetime

from backend import paths

BASE_DIR = paths.BASE_DIR
DATA_DIR = paths.DATA_DIR
BACKUP_DIR = paths.BACKUP_DIR
DB_PATH = paths.DB_PATH

_local = threading.local()

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- 数据源文件台账
-- 出库流程节点时间跟踪文件：单条逻辑归档，扫描变更时覆盖
CREATE TABLE IF NOT EXISTS outbound_archive (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT,
  path TEXT,
  sha256 TEXT,
  size INTEGER DEFAULT 0,
  rows INTEGER DEFAULT 0,
  sheets_json TEXT,
  rows_path TEXT,
  stored_bytes INTEGER DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS outbound_archive_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date TEXT NOT NULL,
  name TEXT,
  path TEXT,
  sha256 TEXT,
  size INTEGER DEFAULT 0,
  rows INTEGER DEFAULT 0,
  sheets_json TEXT,
  rows_path TEXT,
  stored_bytes INTEGER DEFAULT 0,
  archived_at TEXT,
  UNIQUE(biz_date, sha256)
);
CREATE INDEX IF NOT EXISTS ix_oa_snapshot_date ON outbound_archive_snapshots(biz_date);

CREATE TABLE IF NOT EXISTS source_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,
  name TEXT,
  size INTEGER DEFAULT 0,
  mtime REAL DEFAULT 0,
  kind TEXT,
  rows INTEGER DEFAULT 0,
  status TEXT DEFAULT 'ok',
  error TEXT,
  imported_at TEXT,
  biz_dates TEXT
);

-- 发运表行级事实（WMS）
CREATE TABLE IF NOT EXISTS ship_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_date TEXT,
  wave_no TEXT,
  wms_no TEXT,
  line_no TEXT,
  group_no TEXT,
  dealer_full TEXT,
  zone TEXT,
  doc_type TEXT,
  freight_free TEXT,
  part_code TEXT,
  part_name TEXT,
  qty REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  status TEXT,
  wave_time TEXT,
  pick_time TEXT,
  check_time TEXT,
  out_time TEXT,
  pick_qty REAL DEFAULT 0,
  out_qty REAL DEFAULT 0,
  mode TEXT,
  warehouse TEXT,
  erp_required TEXT,
  erp_status TEXT,
  erp_message TEXT,
  erp_time TEXT,
  src_file_id INTEGER,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_ship_line ON ship_lines(wms_no, line_no);
CREATE INDEX IF NOT EXISTS ix_ship_wave ON ship_lines(wave_no);
CREATE INDEX IF NOT EXISTS ix_ship_group ON ship_lines(group_no);
CREATE INDEX IF NOT EXISTS ix_ship_date ON ship_lines(order_date);

-- 运输单状态（TMS）
CREATE TABLE IF NOT EXISTS tms_status (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wave_no TEXT,
  status TEXT,
  carrier TEXT,
  group_no TEXT,
  src_file_id INTEGER,
  imported_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_tms ON tms_status(wave_no, group_no);
CREATE INDEX IF NOT EXISTS ix_tms_wave ON tms_status(wave_no);

-- 波次登记（系统内维护，软删除保留审计）
CREATE TABLE IF NOT EXISTS wave_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date TEXT NOT NULL,
  wave_no TEXT NOT NULL,
  note TEXT,
  carrier_override TEXT,
  deleted_at TEXT,
  created_by INTEGER,
  created_at TEXT,
  updated_by INTEGER,
  updated_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_wave ON wave_registry(biz_date, wave_no);

-- 经销商主数据（可在线维护）
CREATE TABLE IF NOT EXISTS dealer_map (
  full_name TEXT PRIMARY KEY,
  short_name TEXT,
  region TEXT,
  route TEXT,
  updated_at TEXT
);

-- 动力电池登记：订单组 + 备件编码的确认状态（业务数值实时从 ship_lines 取）
CREATE TABLE IF NOT EXISTS battery_confirmations (
  order_date TEXT NOT NULL,
  reg_date TEXT,
  group_no TEXT NOT NULL,
  part_code TEXT NOT NULL,
  confirmed_by INTEGER,
  confirmed_at TEXT,
  PRIMARY KEY(order_date, group_no, part_code)
);

-- 动力电池备件编码表（用于识别哪些发运行属于动力电池）
CREATE TABLE IF NOT EXISTS battery_parts (
  part_code TEXT PRIMARY KEY,
  part_name TEXT,
  updated_at TEXT
);

-- 动力电池经销商地址映射（来自 dealers.xlsx 的「动力电池」sheet）
CREATE TABLE IF NOT EXISTS battery_dealer_map (
  dealer_full TEXT PRIMARY KEY,
  dealer_short TEXT,
  zone TEXT,
  doc_type TEXT,
  freight_free TEXT,
  region TEXT,
  carrier TEXT,
  dest_city TEXT,
  address TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_battery_conf_date ON battery_confirmations(order_date);

-- 动力电池每日存档
CREATE TABLE IF NOT EXISTS battery_daily_archive (
  biz_date TEXT NOT NULL,
  reg_date TEXT,
  seq INTEGER NOT NULL,
  order_date TEXT,
  group_no TEXT,
  dealer_full TEXT,
  dealer_short TEXT,
  part_code TEXT,
  part_name TEXT,
  lines INTEGER DEFAULT 0,
  qty REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  picked INTEGER DEFAULT 0,
  checked INTEGER DEFAULT 0,
  zone TEXT,
  doc_type TEXT,
  freight_free TEXT,
  region TEXT,
  carrier TEXT,
  dest_city TEXT,
  address TEXT,
  address_matched INTEGER DEFAULT 0,
  confirmed INTEGER DEFAULT 0,
  archived_at TEXT,
  archived_by INTEGER,
  PRIMARY KEY(biz_date, order_date, group_no, part_code)
);
CREATE INDEX IF NOT EXISTS ix_battery_archive_date ON battery_daily_archive(biz_date, seq);

-- 每日快照（趋势数据来源）
CREATE TABLE IF NOT EXISTS daily_snapshot (
  biz_date TEXT PRIMARY KEY,
  groups INTEGER DEFAULT 0,
  lines INTEGER DEFAULT 0,
  amount REAL DEFAULT 0,
  waves INTEGER DEFAULT 0,
  out_rate REAL DEFAULT 0,
  ship_rate REAL DEFAULT 0,
  payload TEXT,
  built_at TEXT
);

-- 审计日志
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT,
  user_id INTEGER,
  username TEXT,
  ip TEXT,
  action TEXT,
  target TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_ts ON audit_log(ts DESC);

-- 用户 / 组 / 权限 / 数据范围
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT,
  pwd_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  must_change_pwd INTEGER DEFAULT 0,
  last_login_at TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);

CREATE TABLE IF NOT EXISTS group_permissions (
  group_id INTEGER NOT NULL,
  perm_code TEXT NOT NULL,
  effect TEXT DEFAULT 'allow',
  PRIMARY KEY (group_id, perm_code)
);

CREATE TABLE IF NOT EXISTS user_permissions (
  user_id INTEGER NOT NULL,
  perm_code TEXT NOT NULL,
  effect TEXT DEFAULT 'allow',
  PRIMARY KEY (user_id, perm_code)
);

CREATE TABLE IF NOT EXISTS data_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL,   -- 'group' | 'user'
  owner_id INTEGER NOT NULL,
  dim TEXT NOT NULL,          -- region | route | zone | doc_type | waves
  values_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at TEXT,
  expires_at TEXT,
  ip TEXT,
  ua TEXT
);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT,
  ip TEXT,
  ts REAL,
  ok INTEGER
);

-- 看板布局
CREATE TABLE IF NOT EXISTS dashboards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  owner_user_id INTEGER,
  visibility TEXT DEFAULT 'private',  -- private | shared
  is_default INTEGER DEFAULT 0,
  layout_json TEXT,
  version INTEGER DEFAULT 1,
  updated_at TEXT
);

-- 订单组级覆盖（按业务日生效，不动源数据）
CREATE TABLE IF NOT EXISTS order_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date TEXT NOT NULL,
  group_no TEXT NOT NULL,
  route_override TEXT,
  region_override TEXT,
  assign_override TEXT,
  note TEXT,
  include_flag INTEGER NOT NULL DEFAULT 1,   -- 1=计入本波次，0=已移出
  updated_by INTEGER,
  updated_at TEXT,
  UNIQUE(biz_date, group_no)
);

-- 每日订单组存档快照（与 daily_snapshot 的聚合指标区分开）
CREATE TABLE IF NOT EXISTS daily_archive (
  biz_date TEXT NOT NULL,
  seq INTEGER NOT NULL,
  group_no TEXT NOT NULL,
  wave_no TEXT,
  dealer_short TEXT,
  lines INTEGER DEFAULT 0,
  amount REAL DEFAULT 0,
  zone TEXT,
  doc_type TEXT,
  freight_free TEXT,
  region TEXT,
  route TEXT,
  tms_status TEXT,
  assignee TEXT,
  note TEXT,
  included INTEGER DEFAULT 1,
  archived_at TEXT,
  archived_by INTEGER,
  PRIMARY KEY (biz_date, group_no)
);
CREATE INDEX IF NOT EXISTS ix_archive_date ON daily_archive(biz_date, seq);

-- 线路预警设置：每条线路一个固定截止时间（HH:MM）
CREATE TABLE IF NOT EXISTS route_settings (
  route TEXT PRIMARY KEY,
  deadline TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT
);

-- 线路负责人（一个线路可多个账号）
CREATE TABLE IF NOT EXISTS route_owners (
  route TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  PRIMARY KEY (route, user_id)
);

-- 站内通知 / 预警消息
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  kind TEXT DEFAULT 'route_overdue',   -- route_due_soon | route_overdue
  level TEXT,                          -- info | warn | danger
  biz_date TEXT,
  route TEXT,
  title TEXT,
  body TEXT,
  created_at TEXT,
  read_at TEXT,
  dedupe_key TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(user_id, read_at, id DESC);

-- 人工校正工时（按人 × 工种 × 天 覆盖自动计算的有效小时）
CREATE TABLE IF NOT EXISTS labor_adjust (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date TEXT NOT NULL,
  person TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'all',   -- pick | check | all（老数据）
  hours REAL,
  note TEXT,
  updated_by INTEGER,
  updated_at TEXT,
  UNIQUE(biz_date, person, role)
);

-- 人工作业量每日归档（按作业日期 × 人 × 工种）
CREATE TABLE IF NOT EXISTS labor_archive (
  biz_date TEXT NOT NULL,
  person TEXT NOT NULL,
  role TEXT NOT NULL,                 -- pick | check
  rows INTEGER DEFAULT 0,
  groups INTEGER DEFAULT 0,
  hours_auto REAL DEFAULT 0,
  hours_used REAL DEFAULT 0,
  rate REAL,
  archived_at TEXT,
  archived_by INTEGER,
  PRIMARY KEY (biz_date, person, role)
);
CREATE INDEX IF NOT EXISTS ix_labor_archive_date ON labor_archive(biz_date, role, rows DESC);

-- 全局休息时段（用于人效工时扣除）
CREATE TABLE IF NOT EXISTS work_breaks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  start_time TEXT NOT NULL,          -- HH:MM
  end_time TEXT NOT NULL,            -- HH:MM
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  updated_at TEXT
);

-- 扫描文件归档：每个源文件路径只保留最新一版（原文件副本 + 行数据快照）
CREATE TABLE IF NOT EXISTS source_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,          -- 源文件完整路径
  name TEXT,
  kind TEXT,                          -- ship / tms / dealer
  size INTEGER DEFAULT 0,
  sha256 TEXT,
  rows INTEGER DEFAULT 0,             -- 数据行数（不含表头）
  scan_at TEXT,
  file_path TEXT,                     -- 历史字段：原文件副本（v11 起不再写入）
  rows_path TEXT,                     -- 相对 data/ 的行快照（jsonl.gz）
  stored_bytes INTEGER DEFAULT 0,     -- 行快照实际占用字节
  sheets_json TEXT,                   -- [{"name":..,"headers":[..],"rows":N}]
  preview_json TEXT,                  -- 预览：各 sheet 前 100 行
  biz_dates TEXT,                     -- 逗号分隔的业务日期
  source_file_id INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS ix_source_archive_scan ON source_archive(scan_at);

INSERT OR IGNORE INTO meta(key, value) VALUES ('data_version', '1');
INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '5');
"""

# 经销商查找视图：全称优先（prio 0），匹配不到再用简称（prio 1）。
# 简称重名时按 full_name 字典序取一条，保证结果确定。
DEALER_VIEW = """
DROP VIEW IF EXISTS dealer_lookup;
CREATE VIEW dealer_lookup AS
SELECT key, short_name, region, route FROM (
  SELECT key, short_name, region, route,
         ROW_NUMBER() OVER (PARTITION BY key ORDER BY prio, full_name) AS rn
  FROM (
    SELECT full_name AS key, short_name, region, route, 0 AS prio, full_name
      FROM dealer_map WHERE full_name IS NOT NULL AND full_name <> ''
    UNION ALL
    SELECT short_name AS key, short_name, region, route, 1 AS prio, full_name
      FROM dealer_map WHERE short_name IS NOT NULL AND short_name <> ''
  )
) WHERE rn = 1;
"""


def now_str():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def today_str():
    return datetime.now().strftime("%Y-%m-%d")


def connect():
    """返回当前线程的连接（自动创建并建表）。"""
    conn = getattr(_local, "conn", None)
    if conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=20, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=20000")
        # 临时表/排序溢写强制走内存，不依赖 OS 临时目录（%TEMP%）。
        # SQLite 默认 temp_store=0（文件临时表）：GROUP BY / ORDER BY 大结果集时排序器
        # 会溢写到 %TEMP% 下的临时文件；部署机上 %TEMP% 不可用（受限服务账户、沙箱等）时
        # SQLite 打不开临时文件就抛 SQLITE_CANTOPEN，表现为 "unable to open database file"，
        # 让 /api/meta、/api/sources 这类只读查询整站 500。
        conn.execute("PRAGMA temp_store=MEMORY")
        _local.conn = conn
    return conn


def init_db():
    conn = connect()
    conn.executescript(SCHEMA)
    _migrate(conn)
    ensure_views(conn)
    return conn


def ensure_views(conn):
    """重建依赖视图（dealer_map 变更后口径立即生效）。"""
    try:
        conn.executescript(DEALER_VIEW)
    except sqlite3.Error:
        pass


def _ensure_column(conn, table, column, decl):
    """幂等加列（老库升级用）。"""
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(%s)" % table)}
    if column not in cols:
        conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, column, decl))


def _migrate(conn):
    """老库升级。

    1. 发运明细唯一键收敛为 (wms单号,行号)：同一行的订单组号变化时更新原行，
       不生成重复行；旧库先按最新来源去重。
    2. 人员列（拣货人/复核人/组波人）：人工作业量统计需要。
    3. 看板页槽位 page_key：让"发布为公共"能替换导航页。
    """
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_ship_line'"
    ).fetchone()
    old_index = bool(row and row["sql"] and "group_no" in row["sql"])
    if old_index:
        try:
            os.makedirs(BACKUP_DIR, exist_ok=True)
            backup = os.path.join(BACKUP_DIR, "dashboard_before_ship_identity.db")
            if os.path.isfile(DB_PATH) and not os.path.isfile(backup):
                shutil.copy2(DB_PATH, backup)
                print("已备份数据库：%s" % backup, file=sys.stderr)
        except OSError:
            pass
        conn.execute("DROP INDEX IF EXISTS ux_ship_line")
        before = conn.execute("SELECT COUNT(*) AS c FROM ship_lines").fetchone()["c"]
        conn.execute(
            "DELETE FROM ship_lines WHERE id NOT IN ("
            " SELECT id FROM ("
            "  SELECT id, ROW_NUMBER() OVER ("
            "   PARTITION BY wms_no, line_no "
            "   ORDER BY src_file_id DESC, updated_at DESC, id DESC"
            "  ) AS rn FROM ship_lines"
            " ) WHERE rn=1"
            ")"
        )
        after = conn.execute("SELECT COUNT(*) AS c FROM ship_lines").fetchone()["c"]
        conn.execute("CREATE UNIQUE INDEX ux_ship_line ON ship_lines(wms_no, line_no)")
        print("发运明细唯一键迁移：%d -> %d 行" % (before, after), file=sys.stderr)
    _ensure_column(conn, "source_files", "biz_dates", "TEXT")
    _ensure_column(conn, "battery_dealer_map", "dealer_short", "TEXT")
    try:
        if get_meta(conn, "overdue_table_widget_v1") != "1":
            for dash in conn.execute("SELECT id, layout_json FROM dashboards").fetchall():
                try:
                    layout = json.loads(dash["layout_json"] or "{}")
                except ValueError:
                    continue
                touched = False
                for widget in layout.get("widgets") or []:
                    title = str(widget.get("title") or "")
                    spec = widget.get("spec") or {}
                    if widget.get("type") == "alert" and spec.get("dataset") == "alerts" and any(
                        word in title for word in ("超期", "超时", "未复核")
                    ):
                        widget["type"] = "table"
                        widget["spec"] = {"dataset": "overdue", "limit": 200}
                        touched = True
                if touched:
                    conn.execute("UPDATE dashboards SET layout_json=?, updated_at=? WHERE id=?",
                                 (json.dumps(layout, ensure_ascii=False), now_str(), dash["id"]))
            set_meta(conn, "overdue_table_widget_v1", "1")
    except sqlite3.Error:
        pass
    _ensure_column(conn, "battery_confirmations", "reg_date", "TEXT")
    _ensure_column(conn, "battery_daily_archive", "reg_date", "TEXT")
    conn.execute("UPDATE battery_confirmations SET reg_date=substr(confirmed_at,1,10) "
                 "WHERE (reg_date IS NULL OR reg_date='') AND confirmed_at IS NOT NULL")
    conn.execute("UPDATE battery_daily_archive SET reg_date=biz_date WHERE reg_date IS NULL OR reg_date=''")
    # 系统订单/已登记四张卡：补齐“较上日比较”配置（只改属性，不覆盖布局）
    try:
        if get_meta(conn, "compare_cards_v1") != "1":
            changed = 0
            for dash in conn.execute("SELECT id, layout_json FROM dashboards").fetchall():
                try:
                    layout = json.loads(dash["layout_json"] or "{}")
                except ValueError:
                    continue
                touched = False
                for widget in layout.get("widgets") or []:
                    if widget.get("type") != "kpi":
                        continue
                    spec = widget.get("spec") or {}
                    metrics = spec.get("metrics") or []
                    if spec.get("dataset") == "coverage" and any(
                        m in ("rows", "amount", "registered_lines", "registered_amount") for m in metrics
                    ):
                        if not spec.get("compare"):
                            spec["compare"] = True
                            widget["spec"] = spec
                            touched = True
                if touched:
                    conn.execute(
                        "UPDATE dashboards SET layout_json=?, updated_at=? WHERE id=?",
                        (json.dumps(layout, ensure_ascii=False), now_str(), dash["id"]),
                    )
                    changed += 1
            set_meta(conn, "compare_cards_v1", "1")
            if changed:
                print("已为 %d 个看板的系统订单/已登记卡片启用较上日比较" % changed, file=sys.stderr)
    except sqlite3.Error:
        pass
    # 总览补“今日动力电池登记”表格组件（保留原布局，只追加缺失组件）
    try:
        if get_meta(conn, "battery_table_widget_v1") != "1":
            for dash in conn.execute("SELECT id, layout_json FROM dashboards WHERE page_key='overview'").fetchall():
                try:
                    layout = json.loads(dash["layout_json"] or "{}")
                except ValueError:
                    continue
                widgets = layout.get("widgets") or []
                if any((w.get("spec") or {}).get("dataset") == "battery" for w in widgets):
                    continue
                max_y = max([(w.get("y") or 0) + (w.get("h") or 0) for w in widgets] or [0])
                widgets.append({
                    "id": "pg-ov-battery", "type": "table", "title": "今日动力电池登记",
                    "spec": {"dataset": "battery", "limit": 200},
                    "x": 0, "y": max_y + 1, "w": 12, "h": 7,
                })
                layout["widgets"] = widgets
                conn.execute("UPDATE dashboards SET layout_json=?, updated_at=? WHERE id=?",
                             (json.dumps(layout, ensure_ascii=False), now_str(), dash["id"]))
            set_meta(conn, "battery_table_widget_v1", "1")
    except sqlite3.Error:
        pass
    _ensure_column(conn, "ship_lines", "pick_person", "TEXT")
    _ensure_column(conn, "ship_lines", "erp_required", "TEXT")
    _ensure_column(conn, "ship_lines", "erp_status", "TEXT")
    _ensure_column(conn, "ship_lines", "erp_message", "TEXT")
    _ensure_column(conn, "ship_lines", "erp_time", "TEXT")
    _ensure_column(conn, "source_archive", "stored_bytes", "INTEGER DEFAULT 0")
    _ensure_column(conn, "ship_lines", "check_person", "TEXT")
    _ensure_column(conn, "ship_lines", "wave_person", "TEXT")
    _ensure_column(conn, "dashboards", "page_key", "TEXT")
    _ensure_column(conn, "users", "pwd_is_default", "INTEGER DEFAULT 0")
    # v18：dealers.xlsx 增加「动力电池」sheet，旧文件台账会因未变化跳过，强制重扫一次
    try:
        if get_meta(conn, "battery_dealer_import_v1") != "1":
            conn.execute("UPDATE source_files SET mtime=0 WHERE name = 'dealers.xlsx'")
            set_meta(conn, "battery_dealer_import_v1", "1")
    except sqlite3.Error:
        pass
    try:
        conn.execute("CREATE INDEX IF NOT EXISTS ix_ship_pick_person ON ship_lines(pick_person)")
        conn.execute("CREATE INDEX IF NOT EXISTS ix_ship_check_person ON ship_lines(check_person)")
    except sqlite3.Error:
        pass

    # 人效工时：默认相邻间隔阈值 30 分钟 + 默认午休 12:00-13:00（只在为空时种一次）
    try:
        if not conn.execute("SELECT 1 FROM work_breaks LIMIT 1").fetchone():
            conn.execute(
                "INSERT INTO work_breaks(start_time, end_time, enabled, note, updated_at) "
                "VALUES('12:00','13:00',1,'午休',?)",
                (now_str(),),
            )
        if get_meta(conn, "labor_gap_minutes") is None:
            set_meta(conn, "labor_gap_minutes", "30")
    except sqlite3.Error:
        pass

    # 人工校正工时：加 role（拣货/复核分开），唯一键变成 (日期, 人, 工种)
    cols = {row["name"] for row in conn.execute("PRAGMA table_info(labor_adjust)")}
    if cols and "role" not in cols:
        conn.executescript(
            """
            ALTER TABLE labor_adjust RENAME TO labor_adjust_old;
            CREATE TABLE labor_adjust (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              biz_date TEXT NOT NULL,
              person TEXT NOT NULL,
              role TEXT NOT NULL DEFAULT 'all',
              hours REAL,
              note TEXT,
              updated_by INTEGER,
              updated_at TEXT,
              UNIQUE(biz_date, person, role)
            );
            INSERT INTO labor_adjust(id, biz_date, person, role, hours, note, updated_by, updated_at)
              SELECT id, biz_date, person, 'all', hours, note, updated_by, updated_at
              FROM labor_adjust_old;
            DROP TABLE labor_adjust_old;
            """
        )


def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn, key, value):
    conn.execute(
        "INSERT INTO meta(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def bump_version(conn):
    """数据版本号 +1，用于前端判断是否需要刷新。"""
    cur = int(get_meta(conn, "data_version", "1") or 1)
    cur += 1
    set_meta(conn, "data_version", cur)
    return cur


def get_version(conn):
    return int(get_meta(conn, "data_version", "1") or 1)


def audit(conn, user, ip, action, target="", detail=""):
    """写审计日志。user 可为 None。"""
    uid = user["id"] if user else None
    uname = (user["username"] if user else "") or ""
    try:
        conn.execute(
            "INSERT INTO audit_log(ts, user_id, username, ip, action, target, detail) "
            "VALUES(?,?,?,?,?,?,?)",
            (now_str(), uid, uname, ip or "", action, str(target or ""), _truncate(detail)),
        )
    except Exception:
        pass


def _truncate(value, limit=4000):
    if value is None:
        return ""
    if not isinstance(value, str):
        try:
            value = json.dumps(value, ensure_ascii=False)
        except Exception:
            value = str(value)
    return value[:limit]


def transaction(conn):
    """上下文管理器式的简单事务。

    服务里的连接是 autocommit（isolation_level=None），直接 BEGIN 即可；
    命令行脚本用的是默认隔离级别，执行过语句后已经处在隐式事务里，
    这时先提交再开新事务，避免 "cannot start a transaction within a transaction"。
    """
    class _Tx:
        def __enter__(self_inner):
            if getattr(conn, "in_transaction", False):
                conn.commit()
            conn.execute("BEGIN IMMEDIATE")
            return conn

        def __exit__(self_inner, exc_type, exc, tb):
            if exc_type is None:
                conn.execute("COMMIT")
            else:
                conn.execute("ROLLBACK")
            return False

    return _Tx()
