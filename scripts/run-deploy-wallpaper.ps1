# Runs jarvis-desktop's deploy-wallpaper.ps1 in the real Windows session (Task Scheduler) and logs it.
$log = Join-Path $PSScriptRoot 'deploy-wallpaper-run.txt'
try { & 'C:\Users\gdani\Projects\Apps\jarvis-desktop\apply\deploy-wallpaper.ps1' *>&1 | Out-File $log -Encoding utf8; 'EXIT OK' | Add-Content $log }
catch { "FAILED: $($_.Exception.Message)" | Add-Content $log }
