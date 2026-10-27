// FaceitExt Smart Launcher – re-applies the FaceitExt bootstrap after FACEIT (Squirrel) updates, then starts FACEIT.
// Build: csc /target:winexe /out:FaceitLauncher.exe FaceitLauncher.cs  (see install.js)
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;

static class FaceitLauncher
{
    const string Marker = "faceit-ext-bootstrap.marker";

    static string Local { get { return Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData); } }
    static string Roaming { get { return Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData); } }
    static string LogFile { get { return Path.Combine(Roaming, "FaceitExtensions", "launcher.log"); } }

    static void Log(string m)
    {
        try { File.AppendAllText(LogFile, "[" + DateTime.Now.ToString("s") + "] " + m + Environment.NewLine); } catch { }
    }

    static Version ParseVer(string dir)
    {
        Version v; return Version.TryParse(Path.GetFileName(dir).Substring(4), out v) ? v : new Version(0, 0);
    }

    static bool IsPatched(string asar)
    {
        using (var fs = new FileStream(asar, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var br = new BinaryReader(fs))
        {
            br.ReadUInt32(); br.ReadUInt32(); br.ReadUInt32();
            int len = (int)br.ReadUInt32();
            var json = Encoding.UTF8.GetString(br.ReadBytes(len));
            return json.Contains("\"" + Marker + "\"");
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        var root = Path.Combine(Local, "FACEIT");
        var latest = Directory.Exists(root)
            ? Directory.GetDirectories(root, "app-*").Where(d => File.Exists(Path.Combine(d, "FACEIT.exe")))
                .OrderByDescending(ParseVer).FirstOrDefault()
            : null;
        if (latest == null)
        {
            Log("FACEIT not found in " + root);
            System.Windows.Forms.MessageBox.Show("Nie znaleziono instalacji FACEIT w " + root, "FaceitExt");
            return 1;
        }

        var exe = Path.Combine(latest, "FACEIT.exe");
        var asar = Path.Combine(latest, "resources", "app.asar");
        var patcher = Path.Combine(Roaming, "FaceitExtensions", "core", "asar-patcher.js");

        try
        {
            var sw = Stopwatch.StartNew();
            if (!IsPatched(asar) && File.Exists(patcher))
            {
                // FACEIT.exe has the RunAsNode fuse enabled, so it can run our patcher – no Node.js install needed.
                var psi = new ProcessStartInfo(exe, "\"" + patcher + "\" \"" + asar + "\"")
                {
                    UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                };
                psi.EnvironmentVariables["ELECTRON_RUN_AS_NODE"] = "1";
                using (var p = Process.Start(psi))
                {
                    var o = p.StandardOutput.ReadToEnd() + p.StandardError.ReadToEnd();
                    p.WaitForExit(30000);
                    Log("patch " + Path.GetFileName(latest) + " exit=" + p.ExitCode + " " + o.Trim() + " (" + sw.ElapsedMilliseconds + "ms)");
                }
            }
            else Log("check " + Path.GetFileName(latest) + " ok (" + sw.ElapsedMilliseconds + "ms)");
        }
        catch (Exception e) { Log("patch error: " + e.Message); }

        var argLine = string.Join(" ", args.Select(a => a.Contains(" ") ? "\"" + a + "\"" : a));
        var start = new ProcessStartInfo(exe, argLine) { UseShellExecute = false, WorkingDirectory = latest };
        start.EnvironmentVariables.Remove("ELECTRON_RUN_AS_NODE");
        Process.Start(start);
        return 0;
    }
}
