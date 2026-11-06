# One-time setup on Windows 10/11 (PowerShell). Safe to run again.
#   powershell -ExecutionPolicy Bypass -File install.ps1             set up and test
#   powershell -ExecutionPolicy Bypass -File install.ps1 -AutoStart  also start it at every sign-in
# 1. checks bun and git  2. bun install and the pose models (sha256-checked)  3. writes your settings
# file from deploy.env.example if you have none  4. starts run.mjs once and checks / and /vision/ answer
# 200, then stops it  5. with -AutoStart, adds a Task Scheduler task that runs bun run.mjs at sign-in
param([switch]$AutoStart)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Root = $PSScriptRoot
Set-Location $Root
function Say($t) { Write-Host "`n== $t" }

Say '1/5 tools'
$missing = $false
foreach ($t in @(
    @{ n = 'bun'; how = 'powershell -c "irm bun.sh/install.ps1 | iex"   (then open a new PowerShell)' },
    @{ n = 'git'; how = 'winget install --id Git.Git -e' })) {
  if (Get-Command $t.n -ErrorAction SilentlyContinue) { Write-Host "  ok  $($t.n)" } else { Write-Host "  MISSING  $($t.n): $($t.how)"; $missing = $true }
}
if ($missing) { Write-Host "`nInstall what is missing above, then run install.ps1 again."; exit 1 }
$Bun = (Get-Command bun).Source

Say '2/5 dependencies and pose models'
& $Bun install
if ($LASTEXITCODE -ne 0) { exit 1 }
# The same files and sha256 sums as scripts/fetch-models.sh (read from it, so there is one list).
$models = Join-Path $Root 'public\models'
New-Item -ItemType Directory -Force $models | Out-Null
foreach ($line in Get-Content (Join-Path $Root 'scripts\fetch-models.sh')) {
  if ($line -notmatch '^(fetch|fetch_zip_onnx) (\S+) (\S+) ([0-9a-f]{64})$') { continue }
  $kind, $name, $url, $sum = $Matches[1], $Matches[2], $Matches[3], $Matches[4]
  $dest = Join-Path $models $name
  $ok = (Test-Path $dest) -and ((Get-FileHash $dest -Algorithm SHA256).Hash.ToLower() -eq $sum)
  if (-not $ok) {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid())
    New-Item -ItemType Directory $tmp | Out-Null
    if ($kind -eq 'fetch') {
      Invoke-WebRequest -Uri $url -OutFile "$tmp\m" -UseBasicParsing
      Move-Item -Force "$tmp\m" $dest
    } else {
      Invoke-WebRequest -Uri $url -OutFile "$tmp\m.zip" -UseBasicParsing
      Expand-Archive "$tmp\m.zip" -DestinationPath "$tmp\x"
      Copy-Item -Force (Get-ChildItem "$tmp\x" -Recurse -Filter end2end.onnx | Select-Object -First 1).FullName $dest
    }
    Remove-Item -Recurse -Force $tmp
  }
  if ((Get-FileHash $dest -Algorithm SHA256).Hash.ToLower() -ne $sum) { Write-Host "  $name`: sha256 does not match"; exit 1 }
  Write-Host "  $name`: OK"
}

$EnvFile = if ($env:PPV_DEPLOY_ENV) { $env:PPV_DEPLOY_ENV } else { Join-Path $HOME '.config\pingpong-vision\deploy.env' }
Say "3/5 settings: $EnvFile"
if (Test-Path $EnvFile) { Write-Host '  kept your existing file' } else {
  New-Item -ItemType Directory -Force (Split-Path $EnvFile) | Out-Null
  Copy-Item (Join-Path $Root 'deploy.env.example') $EnvFile
  Write-Host '  created from deploy.env.example'
}
$AppPort = 8780
foreach ($l in Get-Content $EnvFile) { if ($l -match '^\s*APP_PORT=(\d+)') { $AppPort = [int]$Matches[1] } }

Say "4/5 test run on http://127.0.0.1:$AppPort/"
$log = Join-Path ([IO.Path]::GetTempPath()) "pingpong-run-$PID.log"
$p = Start-Process -FilePath $Bun -ArgumentList 'run.mjs' -WorkingDirectory $Root -PassThru -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err"
$ok = $false
for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    $a = Invoke-WebRequest "http://127.0.0.1:$AppPort/" -UseBasicParsing -TimeoutSec 2
    $b = Invoke-WebRequest "http://127.0.0.1:$AppPort/vision/" -UseBasicParsing -TimeoutSec 2
    $ok = ($a.StatusCode -eq 200) -and ($b.StatusCode -eq 200)
  } catch {}
}
# Stop run.mjs and the two servers it started.
Get-CimInstance Win32_Process -Filter "ParentProcessId=$($p.Id)" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
if ($ok) { Write-Host '  / and /vision/ answer 200: it works.' } else {
  Write-Host '  it did not answer. Its output:'; Get-Content $log, "$log.err" -ErrorAction SilentlyContinue | ForEach-Object { "    $_" }; exit 1
}
Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue

Say '5/5 start at sign-in'
if ($AutoStart) {
  $action = New-ScheduledTaskAction -Execute $Bun -Argument "`"$Root\run.mjs`"" -WorkingDirectory $Root
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'PingPong Vision' -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Write-Host "  Task Scheduler: 'PingPong Vision' runs bun run.mjs when you sign in. Remove: Unregister-ScheduledTask 'PingPong Vision'"
} else {
  Write-Host '  skipped (run again with -AutoStart to start it at every sign-in)'
}

Say 'next'
Write-Host '  Start it:   bun run.mjs        (keep the window open; Ctrl+C stops it)'
Write-Host "  Share it once (Tailscale app installed and signed in):   tailscale serve --bg --https=443 http://127.0.0.1:$AppPort"
Write-Host '  Then open https://<your PC''s Tailscale name>/ on your phone (README: Install on your PC).'
