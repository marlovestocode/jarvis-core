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
#   windows                   visible top-level windows: [{ hwnd, pid, app, title, responding, rect }]
#   foreground                the window in front: hwnd or null
#   monitors                  work areas, primary first: [{ n, primary, x, y, w, h }]
#   place     {hwnd,layout}   left|right|top_left|top_right|bottom_left|bottom_right|maximize|minimize|restore|center
#                             -> { ok, rect, state } read back from Windows
#   moveToMonitor {hwnd,n}    -> { ok, rect }
#   desktopSwitch {target}    next|previous (Win+Ctrl+Arrow); true only when the front window left the current desktop;
#                             numbers and builds without virtual desktops throw
#   desktopMove {hwnd,n}      always throws: needs the desktop list (registry), which this host never reads
#   audioDevices              active playback devices: [{ id, name, default }]
#   audioSetDefault {id}      make a listed device the default output (console, media, communications)
#   brightness                built-in panel percent, or null (external monitors)
#   setBrightness {percent}   -> the percent read back, or throws when there is no panel control
#   displays                  [{ n, primary, w, h, hz }]
#   nightLight                always throws: the setting lives in the registry, which this host never touches
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
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
    delegate bool MonitorProc(IntPtr m, IntPtr dc, ref RECT r, IntPtr l);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool repaint);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorProc f, IntPtr l);
    [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
    public class Mon { public int n; public bool primary; public int x, y, w, h; }
    public class Rc { public int x, y, w, h; }
    public static bool Hung(long hwnd) { return IsHungAppWindow(new IntPtr(hwnd)); }
    public static long Foreground() { return GetForegroundWindow().ToInt64(); }
    public static Rc RectOf(long hwnd) {
      RECT r; if (!GetWindowRect(new IntPtr(hwnd), out r)) return null;
      return new Rc { x = r.Left, y = r.Top, w = r.Right - r.Left, h = r.Bottom - r.Top };
    }
    public static string StateOf(long hwnd) {
      var h = new IntPtr(hwnd);
      if (IsIconic(h)) return "minimized";
      if (IsZoomed(h)) return "maximized";
      return "normal";
    }
    // work areas, primary first, then left to right; n is the position in this list
    public static List<Mon> Monitors() {
      var list = new List<Mon>();
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (IntPtr m, IntPtr dc, ref RECT r, IntPtr l) => {
        var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
        if (GetMonitorInfo(m, ref mi)) list.Add(new Mon { primary = (mi.dwFlags & 1) != 0, x = mi.rcWork.Left, y = mi.rcWork.Top, w = mi.rcWork.Right - mi.rcWork.Left, h = mi.rcWork.Bottom - mi.rcWork.Top });
        return true;
      }, IntPtr.Zero);
      list.Sort((a, b) => a.primary != b.primary ? (a.primary ? -1 : 1) : a.x.CompareTo(b.x));
      for (int i = 0; i < list.Count; i++) list[i].n = i + 1;
      return list;
    }
    static Mon MonitorOf(long hwnd) {
      var ms = Monitors();
      var r = RectOf(hwnd);
      if (r == null || ms.Count == 0) return null;
      int cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      foreach (var m in ms) if (cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h) return m;
      return ms[0];
    }
    // layout inside the window's monitor work area; minimize/maximize/restore use the window state
    public static string Place(long hwnd, string layout) {
      var h = new IntPtr(hwnd);
      if (layout == "minimize") { ShowWindow(h, 6); return StateOf(hwnd); }
      if (layout == "maximize") { ShowWindow(h, 3); return StateOf(hwnd); }
      if (layout == "restore") { ShowWindow(h, 9); return StateOf(hwnd); }
      if (IsIconic(h) || IsZoomed(h)) ShowWindow(h, 9);
      var m = MonitorOf(hwnd); if (m == null) throw new Exception("No monitor found");
      int hw = m.w / 2, hh = m.h / 2; var cur = RectOf(hwnd);
      int x = m.x, y = m.y, w = m.w, hgt = m.h;
      switch (layout) {
        case "left": w = hw; break;
        case "right": x = m.x + hw; w = m.w - hw; break;
        case "top_left": w = hw; hgt = hh; break;
        case "top_right": x = m.x + hw; w = m.w - hw; hgt = hh; break;
        case "bottom_left": y = m.y + hh; w = hw; hgt = m.h - hh; break;
        case "bottom_right": x = m.x + hw; y = m.y + hh; w = m.w - hw; hgt = m.h - hh; break;
        case "center": w = Math.Min(cur.w, m.w); hgt = Math.Min(cur.h, m.h); x = m.x + (m.w - w) / 2; y = m.y + (m.h - hgt) / 2; break;
        default: throw new Exception("Unknown layout");
      }
      MoveWindow(h, x, y, w, hgt, true);
      return StateOf(hwnd);
    }
    public static bool MoveToMonitor(long hwnd, int n) {
      var ms = Monitors(); if (n < 1 || n > ms.Count) return false;
      var to = ms[n - 1]; var cur = RectOf(hwnd); if (cur == null) return false;
      var h = new IntPtr(hwnd);
      if (IsIconic(h) || IsZoomed(h)) ShowWindow(h, 9);
      cur = RectOf(hwnd);
      int w = Math.Min(cur.w, to.w), hgt = Math.Min(cur.h, to.h);
      MoveWindow(h, to.x + (to.w - w) / 2, to.y + (to.h - hgt) / 2, w, hgt, true);
      return true;
    }
    // Windows' documented IVirtualDesktopManager: ask which desktop a window is on, and move it
    [ComImport, Guid("a5cd92ff-29be-454c-8d04-d82879fb3f1b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IVirtualDesktopManager {
      [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr h, out bool on);
      [PreserveSig] int GetWindowDesktopId(IntPtr h, out Guid id);
      [PreserveSig] int MoveWindowToDesktop(IntPtr h, ref Guid id);
    }
    [ComImport, Guid("aa509086-5ca9-4c25-8f95-589d3c07b48a")] class VirtualDesktopManagerCom { }
    // 1 = on the current desktop, 0 = on another one, -1 = Windows would not say
    public static int OnCurrent(long hwnd) {
      try {
        var mgr = (IVirtualDesktopManager)new VirtualDesktopManagerCom();
        bool on; if (mgr.IsWindowOnCurrentVirtualDesktop(new IntPtr(hwnd), out on) != 0) return -1;
        return on ? 1 : 0;
      } catch { return -1; }
    }
    public static void Chord(byte key) {   // Win + Ctrl + Left/Right = previous/next virtual desktop
      keybd_event(0x5B, 0, 0, UIntPtr.Zero); keybd_event(0x11, 0, 0, UIntPtr.Zero);
      keybd_event(key, 0, 0, UIntPtr.Zero); keybd_event(key, 0, 2, UIntPtr.Zero);
      keybd_event(0x11, 0, 2, UIntPtr.Zero); keybd_event(0x5B, 0, 2, UIntPtr.Zero);
    }
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
  @([JvPc.Native]::Windows() | ForEach-Object {
    $r = [JvPc.Native]::RectOf($_.hwnd)
    $w = @{ hwnd = $_.hwnd; pid = $_.pid; app = $names[$_.pid]; title = $_.title; responding = (-not [JvPc.Native]::Hung($_.hwnd)) }
    if ($r) { $w.rect = @{ x = $r.x; y = $r.y; w = $r.w; h = $r.h } }
    $w
  })
}

function Do-Monitors { @([JvPc.Native]::Monitors() | ForEach-Object { @{ n = $_.n; primary = $_.primary; x = $_.x; y = $_.y; w = $_.w; h = $_.h } }) }

function Rect-Of($hwnd) { $r = [JvPc.Native]::RectOf([long]$hwnd); if ($r) { @{ x = $r.x; y = $r.y; w = $r.w; h = $r.h } } else { $null } }

function Do-Place($m) {
  $state = [JvPc.Native]::Place([long]$m.hwnd, [string]$m.layout)
  @{ ok = $true; rect = (Rect-Of $m.hwnd); state = $state }
}

function Do-MoveToMonitor($m) {
  $ok = [JvPc.Native]::MoveToMonitor([long]$m.hwnd, [int]$m.n)
  @{ ok = $ok; rect = (Rect-Of $m.hwnd) }
}

# Virtual desktops (documented IVirtualDesktopManager only; the registry is never touched, so the desktop list is not
# available): next/previous are done with the Win+Ctrl+Arrow shortcut and verified by the front window leaving the
# current desktop. Numbered desktops cannot be done safely here and report that, never success.
$NoDesktops = 'Virtual desktops are not available on this Windows build'
function Do-DesktopSwitch($m) {
  $t = [string]$m.target
  if ($t -ne 'next' -and $t -ne 'previous') { throw 'I can only switch to the next or previous virtual desktop here, not to a numbered one' }
  $fw = [JvPc.Native]::Foreground()
  if ($fw -eq 0 -or [JvPc.Native]::OnCurrent($fw) -ne 1) { throw $NoDesktops }
  [JvPc.Native]::Chord($(if ($t -eq 'next') { 0x27 } else { 0x25 }))
  for ($w = 0; $w -lt 12; $w++) { Start-Sleep -Milliseconds 150; if ([JvPc.Native]::OnCurrent($fw) -eq 0) { return $true } }
  $false
}

function Do-DesktopMove($m) {
  throw 'I cannot move a window to a numbered virtual desktop: that needs the desktop list, which JARVIS does not read from the registry. Use Win+Tab'
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

# ---- sound output, brightness, displays: compiled on first use, so a problem here cannot break the rest of the host ----
function Ensure-Audio {
  if ('JvAudio.Native' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
namespace JvAudio {
  [StructLayout(LayoutKind.Sequential)] public struct PROPERTYKEY { public Guid fmtid; public uint pid; }
  [StructLayout(LayoutKind.Explicit, Size = 24)] public struct PROPVARIANT { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
  [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint c); [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
    [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v); [PreserveSig] int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v); [PreserveSig] int Commit();
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid id, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o);
    [PreserveSig] int OpenPropertyStore(int access, out IPropertyStore s);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id); [PreserveSig] int GetState(out int s);
  }
  [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection { [PreserveSig] int GetCount(out uint c); [PreserveSig] int Item(uint i, out IMMDevice d); }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IMMDeviceCollection c);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice d);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom { }
  [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPolicyConfig {
    [PreserveSig] int GetMixFormat(IntPtr a, IntPtr b); [PreserveSig] int GetDeviceFormat(IntPtr a, int b, IntPtr c); [PreserveSig] int ResetDeviceFormat(IntPtr a);
    [PreserveSig] int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c); [PreserveSig] int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d); [PreserveSig] int SetProcessingPeriod(IntPtr a, IntPtr b);
    [PreserveSig] int GetShareMode(IntPtr a, IntPtr b); [PreserveSig] int SetShareMode(IntPtr a, IntPtr b); [PreserveSig] int GetPropertyValue(IntPtr a, IntPtr b, IntPtr c); [PreserveSig] int SetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role); [PreserveSig] int SetEndpointVisibility(IntPtr a, int b);
  }
  [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class PolicyConfigClient { }
  public class Dev { public string id; public string name; public bool isDefault; }
  public static class Native {
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT v);
    static string FriendlyName(IMMDevice d) {
      IPropertyStore ps; if (d.OpenPropertyStore(0, out ps) != 0) return null;
      var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
      PROPVARIANT v; if (ps.GetValue(ref key, out v) != 0) return null;
      string s = v.vt == 31 ? Marshal.PtrToStringUni(v.p) : null;
      PropVariantClear(ref v);
      return s;
    }
    // active playback devices; isDefault = the default for media
    public static List<Dev> Devices() {
      var list = new List<Dev>();
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDeviceCollection col; if (en.EnumAudioEndpoints(0, 1, out col) != 0) return list;
      string defId = null; IMMDevice dd; if (en.GetDefaultAudioEndpoint(0, 1, out dd) == 0) dd.GetId(out defId);
      uint n; col.GetCount(out n);
      for (uint i = 0; i < n; i++) {
        IMMDevice d; if (col.Item(i, out d) != 0) continue;
        string id; if (d.GetId(out id) != 0) continue;
        list.Add(new Dev { id = id, name = FriendlyName(d) ?? id, isDefault = id == defId });
      }
      return list;
    }
    public static bool SetDefault(string id) {
      var pc = (IPolicyConfig)new PolicyConfigClient();
      bool ok = true;
      for (int role = 0; role < 3; role++) ok &= pc.SetDefaultEndpoint(id, role) == 0;   // console, multimedia, communications
      return ok;
    }
  }
}
'@
}

function Ensure-Display {
  if ('JvDisp.Native' -as [type]) { return }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Forms;
namespace JvDisp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
    public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency, dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
  }
  public class Disp { public int n; public bool primary; public int w, h, hz; }
  public static class Native {
    [DllImport("user32.dll", CharSet = CharSet.Ansi)] static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
    // primary first, then left to right (the same numbering as the window monitors)
    public static List<Disp> Displays() {
      var screens = new List<Screen>(Screen.AllScreens);
      screens.Sort((a, b) => a.Primary != b.Primary ? (a.Primary ? -1 : 1) : a.Bounds.X.CompareTo(b.Bounds.X));
      var list = new List<Disp>();
      for (int i = 0; i < screens.Count; i++) {
        var dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
        var d = new Disp { n = i + 1, primary = screens[i].Primary };
        if (EnumDisplaySettings(screens[i].DeviceName, -1, ref dm)) { d.w = dm.dmPelsWidth; d.h = dm.dmPelsHeight; d.hz = dm.dmDisplayFrequency; }
        else { d.w = screens[i].Bounds.Width; d.h = screens[i].Bounds.Height; }
        list.Add(d);
      }
      return list;
    }
  }
}
'@
}

function Do-AudioDevices { Ensure-Audio; @([JvAudio.Native]::Devices() | ForEach-Object { @{ id = $_.id; name = $_.name; default = $_.isDefault } }) }

function Do-AudioSetDefault($m) {
  Ensure-Audio
  $id = [string]$m.id
  if (-not ([JvAudio.Native]::Devices() | Where-Object { $_.id -ceq $id })) { throw 'No such sound output device' }
  [JvAudio.Native]::SetDefault($id)
}

# built-in panels only (WMI); external monitors have no instance, so the answer is null / an error
function Do-Brightness {
  $b = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction SilentlyContinue | Where-Object { $_.Active })
  if ($b.Count -gt 0) { [int]$b[0].CurrentBrightness } else { $null }
}

function Do-SetBrightness($m) {
  $methods = @(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction SilentlyContinue)
  if ($methods.Count -eq 0) { throw 'This display has no brightness control' }
  foreach ($x in $methods) { [void](Invoke-CimMethod -InputObject $x -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte][int]$m.percent }) }
  Start-Sleep -Milliseconds 300
  Do-Brightness
}

function Do-Displays { Ensure-Display; @([JvDisp.Native]::Displays() | ForEach-Object { @{ n = $_.n; primary = $_.primary; w = $_.w; h = $_.h; hz = $_.hz } }) }

# Windows keeps night light in the registry, which this host never touches
function Do-NightLight($m) { throw 'Night light is not available from here: Windows stores it in the registry, which JARVIS does not touch' }

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
      'foreground' { $f = [JvPc.Native]::Foreground(); if ($f -ne 0) { $f } else { $null } }
      'monitors' { Do-Monitors }
      'place' { Do-Place $m }
      'moveToMonitor' { Do-MoveToMonitor $m }
      'desktopSwitch' { Do-DesktopSwitch $m }
      'desktopMove' { Do-DesktopMove $m }
      'audioDevices' { Do-AudioDevices }
      'audioSetDefault' { Do-AudioSetDefault $m }
      'brightness' { Do-Brightness }
      'setBrightness' { Do-SetBrightness $m }
      'displays' { Do-Displays }
      'nightLight' { Do-NightLight $m }
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
