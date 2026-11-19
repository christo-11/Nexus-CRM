$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$backend = Join-Path $root 'flask-backend'
$frontend = Join-Path $root 'frontend'
$envFile = Join-Path $backend '.env'
$apiUrl = 'http://127.0.0.1:8001/api/v1/health'
$webUrl = 'http://127.0.0.1:5173/login'

function Test-ListeningPort([int]$Port) {
    return [bool](Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-CrmApi {
    try {
        $response = Invoke-RestMethod -Uri $apiUrl -TimeoutSec 5
        return $response.status -eq 'ok'
    } catch {
        return $false
    }
}

if (-not (Test-Path -LiteralPath $envFile)) {
    throw "Missing Flask configuration: $envFile. Copy flask-backend\.env.example to flask-backend\.env and set your admin credentials."
}

$settings = @{}
Get-Content -LiteralPath $envFile | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$') {
        $settings[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
    }
}

if (-not $settings['CRM_ADMIN_EMAIL'] -or -not $settings['CRM_ADMIN_PASSWORD']) {
    throw 'Set CRM_ADMIN_EMAIL and CRM_ADMIN_PASSWORD in flask-backend\.env before starting.'
}
if ($settings['DATABASE_URL'] -match '\[YOUR-PASSWORD\]|YOUR_URL_ENCODED_PASSWORD|<YOUR-PASSWORD>') {
    throw 'The Supabase database password is not configured. Run .\connect-supabase.cmd and enter it at the hidden prompt.'
}
if ($settings['DATABASE_URL'] -notmatch '^postgres(?:ql)?(?:\+psycopg)?://[^:/@]+:[^@]+@aws-0-ap-northeast-1\.pooler\.supabase\.com:5432/postgres(?:\?.*)?$') {
    throw 'This CRM is configured to use your Supabase PostgreSQL session pooler. Run .\connect-supabase.cmd to configure it.'
}
if ($settings['CRM_ADMIN_PASSWORD'].Length -lt 12) {
    throw 'CRM_ADMIN_PASSWORD must contain at least 12 characters.'
}

$changed = $false
$secretGenerator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
foreach ($key in @('SECRET_KEY', 'JWT_SECRET_KEY')) {
    $value = $settings[$key]
    if (-not $value -or $value.StartsWith('replace-with-') -or $value.Length -lt 32) {
        $bytes = New-Object byte[] 48
        $secretGenerator.GetBytes($bytes)
        $settings[$key] = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $changed = $true
    }
}
if ($settings['SECRET_KEY'] -ceq $settings['JWT_SECRET_KEY']) {
    throw 'SECRET_KEY and JWT_SECRET_KEY must be different. Update them in flask-backend\.env.'
}
if ($changed) {
    $lines = [System.Collections.Generic.List[string]]::new()
    Get-Content -LiteralPath $envFile | ForEach-Object { $lines.Add($_) }
    foreach ($key in @('SECRET_KEY', 'JWT_SECRET_KEY')) {
        $found = $false
        for ($index = 0; $index -lt $lines.Count; $index++) {
            if ($lines[$index] -match "^$key=") {
                $lines[$index] = "$key=$($settings[$key])"
                $found = $true
                break
            }
        }
        if (-not $found) {
            $lines.Add("$key=$($settings[$key])")
        }
    }
    [System.IO.File]::WriteAllText(
        $envFile,
        ($lines -join [Environment]::NewLine) + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )
    Write-Host 'Generated missing Flask signing keys in flask-backend\.env.'
}

$python = Join-Path $backend '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    $python = Join-Path $root '.venv\Scripts\python.exe'
}
if (-not (Test-Path -LiteralPath $python)) {
    throw 'Python virtual environment not found. Follow the first-time setup in README.md.'
}
if (-not (Test-Path -LiteralPath (Join-Path $frontend 'node_modules'))) {
    throw 'Frontend dependencies are missing. Run npm.cmd install inside frontend first.'
}

$apiAlreadyRunning = Test-CrmApi
if (-not $apiAlreadyRunning -and (Test-ListeningPort 8001)) {
    throw 'Port 8001 is occupied by a service that is not the Smart CRM API. Stop that service or change the API port and Vite proxy together.'
}

$webAlreadyRunning = $false
if (Test-ListeningPort 5173) {
    try {
        $webAlreadyRunning = (Invoke-WebRequest -Uri $webUrl -TimeoutSec 5).StatusCode -eq 200
    } catch {
        $webAlreadyRunning = $false
    }
    if (-not $webAlreadyRunning) {
        throw 'Port 5173 is occupied by a service that is not the Smart CRM frontend. Stop that service or update the frontend port.'
    }
}

$env:FLASK_DEBUG = '0'
Push-Location $backend
try {
    & $python -m flask --app app:create_app db upgrade
    if ($LASTEXITCODE -ne 0) {
        throw 'Database migration failed. Check the Flask output and DATABASE_URL in flask-backend\.env.'
    }
} finally {
    Pop-Location
}

if (-not $apiAlreadyRunning) {
    Push-Location $backend
    try {
        & $python -m flask --app app:create_app seed
        if ($LASTEXITCODE -ne 0) {
            throw 'Database seed failed. Check the Flask output and CRM_ADMIN_EMAIL/CRM_ADMIN_PASSWORD.'
        }
    } finally {
        Pop-Location
    }

    $apiProcess = Start-Process -FilePath $python -ArgumentList 'run.py' -WorkingDirectory $backend -PassThru
    $healthy = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        if (Test-CrmApi) {
            $healthy = $true
            break
        }
        if ($apiProcess.HasExited) {
            throw "Flask exited with code $($apiProcess.ExitCode). Review the Flask server window."
        }
    }
    if (-not $healthy) {
        throw 'Flask started but the health endpoint did not respond at http://127.0.0.1:8001/api/v1/health.'
    }
    Write-Host 'Flask API is healthy at http://127.0.0.1:8001.'
} else {
    Write-Host 'Using the already-running Smart CRM API.'
}

if (-not $webAlreadyRunning) {
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'npm.cmd run dev -- --host 127.0.0.1' -WorkingDirectory $frontend | Out-Null
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Seconds 1
        try {
            if ((Invoke-WebRequest -Uri $webUrl -TimeoutSec 5).StatusCode -eq 200) {
                $webAlreadyRunning = $true
                break
            }
        } catch {
            continue
        }
    }
    if (-not $webAlreadyRunning) {
        throw 'The Vite server did not respond at http://127.0.0.1:5173/login. Review the frontend server window.'
    }
} else {
    Write-Host 'Using the already-running React frontend.'
}

Write-Host ''
Write-Host 'Smart CRM is ready:'
Write-Host "  Sign in: $webUrl"
Write-Host '  API health: http://127.0.0.1:8001/api/v1/health'
Write-Host '  Stop servers with Ctrl+C in their server windows.'
