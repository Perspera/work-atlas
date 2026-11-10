# -*- coding: utf-8 -*-
"""校验下载文件：扩展名/文件大小之外，检查 Excel/CSV 表头与数据行。

用法：
    python validate_download.py <file> '["订单日期","波次号"]'
退出码：0 通过，2 失败；stdout 为简短说明。
"""
import csv
import json
import os
import sys


def fail(message):
    print(message)
    return 2


def read_headers(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".xlsx", ".xlsm"):
        try:
            import openpyxl
        except ImportError:
            print("未安装 openpyxl，跳过表头校验")
            return None, 0
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb.active
        rows = ws.iter_rows(values_only=True)
        try:
            header = next(rows)
        except StopIteration:
            return [], 0
        headers = [str(c).strip() if c is not None else "" for c in header]
        count = 0
        for _ in rows:
            count += 1
        wb.close()
        return headers, count
    if ext == ".csv":
        with open(path, "r", encoding="utf-8-sig", newline="") as fh:
            reader = csv.reader(fh)
            try:
                header = next(reader)
            except StopIteration:
                return [], 0
            headers = [str(c).strip() for c in header]
            count = sum(1 for _ in reader)
        return headers, count
    if ext == ".xls":
        # 旧版 xls 没有 openpyxl 支持；只做大小/扩展名校验，交给看板导入层识别
        return None, 0
    return None, 0


def main():
    if len(sys.argv) < 2:
        return fail("用法：validate_download.py <file> [requiredHeadersJson]")
    path = sys.argv[1]
    if not os.path.isfile(path):
        return fail("文件不存在：%s" % path)
    required = []
    if len(sys.argv) > 2:
        try:
            required = json.loads(sys.argv[2])
        except ValueError:
            return fail("requiredHeaders 不是合法 JSON")
    headers, rows = read_headers(path)
    if headers is None:
        print("已跳过表头校验（格式 %s）" % os.path.splitext(path)[1])
        return 0
    if not headers:
        return fail("文件没有表头")
    missing = [h for h in required if h not in headers]
    if missing:
        return fail("缺少必需表头：%s；实际表头：%s" % ("、".join(missing), "、".join(headers[:15])))
    if rows <= 0:
        return fail("文件只有表头，没有数据行")
    print("表头 OK，数据 %d 行" % rows)
    return 0


if __name__ == "__main__":
    sys.exit(main())
