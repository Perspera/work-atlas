' WMS download hidden launcher (no console window)
Option Explicit
Dim shell, fso, base, bat, code
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
bat = base & "\run_wms_download.bat"
shell.CurrentDirectory = base
code = shell.Run("cmd.exe /c """ & bat & """", 0, True)
WScript.Quit code
