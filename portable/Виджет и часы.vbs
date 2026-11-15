' Запустить виджет и часы: недостающее запустится, уже запущенное не дублируется.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir_ = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir_ & "\app\YMMusicWidget.exe"
widgetRunning = False
clockRunning = False
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
For Each p In wmi.ExecQuery("SELECT CommandLine, ExecutablePath FROM Win32_Process WHERE Name='YMMusicWidget.exe'")
  cmd = p.CommandLine & ""
  If InStr(1, p.ExecutablePath, dir_, vbTextCompare) = 1 And Mid(p.ExecutablePath, Len(dir_) + 1, 1) = "\" And InStr(1, cmd, "--type=") = 0 Then
    If InStr(1, cmd, "--clock") > 0 Then clockRunning = True Else widgetRunning = True
  End If
Next
If Not widgetRunning Then sh.Run """" & exe & """", 1, False
If Not clockRunning Then sh.Run """" & exe & """ --clock", 1, False
