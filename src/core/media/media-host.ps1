# JARVIS media host: reads and controls what is playing, over line-delimited JSON on stdio.
#   in : {"id":1,"cmd":"state"}
#   out: {"id":1,"ok":true,"result":...}  |  {"id":1,"ok":false,"error":"..."}
# Commands:
#   ping
#   state                                   every media session (Windows media controls) + system and app volume
#   control  {app, action, value}           play pause playpause stop next prev seek(seconds) shuffle(bool) repeat(none|track|list)
#   volume   {app?, set?, delta?, mute?}    app omitted = system (default output device); set/delta are 0..1
# Sources: Windows.Media.Control (GSMTC) for sessions; Core Audio (IAudioEndpointVolume, IAudioSessionManager2)
# for volume. GSMTC exposes no queue, so this host never reports one.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$out = [Console]::Out
function Send($obj) { $out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)); $out.Flush() }

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
namespace JvAudio {
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int NotImpl1(); [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice dev); }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int f1(); int f2(); int f3(); int f4();
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    int f6();
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    int f8(); int f9(); int f10(); int f11();
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 { int f1(); int f2(); [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator e); }
  [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator { [PreserveSig] int GetCount(out int n); [PreserveSig] int GetSession(int i, out IAudioSessionControl2 s); }
  [Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int f1(); int f2(); int f3(); int f4(); int f5(); int f6(); int f7(); int f8(); int f9();
    int f10(); int f11();
    [PreserveSig] int GetProcessId(out uint pid);
  }
  [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    [PreserveSig] int SetMasterVolume(float level, ref Guid ctx);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

  public class AppVolume { public string Process; public float Level; public bool Muted; }

  public static class Audio {
    static Guid Ctx = Guid.Empty;
    static IMMDevice Device() {
      var e = (IMMDeviceEnumerator)new MMDeviceEnumerator();
      IMMDevice d; Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d)); return d;
    }
    static IAudioEndpointVolume Endpoint() {
      object o; var iid = typeof(IAudioEndpointVolume).GUID;
      Marshal.ThrowExceptionForHR(Device().Activate(ref iid, 23, IntPtr.Zero, out o)); return (IAudioEndpointVolume)o;
    }
    public static float GetLevel() { float v; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return v; }
    public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m)); return m; }
    public static void SetLevel(float v) { Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(Math.Max(0f, Math.Min(1f, v)), ref Ctx)); }
    public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Endpoint().SetMute(m, ref Ctx)); }

    static List<KeyValuePair<string, ISimpleAudioVolume>> Sessions() {
      var list = new List<KeyValuePair<string, ISimpleAudioVolume>>();
      object o; var iid = typeof(IAudioSessionManager2).GUID;
      Marshal.ThrowExceptionForHR(Device().Activate(ref iid, 23, IntPtr.Zero, out o));
      IAudioSessionEnumerator en; Marshal.ThrowExceptionForHR(((IAudioSessionManager2)o).GetSessionEnumerator(out en));
      int n; en.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IAudioSessionControl2 s; if (en.GetSession(i, out s) != 0 || s == null) continue;
        uint pid; if (s.GetProcessId(out pid) != 0 || pid == 0) continue;
        string name; try { name = Process.GetProcessById((int)pid).ProcessName; } catch { continue; }
        list.Add(new KeyValuePair<string, ISimpleAudioVolume>(name, (ISimpleAudioVolume)s));
      }
      return list;
    }
    public static List<AppVolume> Apps() {
      var r = new List<AppVolume>();
      foreach (var kv in Sessions()) {
        float v; bool m; kv.Value.GetMasterVolume(out v); kv.Value.GetMute(out m);
        r.Add(new AppVolume { Process = kv.Key, Level = v, Muted = m });
      }
      return r;
    }
    // Every audio session of the named process (browsers have several). Returns how many were set.
    public static int SetApp(string process, float level, int mute) {
      int n = 0;
      foreach (var kv in Sessions()) {
        if (!string.Equals(kv.Key, process, StringComparison.OrdinalIgnoreCase)) continue;
        if (level >= 0) kv.Value.SetMasterVolume(Math.Max(0f, Math.Min(1f, level)), ref Ctx);
        if (mute >= 0) kv.Value.SetMute(mute == 1, ref Ctx);
        n++;
      }
      return n;
    }
  }
}
'@

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $null = $task.Wait(4000); if (-not $task.IsCompleted) { throw 'Windows media call timed out' }; $task.Result }
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$TMgr = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$TProps = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$mgr = Await ($TMgr::RequestAsync()) $TMgr

function Find-Session($app) {
  foreach ($s in $mgr.GetSessions()) { if ($s.SourceAppUserModelId -eq $app) { return $s } }
  throw "No media session for $app"
}

function Do-State {
  $cur = $mgr.GetCurrentSession()
  $sessions = @()
  foreach ($s in $mgr.GetSessions()) {
    $p = $null
    try { $p = Await ($s.TryGetMediaPropertiesAsync()) $TProps } catch { }
    $i = $s.GetPlaybackInfo(); $t = $s.GetTimelineProperties(); $c = $i.Controls
    $sessions += @{
      app = $s.SourceAppUserModelId
      current = [bool]($cur -and $cur.SourceAppUserModelId -eq $s.SourceAppUserModelId)
      title = if ($p) { $p.Title } else { '' }
      artist = if ($p) { $p.Artist } else { '' }
      albumArtist = if ($p) { $p.AlbumArtist } else { '' }
      album = if ($p) { $p.AlbumTitle } else { '' }
      subtitle = if ($p) { $p.Subtitle } else { '' }
      track = if ($p) { $p.TrackNumber } else { 0 }
      type = if ($i.PlaybackType) { "$($i.PlaybackType)" } else { '' }
      status = "$($i.PlaybackStatus)"
      position = $t.Position.TotalSeconds
      start = $t.StartTime.TotalSeconds
      end = $t.EndTime.TotalSeconds
      updated = $t.LastUpdatedTime.ToUnixTimeMilliseconds()
      shuffle = $i.IsShuffleActive
      repeat = if ($null -ne $i.AutoRepeatMode) { "$($i.AutoRepeatMode)" } else { $null }
      rate = $i.PlaybackRate
      can = @{ play = $c.IsPlayEnabled; pause = $c.IsPauseEnabled; playpause = $c.IsPlayPauseToggleEnabled; stop = $c.IsStopEnabled
               next = $c.IsNextEnabled; prev = $c.IsPreviousEnabled; seek = $c.IsPlaybackPositionEnabled
               shuffle = $c.IsShuffleEnabled; repeat = $c.IsRepeatEnabled }
    }
  }
  $system = @{ volume = $null; muted = $null }
  try { $system.volume = [Math]::Round([JvAudio.Audio]::GetLevel(), 3); $system.muted = [JvAudio.Audio]::GetMute() } catch { $system.error = $_.Exception.Message }
  $apps = @()
  try { foreach ($a in [JvAudio.Audio]::Apps()) { $apps += @{ process = $a.Process; volume = [Math]::Round($a.Level, 3); muted = $a.Muted } } } catch { }
  return @{ at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); sessions = $sessions; system = $system; apps = $apps }
}

function Do-Control($m) {
  $s = Find-Session $m.app
  $op = switch ($m.action) {
    'play' { $s.TryPlayAsync() }
    'pause' { $s.TryPauseAsync() }
    'playpause' { $s.TryTogglePlayPauseAsync() }
    'stop' { $s.TryStopAsync() }
    'next' { $s.TrySkipNextAsync() }
    'prev' { $s.TrySkipPreviousAsync() }
    'seek' { $s.TryChangePlaybackPositionAsync([long]([double]$m.value * 10000000)) }   # 100 ns ticks
    'shuffle' { $s.TryChangeShuffleActiveAsync([bool]$m.value) }
    'repeat' { $s.TryChangeAutoRepeatModeAsync([Windows.Media.MediaPlaybackAutoRepeatMode]$m.value) }
    default { throw "Unknown action $($m.action)" }
  }
  return [bool](Await $op ([bool]))
}

function Do-Volume($m) {
  $set = if ($null -ne $m.set) { [double]$m.set } else { $null }
  $mute = if ($null -ne $m.mute) { [bool]$m.mute } else { $null }
  if ($m.app) {
    $level = -1
    if ($null -ne $set) { $level = $set }
    elseif ($null -ne $m.delta) {
      $now = [JvAudio.Audio]::Apps() | Where-Object { $_.Process -ieq $m.app } | Select-Object -First 1
      if (-not $now) { throw "No audio session for $($m.app)" }
      $level = $now.Level + [double]$m.delta
    }
    $mi = if ($null -eq $mute) { -1 } elseif ($mute) { 1 } else { 0 }
    $n = [JvAudio.Audio]::SetApp($m.app, [float]$level, $mi)
    if ($n -eq 0) { throw "No audio session for $($m.app)" }
    return $n
  }
  if ($null -ne $set) { [JvAudio.Audio]::SetLevel([float]$set) }
  elseif ($null -ne $m.delta) { [JvAudio.Audio]::SetLevel([float]([JvAudio.Audio]::GetLevel() + [double]$m.delta)) }
  if ($null -ne $mute) { [JvAudio.Audio]::SetMute($mute) }
  return 1
}

function Handle($line) {
  $m = $null
  try { $m = $line | ConvertFrom-Json } catch { return }
  $id = $m.id
  try {
    $r = switch ($m.cmd) {
      'ping' { 'pong' }
      'state' { Do-State }
      'control' { Do-Control $m }
      'volume' { Do-Volume $m }
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
