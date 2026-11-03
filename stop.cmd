@echo off
rem Stops everything SentinelStream started: dashboard, API, Neo4j, MongoDB, Redis.
rem   .\stop             from PowerShell          stop             from cmd
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\native\stop-native.ps1"
