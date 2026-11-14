# -*- coding: utf-8 -*-
"""WMS 数据源页配置/状态单元测试（临时目录，不碰真实配置）。"""
import json
import os
import shutil
import sys
import tempfile

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, BASE)

from backend.wms import wms_manage  # noqa: E402

FAILS = []


def check(name, ok, detail=""):
    print(("  [OK]   " if ok else "  [FAIL] ") + name + (("  " + str(detail)) if detail and not ok else ""))
    if not ok:
        FAILS.append(name)


def main():
    src = os.path.join(BASE, "tools", "wms_download", "wms.config.json")
    tmp = tempfile.mkdtemp(prefix="wms_manage_test_")
    old = (wms_manage.AUTO_DIR, wms_manage.CONFIG_PATH, wms_manage.BACKUP_PATH)
    wms_manage.AUTO_DIR = tmp
    wms_manage.CONFIG_PATH = os.path.join(tmp, "wms.config.json")
    wms_manage.BACKUP_PATH = wms_manage.CONFIG_PATH + ".bak"
    try:
        with open(src, "r", encoding="utf-8") as fh:
            original = json.load(fh)
        # 基线固定日期清空：开发机配置可能临时设了 fixedDate，否则「fixed 但日期为空
        # 应被拒绝」的断言会因 save_config 回退读取基线值而失效。
        original["fixedDate"] = ""
        with open(wms_manage.CONFIG_PATH, "w", encoding="utf-8") as fh:
            json.dump(original, fh, ensure_ascii=False, indent=2)
        saved = wms_manage.save_config({
            "url": "https://wms.wanyouauto.com.cn/portal.do",
            "dateMode": "today",
            "fixedDate": "",
            "relativeDays": 0,
            "deliverDir": r"Z:\\单据登记\\测试",
            "schedule": {"mode": "interval", "intervalMinutes": 10, "startTime": "08:00", "endTime": "21:00"},
        })
        check("保存后保留菜单/查询/登录高级配置",
              saved.get("menuItemText") == original.get("menuItemText") and
              saved.get("query", {}).get("exportDialog") and
              saved.get("login", {}).get("skip") is True)
        check("保存 schedule", saved["schedule"]["intervalMinutes"] == 10, str(saved.get("schedule")))
        check("备份文件存在", os.path.isfile(wms_manage.BACKUP_PATH))
        public = wms_manage.public_config(saved)
        check("公开配置不包含密码/选择器",
              "query" not in public and "login" not in public and "password" not in json.dumps(public))
        for bad in (
            {"url": "not-a-url", "dateMode": "today", "deliverDir": r"Z:\\x"},
            {"url": "https://x", "dateMode": "today", "deliverDir": "relative"},
            {"url": "https://x", "dateMode": "fixed", "fixedDate": "", "deliverDir": r"Z:\\x"},
            {"url": "https://x", "dateMode": "today", "deliverDir": r"Z:\\x",
             "schedule": {"mode": "interval", "intervalMinutes": 0, "startTime": "08:00", "endTime": "21:00"}},
            {"url": "https://x", "dateMode": "today", "deliverDir": r"Z:\\x",
             "schedule": {"mode": "daily", "times": ["25:00"]}},
        ):
            try:
                wms_manage.save_config(bad)
                check("非法配置被拒：%s" % bad, False)
            except wms_manage.WmsError:
                check("非法配置被拒：%s" % list(bad.keys()), True)
        print("")
        # ---- 回归：外部命令输出编码（2026-11-14 /api/wms-download/schedule 500）
        # 服务在 PyCharm 里带 PYTHONIOENCODING=utf-8 启动时，子进程按 UTF-8 打印，
        # 而 subprocess.run(text=True) 按 GBK 解码，读线程抛 UnicodeDecodeError，
        # 又被 Python 3.9 掩盖成 IndexError。这里锁定"字节捕获 + 显式解码"的修法。
        sample = "已安装任务：WMS-Daily-Download（08:00-21:00，每 10 分钟）"
        check("_decode_output 解码 UTF-8 字节", wms_manage._decode_output(sample.encode("utf-8")) == sample)
        check("_decode_output 解码 GBK 字节", wms_manage._decode_output(sample.encode("gbk")) == sample)
        check("_decode_output 空输出", wms_manage._decode_output(b"") == "")
        check("_python_env 强制 PYTHONIOENCODING=utf-8",
              wms_manage._python_env().get("PYTHONIOENCODING") == "utf-8")
        code, out, err = wms_manage._run_capture(
            [sys.executable, "-c", "print(%r)" % sample],
            timeout=60,
            env=wms_manage._python_env(),
        )
        check("子进程中文输出不乱码、不抛异常",
              code == 0 and sample in out, "rc=%s err=%r out=%r" % (code, err, out))
        try:
            wms_manage.apply_schedule("bogus")
            check("未知定时任务操作被拒", False)
        except wms_manage.WmsError:
            check("未知定时任务操作被拒", True)
        print("")
        if FAILS:
            print("失败 %d 项：%s" % (len(FAILS), "、".join(FAILS)))
            return 1
        print("全部通过。")
        return 0
    finally:
        wms_manage.AUTO_DIR, wms_manage.CONFIG_PATH, wms_manage.BACKUP_PATH = old
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
