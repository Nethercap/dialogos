@echo off
rem Dialogos: opens the editor in the browser. Drop a .json project on this file to open it,
rem or double-click to edit dialogos.json in this folder. Close this window to stop it.
title Dialogos
set "PY="
py -3 -c "" >nul 2>&1 && set "PY=py -3"
if not defined PY python -c "" >nul 2>&1 && set "PY=python"
if not defined PY goto nopython
%PY% "%~dp0dialogos.py" %*
if errorlevel 1 pause
exit /b

:nopython
echo Python 3 is needed (https://www.python.org/downloads/).
echo Or open web\index.html in your browser: it works there too, saving in the browser.
pause
exit /b 1
