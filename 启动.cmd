@echo off
chcp 65001 >nul
title 海鲜记账 - 别关这个窗口
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo   没找到 Python。
  echo   要么装一个 Python，要么直接双击 index.html 试试
  echo   ^(但用 index.html 直接打开，可能存不住数据^)
  echo.
  pause
  exit /b
)

for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /c:"IPv4"') do set LANIP=%%i
set LANIP=%LANIP: =%

echo.
echo   ============================================
echo    电脑上看：   http://127.0.0.1:8899/
echo    手机上看：   http://%LANIP%:8899/
echo    （手机要和这台电脑连同一个 WiFi）
echo   ============================================
echo.
echo   记完账之前，这个黑窗口别关。
echo.

start "" http://127.0.0.1:8899/
python -m http.server 8899 --bind 0.0.0.0

echo.
echo   服务已经停了。按任意键关闭。
pause >nul
