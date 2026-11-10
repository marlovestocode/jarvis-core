# Offline library installer (spec §2/§5). Downloads from download.kiwix.org only:
#   kiwix-tools 3.8.1 (win-x86_64)          -> <jarvis-core>\engines\kiwix
#   latest wikipedia_en_all_nopic_YYYY-MM.zim -> C:\JarvisData\library
# The ZIM is downloaded to <name>.zim.part with resume (curl -C -), its size is checked against the
# server's Content-Length, and only then renamed to .zim, so JARVIS never opens a partial file.
#   -Check   : print the latest ZIM name, URL and size; download nothing
#   -Tools   : kiwix-tools only        -Zim : the ZIM only        (default: both)
# Progress and results go to C:\JarvisData\library\install.log.
param([switch]$Check, [switch]$Tools, [switch]$Zim)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$lib = 'C:\JarvisData\library'
$kiwixDir = Join-Path $root 'engines\kiwix'
$toolsUrl = 'https://download.kiwix.org/release/kiwix-tools/kiwix-tools_win-x86_64-3.8.1.zip'
$zimIndex = 'https://download.kiwix.org/zim/wikipedia/'
New-Item -ItemType Directory -Force $lib | Out-Null
$logFile = Join-Path $lib 'install.log'
function Log($m) { $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $m"; Write-Output $line; Add-Content -Path $logFile -Value $line -Encoding utf8 }
function RemoteSize($url) {
  $h = & curl.exe -sIL $url
  $len = ($h | Select-String -Pattern '^content-length:\s*(\d+)' -AllMatches | Select-Object -Last 1).Matches.Groups[1].Value
  if (-not $len) { throw "no size for $url" }
  [int64]$len
}
function LatestZim {
  $html = & curl.exe -sL $zimIndex
  $names = [regex]::Matches(($html -join "`n"), 'href="(wikipedia_en_all_nopic_\d{4}-\d{2}\.zim)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
  if (-not $names) { throw 'no wikipedia_en_all_nopic ZIM in the Kiwix listing' }
  $name = $names | Select-Object -Last 1
  [pscustomobject]@{ Name = $name; Url = $zimIndex + $name; Size = RemoteSize ($zimIndex + $name) }
}
$both = -not $Tools -and -not $Zim

if ($Check) {
  $z = LatestZim
  Log ("check: {0} from {1}, {2:N0} bytes ({3:N1} GB)" -f $z.Name, $z.Url, $z.Size, ($z.Size / 1e9))
  exit 0
}

if ($Tools -or $both) {
  $exe = Get-ChildItem $kiwixDir -Recurse -Filter 'kiwix-serve.exe' -ea 0 | Select-Object -First 1
  if ($exe) { Log "kiwix-tools already installed: $($exe.FullName)" }
  else {
    New-Item -ItemType Directory -Force $kiwixDir | Out-Null
    $zip = Join-Path $kiwixDir 'kiwix-tools.zip'
    Log "downloading $toolsUrl"
    & curl.exe -sSL --fail -o $zip $toolsUrl
    if ($LASTEXITCODE) { throw "kiwix-tools download failed ($LASTEXITCODE)" }
    if ((Get-Item $zip).Length -ne (RemoteSize $toolsUrl)) { throw 'kiwix-tools size mismatch' }
    Expand-Archive -Force $zip $kiwixDir
    Remove-Item $zip
    $exe = Get-ChildItem $kiwixDir -Recurse -Filter 'kiwix-serve.exe' | Select-Object -First 1
    Log "kiwix-tools installed: $($exe.FullName)"
  }
}

if ($Zim -or $both) {
  $z = LatestZim
  $final = Join-Path $lib $z.Name
  $part = "$final.part"
  if ((Test-Path $final) -and (Get-Item $final).Length -eq $z.Size) { Log "ZIM already complete: $final"; exit 0 }
  $free = (Get-PSDrive C).Free
  $have = if (Test-Path $part) { (Get-Item $part).Length } else { 0 }
  if ($free -lt ($z.Size - $have + 2GB)) { throw ("not enough space on C: ({0:N1} GB free, need {1:N1} GB)" -f ($free / 1e9), (($z.Size - $have) / 1e9)) }
  Log ("downloading {0} ({1:N1} GB) to {2}, resuming from {3:N1} GB" -f $z.Url, ($z.Size / 1e9), $part, ($have / 1e9))
  for ($try = 1; $try -le 20; $try++) {
    & curl.exe -sSL --fail -C - --retry 5 --retry-delay 10 -o $part $z.Url
    $have = (Get-Item $part -ea 0).Length
    if ($have -eq $z.Size) { break }
    Log ("attempt {0} stopped at {1:N1} / {2:N1} GB (curl {3}); resuming" -f $try, ($have / 1e9), ($z.Size / 1e9), $LASTEXITCODE)
    Start-Sleep -Seconds 30
  }
  if ($have -ne $z.Size) { throw "ZIM incomplete: $have of $($z.Size) bytes" }
  Move-Item -Force $part $final
  Log "ZIM complete and verified by size: $final"
}
