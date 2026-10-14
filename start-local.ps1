param(
  [int]$Port = 3180,
  [string]$SqlServer = '.\SQLEXPRESS'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$DependencyRoot = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies'
$SqlcmdPath = 'C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\180\Tools\Binn\SQLCMD.EXE'
$PythonPath = Join-Path $DependencyRoot 'python\python.exe'
$NodePath = Join-Path $DependencyRoot 'node\bin\node.exe'

if (-not (Test-Path -LiteralPath $SqlcmdPath)) { throw "sqlcmd tidak ditemukan: $SqlcmdPath" }
if (-not (Test-Path -LiteralPath $PythonPath)) { throw "Python lokal dengan Pillow tidak ditemukan: $PythonPath" }
if (-not (Test-Path -LiteralPath $NodePath)) {
  $NodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if (-not $NodeCommand) { throw 'Node.js tidak ditemukan pada perangkat ini.' }
  $NodePath = $NodeCommand.Source
}

$env:PORT = [string]$Port
$env:SQL_SERVER = $SqlServer
$env:SQLCMD_EXE = $SqlcmdPath
$env:PYTHON_EXE = $PythonPath
$env:NODE_PATH = Join-Path $DependencyRoot 'node\node_modules'

Write-Host "Menjalankan Inspeksi Visual pada http://127.0.0.1:$Port"
Write-Host "SQL Server: $SqlServer · database: K3VisionLocal"
Write-Host 'Hentikan server dengan Ctrl+C.'
& $NodePath (Join-Path $ProjectRoot 'server.js')
