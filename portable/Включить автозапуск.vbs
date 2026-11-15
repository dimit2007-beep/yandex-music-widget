' Включить автозапуск виджета и часов вместе с Windows.
' Записи создаются в реестре текущего пользователя (HKCU\...\Run).
' Если папку перенести в другое место — запусти этот файл заново,
' чтобы пути в реестре обновились.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir_ = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir_ & "\app\YMMusicWidget.exe"
key = "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\"
sh.RegWrite key & "YMMusicWidget", """" & exe & """", "REG_SZ"
sh.RegWrite key & "YMMusicWidgetClock", """" & exe & """ --clock", "REG_SZ"
If InStr(LCase(WScript.FullName), "wscript") > 0 Then
  sh.Popup "Автозапуск включён: виджет и часы будут открываться вместе с Windows.", 3, "Яндекс Музыка", 64
End If
