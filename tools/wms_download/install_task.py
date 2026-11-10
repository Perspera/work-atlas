# -*- coding: utf-8 -*-
"""安装/更新 WMS 定时下载任务（Windows 任务计划）。

用法：
    python install_task.py                 # 读取 wms.config.json 的 schedule
    python install_task.py --task WMS-Daily-Download
    python install_task.py --remove
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta

ROOT = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(ROOT, "wms.config.json")
BAT = os.path.join(ROOT, "run_wms_download.bat")
VBS = os.path.join(ROOT, "run_wms_download.vbs")
TASK_DEFAULT = "WMS-Daily-Download"

VBS_CONTENT = """' WMS download hidden launcher (no console window)\r
Option Explicit\r
Dim shell, fso, base, bat, code\r
Set shell = CreateObject(\"WScript.Shell\")\r
Set fso = CreateObject(\"Scripting.FileSystemObject\")\r
base = fso.GetParentFolderName(WScript.ScriptFullName)\r
bat = base & \"\\run_wms_download.bat\"\r
shell.CurrentDirectory = base\r
code = shell.Run(\"cmd.exe /c \"\"\" & bat & \"\"\"\", 0, True)\r
WScript.Quit code\r
"""


def ensure_launcher():
    """任务动作依赖的 VBS 必须存在；缺失时自愈，避免任务结果 1。"""
    if not os.path.isfile(BAT):
        raise RuntimeError("找不到批处理启动器：%s" % BAT)
    if not os.path.isfile(VBS):
        with open(VBS, "w", encoding="utf-8", newline="") as fh:
            fh.write(VBS_CONTENT)
    if not os.path.isfile(VBS):
        raise RuntimeError("找不到 VBS 启动器：%s" % VBS)
    return VBS


def load_schedule():
    try:
        with open(CONFIG, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError) as exc:
        print("读取配置失败：%s" % exc)
        sys.exit(2)
    schedule = data.get("schedule") or {}
    mode = schedule.get("mode") or "interval"
    interval = int(schedule.get("intervalMinutes") or 10)
    start = schedule.get("startTime") or "08:00"
    end = schedule.get("endTime") or "21:00"
    return mode, interval, start, end


def user_sid():
    try:
        out = subprocess.check_output(["whoami", "/user"], text=True, encoding="mbcs", errors="ignore")
        return out.strip().split()[-1]
    except Exception:
        return ""


def task_xml(vbs, interval, start, end):
    sid = user_sid()
    start_dt = datetime.strptime(start, "%H:%M")
    end_dt = datetime.strptime(end, "%H:%M")
    if end_dt <= start_dt:
        end_dt += timedelta(days=1)
    duration = end_dt - start_dt
    total_minutes = int(duration.total_seconds() // 60)
    duration_xml = "PT%dH%dM" % (total_minutes // 60, total_minutes % 60) if total_minutes % 60 else "PT%dH" % (total_minutes // 60)
    start_boundary = datetime.now().strftime("%Y-%m-%dT") + start + ":00"
    principal = '<Principal id="Author"><UserId>%s</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>' % sid
    return f'''<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>WMS 出库流程节点文件定时下载</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>{start_boundary}+08:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT{interval}M</Interval>
        <Duration>{duration_xml}</Duration>
        <StopAtDurationEnd>true</StopAtDurationEnd>
      </Repetition>
      <ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay>
    </CalendarTrigger>
  </Triggers>
  <Principals>{principal}</Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>//B "{vbs}"</Arguments>
      <WorkingDirectory>{os.path.dirname(vbs)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
'''


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--task", default=TASK_DEFAULT)
    parser.add_argument("--remove", action="store_true")
    args = parser.parse_args()
    if args.remove:
        subprocess.call(["schtasks", "/Delete", "/TN", args.task, "/F"])
        return 0
    mode, interval, start, end = load_schedule()
    if mode != "interval":
        print("当前配置文件不是 interval 模式，请用 install_task.ps1 或改配置")
        return 2
    vbs = ensure_launcher()
    xml = task_xml(vbs, interval, start, end)
    fd, xml_path = tempfile.mkstemp(prefix="wms_task_", suffix=".xml", dir=ROOT)
    os.close(fd)
    try:
        with open(xml_path, "w", encoding="utf-16", newline="\r\n") as fh:
            fh.write(xml)
        result = subprocess.call(["schtasks", "/Create", "/TN", args.task, "/XML", xml_path, "/F"])
        if result == 0:
            print("已安装任务：%s（%s-%s，每 %d 分钟）" % (args.task, start, end, interval))
            print("手动测试：schtasks /Run /TN \"%s\"" % args.task)
        return result
    finally:
        try:
            os.remove(xml_path)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
