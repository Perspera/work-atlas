# -*- coding: utf-8 -*-
"""一键运行 tools/tests 下的单元测试。

用法：
    python tools/tests/run_all.py
    python tools/tests/run_all.py --with-smoke http://127.0.0.1:8787

说明：
- 默认只跑 test_*.py（各自使用临时库副本，不影响线上数据）；
- --with-smoke 会额外运行 smoke_test.py，需要先启动服务。
"""
import glob
import os
import subprocess
import sys

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TESTS_DIR = os.path.dirname(os.path.abspath(__file__))


def main(argv):
    include_smoke = "--with-smoke" in argv
    targets = sorted(glob.glob(os.path.join(TESTS_DIR, "test_*.py")))
    if include_smoke:
        targets.append(os.path.join(TESTS_DIR, "smoke_test.py"))

    failed = []
    for path in targets:
        name = os.path.basename(path)
        print("=== %s ===" % name)
        code = subprocess.call([sys.executable, path], cwd=BASE)
        if code != 0:
            failed.append(name)

    print("")
    if failed:
        print("失败：%s" % ", ".join(failed))
        return 1
    print("全部通过（%d 个脚本）" % len(targets))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
