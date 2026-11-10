# Desktop check from OUTSIDE any app sandbox. Run it through Task Scheduler:
#   schtasks /Create /TN "JARVIS Check" /TR "powershell -NoProfile -ExecutionPolicy Bypass -File <this file>" /SC ONCE /ST 23:59 /F
#   schtasks /Run /TN "JARVIS Check"
# Writes desktop-check.txt next to this script: what the real Windows session sees.
$out = Join-Path $PSScriptRoot 'desktop-check.txt'
$r = New-Object System.Collections.Generic.List[string]
$r.Add("checked: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')")

# startup entries the real Explorer will run at sign-in
$r.Add('--- HKCU Run (real hive)')
(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run').PSObject.Properties |
  Where-Object { $_.Name -notlike 'PS*' -and ($_.Value -match 'jarvis|electron|JarvisStartup') } |
  ForEach-Object { $r.Add("$($_.Name) = $($_.Value)") }
$t = Get-ScheduledTask -TaskName 'JARVIS AI Core' -ea 0
if ($t) { $r.Add("task JARVIS AI Core: $($t.State) | $($t.Actions[0].Execute) $($t.Actions[0].Arguments)") }

# installed wallpaper vs source
$src = 'C:\Users\gdani\Projects\Apps\jarvis-desktop\wallpaper'
$dst = "${env:ProgramFiles(x86)}\Steam\steamapps\common\wallpaper_engine\projects\myprojects\jarvis-hud"
$bad = 0; $n = 0
foreach ($f in Get-ChildItem $src -Recurse -File) {
  $rel = $f.FullName.Substring($src.Length + 1); $n++
  $d = Join-Path $dst $rel
  if (-not (Test-Path $d) -or (Get-FileHash $f.FullName).Hash -ne (Get-FileHash $d).Hash) { $bad++; $r.Add("wallpaper differs: $rel") }
}
$r.Add("--- wallpaper installed vs source: $($n - $bad)/$n identical")

# what is running, and who started it
$r.Add('--- processes')
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'electron.exe' -and $_.CommandLine -match 'jarvis-core' -and $_.CommandLine -notmatch '--type=') -or
  $_.Name -in 'wallpaper64.exe', 'SysMon Widget.exe', 'ollama app.exe', 'whisper-server.exe', 'piper.exe'
} | ForEach-Object {
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ParentProcessId)" -ea 0
  $r.Add("$($_.Name) pid $($_.ProcessId) started by $(if ($p) { $p.Name } else { '(exited)' })")
}

# desktop startup log (real location)
$log = "$env:LOCALAPPDATA\JarvisDesktop\startup.log"
$r.Add("--- $log (last 6)")
if (Test-Path $log) { Get-Content $log -Tail 6 | ForEach-Object { $r.Add($_) } } else { $r.Add('(missing)') }
$r | Set-Content $out -Encoding utf8
