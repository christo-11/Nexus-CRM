$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$backend = Join-Path $root 'flask-backend'
$envFile = Join-Path $backend '.env'
$apiUrl = 'http://127.0.0.1:8001/api/v1/health'
$python = Join-Path $backend '.venv\Scripts\python.exe'

if (-not (Test-Path -LiteralPath $envFile)) {
    throw 'flask-backend\.env was not found. Create it and set your CRM admin email and password first.'
}
if (-not (Test-Path -LiteralPath $python)) {
    $python = Join-Path $root '.venv\Scripts\python.exe'
}
if (-not (Test-Path -LiteralPath $python)) {
    throw 'Python virtual environment not found. Follow the first-time setup in README.md.'
}

$settings = @{}
Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
        $settings[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
    }
}
if (-not $settings['CRM_ADMIN_EMAIL'] -or -not $settings['CRM_ADMIN_PASSWORD']) {
    throw 'Set CRM_ADMIN_EMAIL and CRM_ADMIN_PASSWORD in flask-backend\.env before continuing.'
}
if ($settings['CRM_ADMIN_PASSWORD'].Length -lt 12) {
    throw 'CRM_ADMIN_PASSWORD must contain at least 12 characters.'
}
if (-not $settings['SECRET_KEY'] -or -not $settings['JWT_SECRET_KEY'] -or
    $settings['SECRET_KEY'].StartsWith('replace-with-') -or
    $settings['JWT_SECRET_KEY'].StartsWith('replace-with-') -or
    $settings['SECRET_KEY'].Length -lt 32 -or $settings['JWT_SECRET_KEY'].Length -lt 32 -or
    $settings['SECRET_KEY'] -ceq $settings['JWT_SECRET_KEY']) {
    throw 'Set two different random secret keys of at least 32 characters in flask-backend\.env before connecting.'
}

$listener = Get-NetTCPConnection -LocalPort 8001 -State Listen -ErrorAction SilentlyContinue
if ($listener) {
    throw 'The backend is running on port 8001. Stop its Flask terminal with Ctrl+C, then rerun .\connect-supabase.cmd.'
}

$securePassword = Read-Host 'Enter your Supabase database password (input is hidden)' -AsSecureString
$databasePassword = [System.Net.NetworkCredential]::new('', $securePassword).Password
if (-not $databasePassword) {
    throw 'A database password is required.'
}
$encodedPassword = [uri]::EscapeDataString($databasePassword)
$databaseUrl = "postgresql://postgres.wvbokushsenupvsahmhe:$encodedPassword@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres?sslmode=require"
$previousDatabaseUrl = $settings['DATABASE_URL']

function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
    $lines = [System.Collections.Generic.List[string]]::new()
    Get-Content -LiteralPath $Path | ForEach-Object { $lines.Add($_) }
    $found = $false
    for ($index = 0; $index -lt $lines.Count; $index++) {
        if ($lines[$index] -match "^$Key=") {
            $lines[$index] = "$Key=$Value"
            $found = $true
            break
        }
    }
    if (-not $found) {
        $lines.Add("$Key=$Value")
    }
    [System.IO.File]::WriteAllText(
        $Path,
        ($lines -join [Environment]::NewLine) + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )
}

$databaseReady = $false
try {
    Set-EnvValue -Path $envFile -Key 'DATABASE_URL' -Value $databaseUrl
    Set-EnvValue -Path $envFile -Key 'FLASK_DEBUG' -Value '0'
    $env:DATABASE_URL = $databaseUrl
    $env:FLASK_DEBUG = '0'
    Push-Location $backend
    try {
        & $python -m flask --app app:create_app db upgrade
        if ($LASTEXITCODE -ne 0) {
            throw 'Could not connect to Supabase or apply migrations. Check the password and Supabase connection settings.'
        }
        & $python -m flask --app app:create_app seed
        if ($LASTEXITCODE -ne 0) {
            throw 'Supabase schema is ready, but CRM seed failed. Check the configured admin account and rerun this script.'
        }
    } finally {
        Pop-Location
    }
    $databaseReady = $true
} catch {
    if (-not $databaseReady -and $previousDatabaseUrl) {
        Set-EnvValue -Path $envFile -Key 'DATABASE_URL' -Value $previousDatabaseUrl
        Write-Host 'Restored the previous database setting; your local SQLite data was not changed.'
    }
    throw
} finally {
    if ($securePassword) {
        $securePassword.Dispose()
    }
    $securePassword = $null
    $databasePassword = $null
    $encodedPassword = $null
    $databaseUrl = $null
    $env:DATABASE_URL = $null
}

$apiProcess = Start-Process -FilePath $python -ArgumentList 'run.py' -WorkingDirectory $backend -PassThru
$healthy = $false
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Seconds 1
    try {
        $health = Invoke-RestMethod -Uri $apiUrl -TimeoutSec 5
        if ($health.status -eq 'ok') {
            $healthy = $true
            break
        }
    } catch {
        if ($apiProcess.HasExited) {
            throw "Flask exited with code $($apiProcess.ExitCode) after connecting to Supabase."
        }
    }
}
if (-not $healthy) {
    throw 'Supabase migrations completed, but the API health check did not respond on port 8001.'
}

& (Join-Path $root 'start-crm.ps1')

$headers = @{
    'Content-Type' = 'application/json'
}
$loginBody = @{
    email = $settings['CRM_ADMIN_EMAIL']
    password = $settings['CRM_ADMIN_PASSWORD']
} | ConvertTo-Json
$login = Invoke-RestMethod -Uri 'http://127.0.0.1:8001/api/v1/auth/login' `
    -Method Post -Headers $headers -Body $loginBody -TimeoutSec 10
if (-not $login.access -or $login.user.role -ne 'MAIN_ADMIN') {
    throw 'The database is connected, but the configured admin login did not verify as Main Admin.'
}

Write-Host ''
Write-Host 'Supabase connection verified and Smart CRM API is ready.'
Write-Host '  Sign in: http://127.0.0.1:5173/login'
Write-Host '  Database: Supabase PostgreSQL (TLS required)'
Write-Host '  Admin login: verified as Main Admin'
Write-Host '  Stop the API and frontend with Ctrl+C in their server windows.'
