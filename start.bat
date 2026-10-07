@echo off
setlocal
cd /d "%~dp0"
py -3 -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>nul
if not errorlevel 1 (
  py -3 speedometer.py
  if errorlevel 1 pause
  exit /b
)
python -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>nul
if not errorlevel 1 (
  python speedometer.py
  if errorlevel 1 pause
  exit /b
)
echo Python 3.10+ is needed. Install it from https://www.python.org/downloads/
echo Check "Add python.exe to PATH", then double-click start.bat again.
pause
