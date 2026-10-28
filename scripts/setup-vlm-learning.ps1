$ErrorActionPreference='Stop'
$projectRoot=Split-Path -Parent $PSScriptRoot
$environmentPath=Join-Path $projectRoot 'data\private\vlm-learning-env'
$pythonCommand=if($env:PYTHON_EXE){$env:PYTHON_EXE}else{'python'}
& $pythonCommand -m venv $environmentPath
if($LASTEXITCODE -ne 0){throw 'Pembuatan lingkungan Python gagal.'}
$workerPython=Join-Path $environmentPath 'Scripts\python.exe'
& $workerPython -m pip install 'torch==2.8.0' 'torchvision==0.23.0' --index-url https://download.pytorch.org/whl/cpu
if($LASTEXITCODE -ne 0){throw 'Pemasangan PyTorch CPU gagal.'}
& $workerPython -m pip install -r (Join-Path $projectRoot 'deploy\container\vlm-requirements.txt')
if($LASTEXITCODE -ne 0){throw 'Pemasangan dependensi pelatihan gagal.'}
Write-Host 'Worker pelatihan CPU siap. Mulai ulang aplikasi, lalu buka AI Inspeksi Visual.'
