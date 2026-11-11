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
