// YMClock launcher: starts YMMusicWidget.exe --clock from its own folder
// and exits immediately. Exists so Windows shows a separate exe (with its
// own clock icon) for the clock in autostart and Explorer - the real work
// is still done by YMMusicWidget.exe. ASCII only (ANSI-locale safe).
using System;
using System.Diagnostics;
using System.IO;

static class Program
{
    [STAThread]
    static int Main()
    {
        try
        {
            string dir = AppDomain.CurrentDomain.BaseDirectory;
            string exe = Path.Combine(dir, "YMMusicWidget.exe");
            if (File.Exists(exe))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = exe,
                    Arguments = "--clock",
                    WorkingDirectory = dir,
                    UseShellExecute = false,
                });
            }
        }
        catch
        {
            // no launcher dialogs, especially at logon
        }
        return 0;
    }
}
