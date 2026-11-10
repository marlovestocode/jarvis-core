# JARVIS PC host: apps, windows and the Recycle Bin, over line-delimited JSON on stdio.
#   in : {"id":1,"cmd":"windows"}
#   out: {"id":1,"ok":true,"result":...}  |  {"id":1,"ok":false,"error":"..."}
# Every argument arrives as a typed JSON field and is passed as a parameter value, never spliced
# into a command line. Nothing here edits the registry, changes settings or erases files: removal
# only ever goes to the Recycle Bin.
# Commands:
#   ping
#   startApps                 Start menu apps: [{ name, appId }]
#   launch    {target}        an existing file/folder path (shell open) or a Start menu AppID
#   windows                   visible top-level windows: [{ hwnd, pid, app, title }]
#   alive     {pids}          which of these process ids still run
#   closeMain {pid}           ask the app to close (like clicking X); true if the request was sent
#   kill      {pid}           end the process (only after the user confirmed a force close)
#   focus     {hwnd}          bring a window to the front; true if it is now in front
#   recycle   {path}          send a file or folder to the Recycle Bin; true if it is gone
#   lock                      lock the PC
#   power     {mode}          shutdown | restart | sleep
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$out = [Console]::Out
function Send($obj) { $out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5)); $out.Flush() }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
namespace JvPc {
  public class Win { public long hwnd; public int pid; public string title; }
  public static class Native {
    delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool LockWorkStation();
    public static List<Win> Windows() {
      var list = new List<Win>();
      EnumWindows((h, l) => {
        if (!IsWindowVisible(h) || GetWindow(h, 4) != IntPtr.Zero) return true;   // 4 = GW_OWNER
        int len = GetWindowTextLength(h);
        if (len == 0) return true;
        int cloaked;
        if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return true;   // hidden UWP shells
        var sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        uint pid; GetWindowThreadProcessId(h, out pid);
        list.Add(new Win { hwnd = h.ToInt64(), pid = (int)pid, title = sb.ToString() });
        return true;
      }, IntPtr.Zero);
      return list;
    }
    public static bool Focus(long hwnd) {
      var h = new IntPtr(hwnd);
      if (IsIconic(h)) ShowWindow(h, 9);   // SW_RESTORE
      keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);   // Alt tap lets us take the foreground
      SetForegroundWindow(h);
      return GetForegroundWindow() == h;
    }
  }
}
'@

function Do-Windows {
  $names = @{}
  foreach ($p in Get-Process) { $names[$p.Id] = $p.ProcessName }
  @([JvPc.Native]::Windows() | ForEach-Object { @{ hwnd = $_.hwnd; pid = $_.pid; app = $names[$_.pid]; title = $_.title } })
}

function Do-Launch($m) {
  $t = [string]$m.target
  if (Test-Path -LiteralPath $t) { Start-Process -FilePath $t }
  else { Start-Process -FilePath ('shell:AppsFolder\' + $t) }
  @{}
}

# AllDialogs, never the silent mode: if an item is too big for the Recycle Bin (or the bin is off),
# Windows asks the user itself before it would erase anything. Afterwards the bin is searched, so
# "in the Recycle Bin" is only reported when the item is really there.
function Do-Recycle($m) {
  $p = [string]$m.path
  if (-not (Test-Path -LiteralPath $p)) { throw "Not found: $p" }
  $parent = Split-Path -LiteralPath $p -Parent
  $leaf = Split-Path -LiteralPath $p -Leaf
  Add-Type -AssemblyName Microsoft.VisualBasic
  $ui = [Microsoft.VisualBasic.FileIO.UIOption]::AllDialogs
  $bin = [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
  $cancel = [Microsoft.VisualBasic.FileIO.UICancelOption]::DoNothing
  if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, $ui, $bin, $cancel) }
  else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, $ui, $bin, $cancel) }
  $gone = -not (Test-Path -LiteralPath $p)
  $inBin = $false
  if ($gone) {
    $base = [IO.Path]::GetFileNameWithoutExtension($leaf)
    foreach ($it in (New-Object -ComObject Shell.Application).Namespace(10).Items()) {
      $from = [string]$it.ExtendedProperty('System.Recycle.DeletedFrom')
      if ($from.TrimEnd('\') -ieq $parent.TrimEnd('\') -and ($it.Name -ieq $leaf -or $it.Name -ieq $base)) { $inBin = $true; break }
    }
  }
  @{ gone = $gone; inBin = $inBin }
}

function Do-Power($m) {
  $exe = Join-Path $env:SystemRoot 'System32\shutdown.exe'
  switch ([string]$m.mode) {
    'shutdown' { Start-Process -FilePath $exe -ArgumentList '/s', '/t', '0' -WindowStyle Hidden; $true }
    'restart' { Start-Process -FilePath $exe -ArgumentList '/r', '/t', '0' -WindowStyle Hidden; $true }
    'sleep' { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false); $true }
    default { throw "Unknown power mode" }
  }
}

function Handle($line) {
  $m = $null
  try { $m = $line | ConvertFrom-Json } catch { return }
  $id = $m.id
  try {
    $r = switch ($m.cmd) {
      'ping' { 'pong' }
      'startApps' { @(Get-StartApps | ForEach-Object { @{ name = $_.Name; appId = $_.AppID } }) }
      'launch' { Do-Launch $m }
      'windows' { Do-Windows }
      'alive' { @($m.pids | ForEach-Object { $q = Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue; if ($q) { $q.Id } }) }
      'closeMain' { $q = Get-Process -Id ([int]$m.pid) -ErrorAction SilentlyContinue; if ($q) { $q.CloseMainWindow() } else { $false } }
      'kill' { Stop-Process -Id ([int]$m.pid) -Force; $true }
      'focus' { [JvPc.Native]::Focus([long]$m.hwnd) }
      'recycle' { Do-Recycle $m }
      'lock' { [JvPc.Native]::LockWorkStation() }
      'power' { Do-Power $m }
      default { throw "Unknown command $($m.cmd)" }
    }
    Send @{ id = $id; ok = $true; result = $r }
  } catch {
    Send @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
}

$stdin = New-Object IO.StreamReader([Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding $false))
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }   # parent closed stdin: exit
  if ($line.Trim()) { Handle $line }
}
