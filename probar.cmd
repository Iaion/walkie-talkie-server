@echo off
rem Doble clic aca = levanta todo lo necesario para probar AlRescate en local.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\probar-stack.ps1"
pause
