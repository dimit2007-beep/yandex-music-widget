' Запустить часы (не дублируя уже запущенные).
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir_ = fso.GetParentFolderName(WScript.ScriptFullName)
exe = dir_ & "\app\YMMusicWidget.exe"
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
For Each p In wmi.ExecQuery("SELECT CommandLine, ExecutablePath FROM Win32_Process WHERE Name='YMMusicWidget.exe'")
  cmd = p.CommandLine & ""
  If InStr(1, p.ExecutablePath, dir_, vbTextCompare) = 1 And Mid(p.ExecutablePath, Len(dir_) + 1, 1) = "\" _
     And InStr(1, cmd, "--type=") = 0 And InStr(1, cmd, "--clock") > 0 Then WScript.Quit
Next
sh.Run """" & exe & """ --clock", 1, False
