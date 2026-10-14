@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
set "DEPENDENCY_ROOT=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies"
set "SQLCMD_EXE=C:\Program Files\Microsoft SQL Server\Client SDK\ODBC\180\Tools\Binn\SQLCMD.EXE"
set "PYTHON_EXE=%DEPENDENCY_ROOT%\python\python.exe"
set "NODE_EXE=%DEPENDENCY_ROOT%\node\bin\node.exe"
set "OLLAMA_EXE=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
set "OLLAMA_LOG=%PROJECT_ROOT%data\private\logs\ollama-output.log"
set "OLLAMA_ERROR_LOG=%PROJECT_ROOT%data\private\logs\ollama-error.log"

if not exist "%SQLCMD_EXE%" (
  echo sqlcmd tidak ditemukan: %SQLCMD_EXE%
  exit /b 1
)
if not exist "%PYTHON_EXE%" (
  echo Python lokal dengan Pillow tidak ditemukan: %PYTHON_EXE%
  exit /b 1
)
if not exist "%NODE_EXE%" (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js tidak ditemukan pada perangkat ini.
    exit /b 1
  )
  set "NODE_EXE=node"
)

set "PORT=3180"
:find_port
set "PORT_IN_USE="
for /f "tokens=2" %%A in ('netstat -ano ^| findstr /R /C:"127.0.0.1:%PORT% .*LISTENING"') do set "PORT_IN_USE=1"
if not defined PORT_IN_USE goto port_ready
set /a PORT+=1
if %PORT% GTR 3190 (
  echo Port lokal 3180 hingga 3190 sedang digunakan. Tutup server Inspeksi Visual yang lama, lalu jalankan lagi.
  exit /b 1
)
goto find_port
:port_ready
if not defined SQL_SERVER set "SQL_SERVER=.\SQLEXPRESS"
set "NODE_PATH=%DEPENDENCY_ROOT%\node\node_modules"

set "OLLAMA_RUNNING="
for /f "tokens=2" %%A in ('netstat -ano ^| findstr /R /C:":11434 .*LISTENING"') do set "OLLAMA_RUNNING=1"
if not defined OLLAMA_RUNNING if exist "%OLLAMA_EXE%" (
  set "OLLAMA_HOST=127.0.0.1:11434"
  if not exist "%PROJECT_ROOT%data\private\logs" mkdir "%PROJECT_ROOT%data\private\logs"
  echo Mengaktifkan Ollama lokal...
  powershell.exe -NoProfile -Command "Start-Process -FilePath $env:OLLAMA_EXE -ArgumentList 'serve' -WindowStyle Hidden -RedirectStandardOutput $env:OLLAMA_LOG -RedirectStandardError $env:OLLAMA_ERROR_LOG"
)

echo Menjalankan Inspeksi Visual pada http://127.0.0.1:%PORT%
echo SQL Server: %SQL_SERVER% - database: K3VisionLocal
echo Akun Windows: %USERDOMAIN%\%USERNAME%
echo Catatan kesalahan SQL: %PROJECT_ROOT%data\private\logs\database-errors.log
echo Hentikan server dengan Ctrl+C.
"%NODE_EXE%" "%PROJECT_ROOT%server.js"
set "SERVER_EXIT=%ERRORLEVEL%"
if not "%SERVER_EXIT%"=="0" pause
exit /b %SERVER_EXIT%
