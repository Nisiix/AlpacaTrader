# Installa il progetto sul PC Windows in D:\Applicazioni\WebDev\Bot alpaca agents (o nella cartella passata come argomento).
# Da PowerShell:  powershell -ExecutionPolicy Bypass -File installa-windows.ps1
# Oppure, senza aver ancora scaricato niente:
#   irm https://raw.githubusercontent.com/Nisiix/AlpacaTrader/ccr-f218832d-solbom/installa-windows.ps1 -OutFile installa-windows.ps1; powershell -ExecutionPolicy Bypass -File installa-windows.ps1
# Cosa fa: controlla git e bun (installa bun se manca), clona il repo (privato: git chiede le credenziali GitHub),
# prende il branch del motore, installa le dipendenze, crea secrets.ts da compilare, lancia i test,
# e crea sul desktop il collegamento "Bot alpaca agents" che avvia bun run agents.
param(
  [string]$Cartella = "D:\Applicazioni\WebDev\Bot alpaca agents",
  [string]$Repo = "https://github.com/Nisiix/AlpacaTrader.git",
  [string]$Branch = "ccr-f218832d-solbom"
)
$ErrorActionPreference = "Stop"

function Serve($cmd, $msg) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw $msg }
}
Serve git "Manca git: installalo da https://git-scm.com/download/win e rilancia."
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "Installo bun..." -ForegroundColor Cyan
  powershell -c "irm bun.sh/install.ps1 | iex"
  $env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
  Serve bun "bun non risulta installato: chiudi e riapri PowerShell, poi rilancia."
}

$padre = Split-Path -Parent $Cartella
if (-not (Test-Path $padre)) { New-Item -ItemType Directory -Path $padre | Out-Null }
if (Test-Path (Join-Path $Cartella ".git")) {
  Write-Host "Progetto già presente: aggiorno il branch $Branch" -ForegroundColor Cyan
  git -C $Cartella fetch origin $Branch
  git -C $Cartella checkout $Branch
  git -C $Cartella pull --ff-only origin $Branch
} else {
  Write-Host "Clono $Repo in '$Cartella'" -ForegroundColor Cyan
  git clone --branch $Branch $Repo $Cartella
}
Set-Location $Cartella
bun install
if (-not (Test-Path "secrets.ts")) {
  Copy-Item secrets.example.ts secrets.ts
  Write-Host "Creato secrets.ts: apri il file e metti chiavi paper di Alpaca (PK...), token e chat id del bot Telegram." -ForegroundColor Yellow
}
Write-Host "Test..." -ForegroundColor Cyan
bun test
if ($LASTEXITCODE -ne 0) { throw "I test non passano: non avviare il motore." }

# Collegamento sul desktop: avvia il motore in una finestra che resta aperta (Ctrl-C per fermarlo).
$desktop = [Environment]::GetFolderPath("Desktop")
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop "Bot alpaca agents.lnk"))
$lnk.TargetPath = "powershell.exe"
$lnk.Arguments = "-NoExit -Command `"Set-Location '$Cartella'; bun run agents`""
$lnk.WorkingDirectory = $Cartella
$lnk.Description = "Motore degli agenti Alpaca (paper) con dashboard su http://127.0.0.1:8787"
$lnk.Save()

Write-Host ""
Write-Host "Fatto. Prossimi passi:" -ForegroundColor Green
Write-Host "  1. Compila '$Cartella\secrets.ts' (chiavi PAPER di Alpaca, bot Telegram); poi installa-kronos.cmd per le proiezioni."
Write-Host "  2. Prova a vuoto:   bun run agents --fake --once"
Write-Host "  3. Avvia davvero:   doppio clic su 'Bot alpaca agents' sul desktop o su avvia-bot.cmd nella cartella (o bun run agents)."
Write-Host "  4. Dashboard:       http://127.0.0.1:8787"
Write-Host "  5. Per partire da solo all'accensione del PC: copia il collegamento in shell:startup (Win+R, shell:startup)."
Write-Host "Nota: spegni le sveglie cloud programmate e non lanciare bun run schedule insieme al motore."
