' Автозапуск ЧАСОВ вместе с Windows: переключатель.
' Один запуск — включить, ещё один — выключить.
' Записи создаются в реестре текущего пользователя (HKCU\...\Run).
' Если папку перенести в другое место — включи заново, чтобы
' путь в реестре обновился.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir_ = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir_ & "\app\YMMusicWidget.exe"
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
  sh.RegWrite key & name_, """" & exe & """ --clock", "REG_SZ"
  msg = "Автозапуск часов ВКЛЮЧЁН: будут открываться вместе с Windows."
End If
If InStr(LCase(WScript.FullName), "wscript") > 0 Then
  sh.Popup msg, 3, "Яндекс Музыка", 64
End If
