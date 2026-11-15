' Автозапуск ЧАСОВ вместе с Windows: переключатель.
' Один запуск — включить, ещё один — выключить.
' В реестр пишется YMClock.exe (лаунчер со своей иконкой часов);
' если его нет — прямая запись YMMusicWidget.exe --clock.
' Если папку перенести в другое место — включи заново, чтобы
' путь в реестре обновился.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir_ = fso.GetParentFolderName(WScript.ScriptFullName)
launcher = dir_ & "\app\YMClock.exe"
exe = dir_ & "\app\YMMusicWidget.exe"
If fso.FileExists(launcher) Then
  target = """" & launcher & """"
Else
  target = """" & exe & """ --clock"
End If
key = "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\"
name_ = "YMMusicWidgetClock"

On Error Resume Next
sh.RegRead key & name_
wasOn = (Err.Number = 0)
Err.Clear
On Error GoTo 0

If wasOn Then
  On Error Resume Next
  sh.RegDelete key & name_
  On Error GoTo 0
  msg = "Автозапуск часов ВЫКЛЮЧЕН."
Else
  sh.RegWrite key & name_, target, "REG_SZ"
  msg = "Автозапуск часов ВКЛЮЧЁН: будут открываться вместе с Windows."
End If
If InStr(LCase(WScript.FullName), "wscript") > 0 Then
  sh.Popup msg, 3, "Яндекс Музыка", 64
End If
