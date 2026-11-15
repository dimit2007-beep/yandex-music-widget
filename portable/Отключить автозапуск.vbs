' Отключить автозапуск виджета и часов (удалить записи из реестра).
Set sh = CreateObject("WScript.Shell")
key = "HKCU\Software\Microsoft\Windows\CurrentVersion\Run\"
On Error Resume Next
sh.RegDelete key & "YMMusicWidget"
sh.RegDelete key & "YMMusicWidgetClock"
On Error GoTo 0
If InStr(LCase(WScript.FullName), "wscript") > 0 Then
  sh.Popup "Автозапуск отключён.", 3, "Яндекс Музыка", 64
End If
