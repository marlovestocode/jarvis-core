# JARVIS speech host: Windows built-in System.Speech over line-delimited JSON on stdio.
#   in : {"id":1,"cmd":"speak","text":"hi","rate":0}
#   out: {"id":1,"ok":true,"result":...}  |  {"id":1,"ok":false,"error":"..."}
#   events: {"ev":"word","id":1}  {"ev":"speak-end","id":1}  {"ev":"wake","confidence":0.9}
# Commands: ping, status, speak, stop-speak, transcribe, wake-start, wake-stop, synth (WAV file, for checks)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName System.Speech

$out = [Console]::Out
function Send($obj) { $out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6)); $out.Flush() }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SetOutputToDefaultAudioDevice()
$prompts = @{}   # Prompt → request id, so every speak gets its own reply
$null = Register-ObjectEvent -InputObject $synth -EventName SpeakProgress -SourceIdentifier 'jv.word'
$null = Register-ObjectEvent -InputObject $synth -EventName SpeakCompleted -SourceIdentifier 'jv.done'

$wake = $null
$wakeConf = 0.7

function Get-Recognizer {
  $r = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
  if (-not $r -or $r.Count -eq 0) { throw 'No Windows speech recognizer installed' }
  $pref = $r | Where-Object { $_.Culture.Name -eq [Globalization.CultureInfo]::CurrentUICulture.Name } | Select-Object -First 1
  if (-not $pref) { $pref = $r | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq 'en' } | Select-Object -First 1 }
  if (-not $pref) { $pref = $r[0] }
  return $pref
}

function Do-Status {
  $s = @{ tts = $false; stt = $false; wake = $false; voices = @() }
  try { $s.voices = @($synth.GetInstalledVoices() | Where-Object Enabled | ForEach-Object { $_.VoiceInfo.Name }); $s.tts = $s.voices.Count -gt 0 } catch { $s.ttsError = $_.Exception.Message }
  try { $ri = Get-Recognizer; $s.stt = $true; $s.wake = $true; $s.recognizer = $ri.Culture.Name } catch { $s.sttError = $_.Exception.Message; $s.wakeError = $_.Exception.Message }
  return $s
}

function Do-Transcribe($wav) {
  $eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine (Get-Recognizer)
  try {
    $eng.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar))
    $eng.SetInputToWaveFile($wav)
    $parts = @()
    while ($true) {
      $r = $null
      try { $r = $eng.Recognize() } catch { break }   # throws once the WAV is used up
      if ($null -eq $r) { break }
      if ($r.Text) { $parts += $r.Text }
    }
    return ($parts -join ' ')
  } finally { $eng.Dispose() }
}

# Wake grammar: "Jarvis" with common lead-ins, plus a dictation garbage model so other speech
# matches *that* instead of being forced into "Jarvis" (a one-word grammar fires on anything).
function New-WakeEngine($word) {
  $eng = New-Object System.Speech.Recognition.SpeechRecognitionEngine (Get-Recognizer)
  $culture = $eng.RecognizerInfo.Culture
  $wake = New-Object System.Speech.Recognition.GrammarBuilder
  $wake.Culture = $culture
  $lead = New-Object System.Speech.Recognition.Choices
  foreach ($w in 'hey', 'okay', 'ok', 'hi', 'yo') { $lead.Add($w) }
  $wake.Append((New-Object System.Speech.Recognition.GrammarBuilder $lead), 0, 1)
  $wake.Append([string]$word)
  $wake.AppendWildcard()                                    # "Jarvis, what time is it" still wakes
  $g = New-Object System.Speech.Recognition.Grammar $wake
  $g.Name = 'wake'
  $eng.LoadGrammar($g)
  $other = New-Object System.Speech.Recognition.DictationGrammar 'grammar:dictation#pronunciation'
  $other.Name = 'other'
  $other.Weight = 0.3
  $eng.LoadGrammar($other)
  return $eng
}

# Wake if the wake grammar matched, or if the phonetic garbage model heard an utterance that
# STARTS with "Jarvis" (a run-on "Jarvis, what time is it" in one breath).
$WakePhones = '^(?:(?:hh ey|ow k ey|ow k|hh ay|y ow) )?jh aa r v (?:ih|ax|iy|ix) s?(?: |$)'
function Test-Wake($r) {
  if ($r.Grammar.Name -eq 'wake') { return $r.Confidence -ge $script:wakeConf }
  return $r.Grammar.Name -eq 'other' -and $r.Text -match $WakePhones
}

function Do-WakeTest($wav, $word) {
  $eng = New-WakeEngine $word
  try {
    $eng.SetInputToWaveFile($wav)
    $r = $null
    try { $r = $eng.Recognize() } catch { }
    if (-not $r) { return @{ grammar = ''; text = ''; confidence = 0 } }
    $script:wakeConf = 0.7
    return @{ grammar = $r.Grammar.Name; text = $r.Text; confidence = [Math]::Round($r.Confidence, 2); wakes = [bool](Test-Wake $r) }
  } finally { $eng.Dispose() }
}

function Do-WakeStart($word, $conf) {
  if ($wake) { return $true }
  $script:wakeConf = $conf
  $eng = New-WakeEngine $word
  $eng.SetInputToDefaultAudioDevice()
  $null = Register-ObjectEvent -InputObject $eng -EventName SpeechRecognized -SourceIdentifier 'jv.wake'
  $eng.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
  $script:wake = $eng
  return $true
}

function Do-WakeStop {
  if (-not $wake) { return $true }
  try { $wake.RecognizeAsyncCancel() } catch { }
  Unregister-Event -SourceIdentifier 'jv.wake' -ErrorAction SilentlyContinue
  $wake.Dispose()
  $script:wake = $null
  return $true
}

function Handle($line) {
  $m = $null
  try { $m = $line | ConvertFrom-Json } catch { return }
  $id = $m.id
  try {
    switch ($m.cmd) {
      'ping' { Send @{ id = $id; ok = $true; result = 'pong' } }
      'status' { Send @{ id = $id; ok = $true; result = (Do-Status) } }
      'speak' {
        if ($prompts.Count) { $synth.SpeakAsyncCancelAll() }   # older prompts complete as cancelled, each with its own id
        $synth.Rate = [Math]::Max(-10, [Math]::Min(10, [int]$m.rate))
        $p = $synth.SpeakAsync([string]$m.text)               # reply comes on SpeakCompleted for this prompt
        $prompts[$p] = $id
      }
      'stop-speak' { $synth.SpeakAsyncCancelAll(); Send @{ id = $id; ok = $true; result = $true } }
      'transcribe' { Send @{ id = $id; ok = $true; result = (Do-Transcribe ([string]$m.wav)) } }
      'wake-start' { Send @{ id = $id; ok = $true; result = (Do-WakeStart ([string]$m.word) ([double]$m.confidence)) } }
      'wake-stop' { Send @{ id = $id; ok = $true; result = (Do-WakeStop) } }
      'wake-test' { Send @{ id = $id; ok = $true; result = (Do-WakeTest ([string]$m.wav) ([string]$m.word)) } }
      'synth' {
        $s2 = New-Object System.Speech.Synthesis.SpeechSynthesizer
        try {
          $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
          $s2.SetOutputToWaveFile([string]$m.wav, $fmt); $s2.Speak([string]$m.text); $s2.SetOutputToNull()
        } finally { $s2.Dispose() }
        Send @{ id = $id; ok = $true; result = $true }
      }
      default { Send @{ id = $id; ok = $false; error = "unknown command $($m.cmd)" } }
    }
  } catch {
    Send @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
}

function Pump-Events {
  foreach ($e in @(Get-Event -ErrorAction SilentlyContinue)) {
    switch ($e.SourceIdentifier) {
      'jv.word' {
        $p = $e.SourceEventArgs.Prompt
        if ($p -and $prompts.ContainsKey($p)) { Send @{ ev = 'word'; id = $prompts[$p] } }
      }
      'jv.done' {
        $p = $e.SourceEventArgs.Prompt
        if ($p -and $prompts.ContainsKey($p)) {
          $sid = $prompts[$p]; $prompts.Remove($p)
          Send @{ ev = 'speak-end'; id = $sid }
          Send @{ id = $sid; ok = $true; result = @{ cancelled = [bool]$e.SourceEventArgs.Cancelled } }
        }
      }
      'jv.wake' {
        $r = $e.SourceEventArgs.Result
        if ($r -and (Test-Wake $r)) { Send @{ ev = 'wake'; confidence = [Math]::Round($r.Confidence, 2); text = $r.Text } }
      }
    }
    Remove-Event -EventIdentifier $e.EventIdentifier -ErrorAction SilentlyContinue
  }
}

# Console.In.ReadLineAsync blocks in .NET Framework; a StreamReader on the raw stream does not,
# so .NET events (word, speak end, wake) keep flowing while we wait for commands.
$stdin = New-Object IO.StreamReader([Console]::OpenStandardInput(), (New-Object Text.UTF8Encoding $false))
$task = $stdin.ReadLineAsync()
while ($true) {
  if ($task.IsCompleted) {
    $line = $task.Result
    if ($null -eq $line) { break }          # parent closed stdin: exit
    if ($line.Trim()) { Handle $line }
    $task = $stdin.ReadLineAsync()
    continue
  }
  Pump-Events
  Start-Sleep -Milliseconds 20              # Start-Sleep lets PowerShell queue .NET events; Task.Wait does not
}
try { Do-WakeStop | Out-Null } catch { }
$synth.Dispose()
