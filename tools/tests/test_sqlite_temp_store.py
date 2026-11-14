# -*- coding: utf-8 -*-
"""SQLite 临时表回归测试：验证 db.connect() 不依赖 OS 临时目录（%TEMP%）。

背景：v3.9 自带的 SQLite 3.33 默认 temp_store=0（文件临时表）。biz_dates 里
`SELECT substr(pick_time,1,10) ... GROUP BY d` 这类表达式分组没有索引可用，排序器
会溢写到「磁盘临时文件」。部署机上 %TEMP% 不可写时 SQLite 打不开临时文件，抛
`sqlite3.OperationalError: unable to open database file`（SQLITE_CANTOPEN），
导致 GET /api/meta、GET /api/sources 全站 500。

本测试
1. 用 sqlite backup API 把线上库复制到「仓库外可写目录」下的临时目录（不碰真实 data/）；
2. 在子进程里把 TEMP/TMP 指向一个不存在的目录，复现：
   - 未设置 temp_store 的裸 sqlite3 连接执行那两条 GROUP BY 会抛 OperationalError；
   - 走 backend.core.db.connect() 的连接上 rules.biz_dates(conn) 正常返回且含今天；
3. 全部临时文件在结束时清理。

用法：
    .\\.venv\\Scripts\\python.exe tools/tests/test_sqlite_temp_store.py

注意：必须用 .venv 里的 Python 3.9（SQLite 3.33）运行才有回归意义。
"""
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)

FAILS = []

#: 实测（sqlite 3.33 / 4KB page）：默认 temp_store 时排序器 PMA 约 1MB，
#: 表达式 GROUP BY 的输入超过 42666 行就会溢写到磁盘临时文件。
#: 数据量不够时测试会把副本里的行数补足，保证回归证明稳定可复现。
SPILL_ROWS = 42667
SPILL_ROWS_SAFE = SPILL_ROWS + 100

PICK_SQL = (
    "SELECT substr(pick_time,1,10) AS d, COUNT(*) AS n FROM ship_lines "
    "WHERE pick_time <> '' AND pick_person IS NOT NULL AND pick_person <> '' GROUP BY d"
)
CHECK_SQL = (
    "SELECT substr(check_time,1,10) AS d, COUNT(*) AS n FROM ship_lines "
    "WHERE check_time <> '' AND check_person IS NOT NULL AND check_person <> '' GROUP BY d"
)

#: 子进程里跑的检查脚本：TEMP/TMP 已在父进程注入为不存在的目录。
CHILD_SCRIPT = r'''# -*- coding: utf-8 -*-
"""由 test_sqlite_temp_store.py 在「TEMP 不可用」的子进程里执行。"""
import json
import os
import sqlite3
import sys

base, copy_db = sys.argv[1], sys.argv[2]
sys.path.insert(0, base)
from backend.core import db      # noqa: E402
from backend.domain import rules  # noqa: E402

PICK_SQL = (
    "SELECT substr(pick_time,1,10) AS d, COUNT(*) AS n FROM ship_lines "
    "WHERE pick_time <> '' AND pick_person IS NOT NULL AND pick_person <> '' GROUP BY d"
)
CHECK_SQL = (
    "SELECT substr(check_time,1,10) AS d, COUNT(*) AS n FROM ship_lines "
    "WHERE check_time <> '' AND check_person IS NOT NULL AND check_person <> '' GROUP BY d"
)


def run(conn, sql):
    try:
        rows = conn.execute(sql).fetchall()
        return {"ok": True, "rows": len(rows)}
    except sqlite3.OperationalError as exc:
        return {"ok": False, "error": str(exc)}


out = {
    "sqlite_version": sqlite3.sqlite_version,
    "gettempdir": __import__("tempfile").gettempdir(),
    "env_temp": os.environ.get("TEMP"),
}

# [1] 回归价值：默认 temp_store 的裸连接在 TEMP 不可用时炸 CANTOPEN
plain = sqlite3.connect(copy_db, timeout=30)
plain.row_factory = sqlite3.Row
out["plain_pick"] = run(plain, PICK_SQL)
out["plain_check"] = run(plain, CHECK_SQL)
# [2] 对照：同一条连接手动改成内存临时表后查询恢复
plain.execute("PRAGMA temp_store=MEMORY")
out["memsql_pick"] = run(plain, PICK_SQL)
out["memsql_check"] = run(plain, CHECK_SQL)
plain.close()

# [3] 修复后的连接（monkeypatch 模块级路径到副本）必须能跑 biz_dates
db.DB_PATH = copy_db
db.DATA_DIR = os.path.dirname(copy_db)
try:
    conn = db.connect()
    out["temp_store"] = conn.execute("PRAGMA temp_store").fetchone()[0]
    out["journal_mode"] = conn.execute("PRAGMA journal_mode").fetchone()[0]
    rows = rules.biz_dates(conn)
    out["biz"] = {
        "ok": True,
        "count": len(rows),
        "dates": [r["biz_date"] for r in rows],
        "today": db.today_str(),
    }
except Exception as exc:  # noqa: BLE001 - 需要把任何失败带回父进程展示
    out["biz"] = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}

print(json.dumps(out))
'''


def check(name, ok, detail=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + str(detail)) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def pick_work_dir():
    """挑一个「可写、且不依赖 tempfile.gettempdir()」的临时目录。

    %TEMP% 不可写时，tempfile.gettempdir() 会静默回退到当前工作目录（仓库根），
    仓库里就会冒出 *_test_* 目录。所以这里显式按顺序试：环境变量 → 仓库父目录
    （仓库外）→ 仓库内 tools/tests（兜底），每个候选都实际写一个探针文件确认可写。
    """
    candidates = []
    env = (os.environ.get("WORK_ATLAS_TEST_TMP") or "").strip()
    if env:
        candidates.append(env)
    candidates.append(os.path.dirname(BASE))                     # 仓库父目录：仓库外
    candidates.append(os.path.join(BASE, "tools", "tests"))      # 兜底：仓库内一定能写

    name = "wat_temp_store_test_%d_%d" % (os.getpid(), int(time.time()))
    last_error = None
    for parent in candidates:
        try:
            os.makedirs(parent, exist_ok=True)
            work = os.path.join(parent, name)
            os.makedirs(work)
            probe = os.path.join(work, ".write_probe")
            with open(probe, "w") as fh:
                fh.write("ok")
            os.remove(probe)
            return work
        except OSError as exc:
            last_error = exc
            try:
                shutil.rmtree(os.path.join(parent, name), ignore_errors=True)
            except OSError:
                pass
            continue
    raise RuntimeError("找不到可写临时目录（最后错误：%r）" % (last_error,))


def backup_live_db(src_path, dst_path):
    """用 backup API 从线上库取一致快照（避免直接复制正在写的 WAL 库读到半写页面）。"""
    uri = "file:" + src_path.replace("\\", "/") + "?mode=ro"
    last_error = None
    for attempt in range(3):
        try:
            src = sqlite3.connect(uri, uri=True, timeout=30)
            try:
                dst = sqlite3.connect(dst_path, timeout=30)
                try:
                    src.backup(dst)
                finally:
                    dst.close()
            finally:
                src.close()
            return
        except sqlite3.OperationalError as exc:
            last_error = exc
            time.sleep(0.5 * (attempt + 1))
    raise last_error


def filtered_rows(conn, col):
    person = col.replace("_time", "_person")
    return conn.execute(
        "SELECT COUNT(*) FROM ship_lines "
        "WHERE %s <> '' AND %s IS NOT NULL AND %s <> ''" % (col, person, person)
    ).fetchone()[0]


def prepare_spill_volume(copy_db):
    """保证副本里两条 GROUP BY 的输入行数足以触发排序器溢写（数据少时补行）。"""
    conn = sqlite3.connect(copy_db, timeout=30)
    try:
        counts = {}
        cols = [row[1] for row in conn.execute("PRAGMA table_info(ship_lines)") if row[1] != "id"]
        col_list = ", ".join(cols)
        for col in ("pick_time", "check_time"):
            person = col.replace("_time", "_person")
            cond = "%s <> '' AND %s IS NOT NULL AND %s <> ''" % (col, person, person)
            n = filtered_rows(conn, col)
            if 0 < n < SPILL_ROWS_SAFE:
                # 副本里没有唯一索引约束，重复行不影响被验证的 GROUP BY 语义
                conn.execute("DROP INDEX IF EXISTS ux_ship_line")
                while n < SPILL_ROWS_SAFE:
                    need = SPILL_ROWS_SAFE - n
                    conn.execute(
                        "INSERT INTO ship_lines (%s) SELECT %s FROM ship_lines WHERE %s LIMIT %d"
                        % (col_list, col_list, cond, need)
                    )
                    grown = filtered_rows(conn, col)
                    if grown == n:
                        break
                    n = grown
            counts[col] = n
        conn.commit()
        return counts
    finally:
        conn.close()


def main():
    live_db = os.path.join(BASE, "data", "dashboard.db")
    if not os.path.isfile(live_db):
        print("找不到 data/dashboard.db，跳过（本测试依赖真实库副本）。")
        return 0

    work = pick_work_dir()
    print("临时目录：", work)
    try:
        copy_db = os.path.join(work, "dashboard.db")
        t0 = time.time()
        backup_live_db(live_db, copy_db)
        print("数据库副本：", copy_db, "(%.2fs)" % (time.time() - t0))
        counts = prepare_spill_volume(copy_db)
        print("输入行数：pick=%d check=%d（溢写阈值 %d 行）"
              % (counts.get("pick_time", 0), counts.get("check_time", 0), SPILL_ROWS))

        # TEMP/TMP 指向一个「确实不存在」的目录：SQLite 取临时目录时不校验存在性，
        # 溢写时打不开就直接 CANTOPEN，不依赖本机是否恰好不可写 %TEMP%。
        fake_temp = os.path.join(work, "__no_such_temp_dir__")
        assert not os.path.isdir(fake_temp)
        env = dict(os.environ)
        for key in ("TEMP", "TMP", "TMPDIR", "SQLITE_TMPDIR"):
            env[key] = fake_temp

        script = os.path.join(work, "_child_check.py")
        with open(script, "w", encoding="utf-8") as fh:
            fh.write(CHILD_SCRIPT)
        proc = subprocess.run(
            [sys.executable, script, BASE, copy_db],
            cwd=BASE, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=300,
        )
        stdout = proc.stdout.decode("utf-8", "replace").strip()
        stderr = proc.stderr.decode("utf-8", "replace").strip()
        if proc.returncode != 0 or not stdout:
            print("子进程执行失败（code=%s）：\n%s" % (proc.returncode, stderr[-4000:]))
            check("子进程在 TEMP 不可用环境下执行检查脚本", False, "code=%s" % proc.returncode)
            return finish()

        lines = stdout.splitlines()
        data = json.loads(lines[-1])
        print("子进程见到的 gettempdir=%r，TEMP=%r（不可写/不存在）"
              % (data.get("gettempdir"), data.get("env_temp")))

        # 回归价值：默认 temp_store 的裸连接必须复现 CANTOPEN
        enough = (counts.get("pick_time", 0) >= SPILL_ROWS
                  and counts.get("check_time", 0) >= SPILL_ROWS)
        for label, key in (("pick_time GROUP BY", "plain_pick"), ("check_time GROUP BY", "plain_check")):
            res = data.get(key) or {}
            ok = (not res.get("ok")) and "unable to open database file" in str(res.get("error", ""))
            if enough:
                check("裸连接复现 CANTOPEN：%s（未设 temp_store）" % label, ok, str(res))
            elif res.get("ok"):
                print("  [SKIP] 裸连接未复现 CANTOPEN：%s（数据量不足或该 SQLite 不溢写）" % label)
            else:
                check("裸连接复现 CANTOPEN：%s（未设 temp_store）" % label, ok, str(res))

        # 对照组：同一份副本手动 temp_store=MEMORY 后查询能跑通，证明失败只来自临时表落盘
        for label, key in (("pick_time GROUP BY", "memsql_pick"),
                           ("check_time GROUP BY", "memsql_check")):
            res = data.get(key) or {}
            check("对照组：手动 temp_store=MEMORY 后 %s 正常" % label, bool(res.get("ok")), str(res))

        # 修复本身：db.connect() 必须设置内存临时表，并且 biz_dates 在 TEMP 不可用时成功
        check("db.connect() 的 PRAGMA temp_store 为 MEMORY(2)", data.get("temp_store") == 2,
              "temp_store=%r" % (data.get("temp_store"),))
        biz = data.get("biz") or {}
        check("TEMP 不可用时 db.connect() 上 rules.biz_dates 正常返回",
              bool(biz.get("ok")), str(biz))
        if biz.get("ok"):
            dates = biz.get("dates") or []
            check("biz_dates 结果非空", biz.get("count", 0) > 0, "count=%r" % (biz.get("count"),))
            check("biz_dates 结果包含今天 %s" % biz.get("today"), biz.get("today") in dates,
                  "dates=%r" % (dates[:5],))
        return finish()
    finally:
        shutil.rmtree(work, ignore_errors=True)


def finish():
    print("")
    if FAILS:
        print("失败 %d 项：%s" % (len(FAILS), "、".join(FAILS)))
        return 1
    print("全部通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
