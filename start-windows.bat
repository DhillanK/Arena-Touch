@echo off
title Arena Touch
cd /d "%~dp0"
set PY=
where py >nul 2>nul && set PY=py -3
if not defined PY where python >nul 2>nul && set PY=python
if not defined PY (
  echo Python 3 was not found. Install it from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH", then run this again.
  pause
  exit /b 1
)
%PY% server.py %*
pause
