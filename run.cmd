@echo off
rem Starts SentinelStream from a clean slate: stops any previous run, starts
rem Redis, MongoDB and Neo4j, wipes and reseeds the demo data, starts the API
rem and the dashboard, then opens the dashboard.
rem   .\run              from PowerShell          run              from cmd
rem   .\run -Rebuild     also rebuilds the API jar and the UI bundle first
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\native\start-native.ps1" -Fresh %*
if errorlevel 1 (
  echo.
  echo Start failed. Logs are in %USERPROFILE%\SentinelNative\logs
  exit /b 1
)
start "" http://localhost:3000
