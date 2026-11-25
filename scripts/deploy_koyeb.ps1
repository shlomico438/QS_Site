# Deploy the regular QuickScribe site to Koyeb (Docker).
# Requires: koyeb login already completed in an interactive terminal.
# -KeepEnv uploads the current code and leaves the service environment untouched.
# Without -KeepEnv, .env values are pushed (do not use that against the live app).
param([switch]$KeepEnv)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$Koyeb = Join-Path $env:LOCALAPPDATA 'koyeb\koyeb.exe'
if (-not (Test-Path $Koyeb)) {
    throw "Koyeb CLI not found at $Koyeb. Install it before running this script."
}

$App = if ($env:KOYEB_APP) { $env:KOYEB_APP } else { 'quickscribe' }
$Service = if ($env:KOYEB_SERVICE) { $env:KOYEB_SERVICE } else { 'site' }
$Instance = if ($env:KOYEB_INSTANCE) { $env:KOYEB_INSTANCE } else { 'medium' }
$Region = if ($env:KOYEB_REGION) { $env:KOYEB_REGION } else { 'fra' }

if ($KeepEnv) {
    & $Koyeb apps list | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Koyeb CLI is not logged in. In your own terminal run: koyeb login' }
    Write-Host "Deploying code only to $App/$Service. Existing Koyeb environment variables stay as they are."
    & $Koyeb deploy . "$App/$Service" `
        --archive-builder docker `
        --archive-docker-dockerfile Dockerfile `
        --wait `
        --wait-timeout 20m
    if ($LASTEXITCODE -ne 0) { throw "koyeb deploy failed ($LASTEXITCODE)" }
    Write-Host 'Code deploy finished.'
    exit 0
}

$allow = @(
    'S3_BUCKET', 'S3_ENDPOINT_URL', 'R2_ENDPOINT_URL', 'R2_REGION',
    'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
    'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ANON_KEY', 'SUPABASE_KEY',
    'GEMINI_API_KEY', 'GPT_API_KEY', 'GPT_MODEL', 'GPT_FALLBACK_MODEL',
    'ZOHO_SMTP_PASS', 'STRIPE_SECRET_KEY',
    'CARDCOM_SIMULATION', 'CARDCOM_SANDBOX', 'CARDCOM_ENABLED',
    'CARDCOM_TERMINAL_NUMBER', 'CARDCOM_API_NAME', 'CARDCOM_API_PASSWORD',
    'RUNPOD_API_KEY', 'RUNPOD_ENDPOINT_ID', 'RUNPOD_CPU_ENDPOINT_ID', 'RUNPOD_MOVIE_ENDPOINT_ID',
    'RUNPOD_SKIP_WARMUP'
)

$envMap = @{}
Get-Content (Join-Path $Root '.env') | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z0-9_]+)=(.*)$') {
        $envMap[$Matches[1]] = $Matches[2].Trim().Trim('"').Trim("'")
    }
}

$required = @('S3_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'RUNPOD_API_KEY', 'RUNPOD_ENDPOINT_ID')
$missing = @()
foreach ($k in $required) {
    if (-not $envMap.ContainsKey($k) -or -not $envMap[$k]) { $missing += $k }
}
if (-not $envMap['S3_ENDPOINT_URL'] -and -not $envMap['R2_ENDPOINT_URL']) { $missing += 'S3_ENDPOINT_URL or R2_ENDPOINT_URL' }
if ($missing.Count) {
    Write-Host "Missing in .env (names only): $($missing -join ', ')"
    throw 'Cannot deploy regular transcription without those values. Add them to .env and rerun.'
}

& $Koyeb apps list | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Koyeb CLI is not logged in. Run: koyeb login' }

$public = if ($env:KOYEB_PUBLIC_BASE_URL) { $env:KOYEB_PUBLIC_BASE_URL.TrimEnd('/') } else { '' }

$pairs = @(
    'SIMULATION_MODE=false',
    'TRANSCRIBE_MUSIC_VOCAL_SEPARATION_ENGINE=runpod'
)
if ($public) {
    $pairs += "PUBLIC_BASE_URL=$public"
    $pairs += "QS_CANONICAL_ORIGIN=$public"
}
foreach ($k in $allow) {
    if ($envMap.ContainsKey($k) -and $envMap[$k]) {
        $pairs += "$k=$($envMap[$k])"
    }
}

Write-Host "Deploying $App/$Service to Koyeb ($Region, $Instance) with R2 bucket set."
$deployArgs = @(
    'deploy', '.', "$App/$Service",
    '--archive-builder', 'docker',
    '--archive-docker-dockerfile', 'Dockerfile',
    '--type', 'web',
    '--instance-type', $Instance,
    '--regions', $Region,
    '--ports', '8000:http',
    '--routes', '/:8000',
    '--checks', '8000:http:/health',
    '--checks-grace-period', '8000=120',
    '--min-scale', '1',
    '--max-scale', '1',
    '--wait',
    '--wait-timeout', '20m'
)
foreach ($p in $pairs) { $deployArgs += @('--env', $p) }
& $Koyeb @deployArgs
if ($LASTEXITCODE -ne 0) { throw "koyeb deploy failed ($LASTEXITCODE)" }
Write-Host 'Deploy finished. If PUBLIC_BASE_URL was empty, set it to the Koyeb URL and redeploy once so RunPod callbacks hit this host.'
