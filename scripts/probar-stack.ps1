# probar-stack.ps1 - levanta TODO lo necesario para probar AlRescate en local:
#   1) los emuladores de Firebase (la "nube falsa", proyecto alrescate-cbb6a = el de la app)
#   2) el backend apuntado a esos emuladores
#   3) los usuarios de prueba (seeds)
# Cada pieza queda en su propia ventana; cerrarlas apaga todo. No toca nada real.
# Uso: doble clic en probar.cmd (raiz del repo) o .\scripts\probar-stack.ps1

$ErrorActionPreference = 'Stop'
$server = Split-Path $PSScriptRoot -Parent

function Wait-Port([int]$port, [string]$label, [int]$timeoutSec) {
    Write-Host "   esperando $label..." -ForegroundColor DarkGray
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $c = New-Object Net.Sockets.TcpClient
            $c.Connect('127.0.0.1', $port); $c.Close()
            return $true
        } catch { Start-Sleep -Milliseconds 800 }
    }
    return $false
}

if (-not (Test-Path (Join-Path $server 'secrets\serviceAccountKey.dev.json'))) {
    Write-Host "FALTA secrets\serviceAccountKey.dev.json (pedisela a Jose por canal seguro)." -ForegroundColor Red
    exit 1
}

Write-Host "[1/3] Emuladores de Firebase (ventana nueva)..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList '-NoExit','-Command',
    "`$host.UI.RawUI.WindowTitle='AlRescate - Firebase (cerrar para apagar)'; cd '$server'; firebase emulators:start --project alrescate-cbb6a"
if (-not (Wait-Port 9099 'el emulador de Auth (9099)' 120)) { Write-Host 'No arranco. Mira la ventana de Firebase.' -ForegroundColor Red; exit 1 }
if (-not (Wait-Port 8081 'el emulador de Firestore (8081)' 60)) { Write-Host 'No arranco. Mira la ventana de Firebase.' -ForegroundColor Red; exit 1 }

Write-Host "[2/3] Backend (ventana nueva)..." -ForegroundColor Cyan
$envCmd = "`$env:FIRESTORE_EMULATOR_HOST='127.0.0.1:8081'; " +
          "`$env:FIREBASE_AUTH_EMULATOR_HOST='127.0.0.1:9099'; " +
          "`$env:FIREBASE_STORAGE_EMULATOR_HOST='127.0.0.1:9199'; " +
          "`$env:FIREBASE_PROJECT_ID='alrescate-cbb6a'; " +
          "`$env:FIREBASE_STORAGE_BUCKET='alrescate-cbb6a.firebasestorage.app'"
Start-Process powershell -ArgumentList '-NoExit','-Command',
    "`$host.UI.RawUI.WindowTitle='AlRescate - Backend (cerrar para apagar)'; cd '$server'; $envCmd; npm run dev"
if (-not (Wait-Port 8080 'el backend (8080)' 180)) { Write-Host 'No arranco. Mira la ventana del Backend.' -ForegroundColor Red; exit 1 }

Write-Host "[3/3] Usuarios de prueba..." -ForegroundColor Cyan
$env:FIRESTORE_EMULATOR_HOST = '127.0.0.1:8081'
$env:FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
$env:FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9199'
Push-Location $server
node scripts\e2e-seed-full.js
node scripts\e2e-seed-helper.js
node scripts\e2e-seed-verifications.js
Pop-Location

Write-Host ''
Write-Host '=================== LISTO ===================' -ForegroundColor Green
Write-Host ' Ya podes darle Run a la app en Android Studio.'
Write-Host ''
Write-Host ' Usuarios de prueba (password: Test123456)'
Write-Host '   repartidor:  delivery@alrescate.test'
Write-Host '   ayudante:    helper@alrescate.test'
Write-Host '   admin panel: admin@alrescate.test'
Write-Host ''
Write-Host ' Para apagar todo: cerra las 2 ventanas que se abrieron.'
Write-Host '============================================='
