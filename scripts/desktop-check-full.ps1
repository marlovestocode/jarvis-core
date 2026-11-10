$out = Join-Path $PSScriptRoot 'desktop-check-full.txt'
$r = @()
$r += '--- HKCU Run (real, all)'
(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run').PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' } | ForEach-Object { $r += "$($_.Name) = $($_.Value)" }
$r += '--- startup.log runs (real)'
$log = "$env:LOCALAPPDATA\JarvisDesktop\startup.log"
if (Test-Path $log) { Select-String -Path $log -Pattern '=== startup ===' | Select -Last 8 | ForEach-Object { $r += $_.Line } } else { $r += '(missing)' }
$r += "--- JarvisDesktop dir: $(Test-Path "$env:LOCALAPPDATA\JarvisDesktop") files: $((Get-ChildItem "$env:LOCALAPPDATA\JarvisDesktop" -ea 0).Name -join ', ')"
$r += '--- logon events (last 5)'
Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 7001 } -MaxEvents 5 -ea 0 | ForEach-Object { $r += $_.TimeCreated.ToString('yyyy-MM-dd HH:mm') }
$r | Set-Content $out -Encoding utf8
