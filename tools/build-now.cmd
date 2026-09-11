@echo off
chcp 65001 >nul
title 取件码管家 - 一键编译 APK
cd /d "%~dp0.."

echo.
echo  取件码管家 - 一键编译 APK
echo  ================================
echo.

where pwsh >nul 2>nul
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-now.ps1"
) else (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-now.ps1"
)

echo.
if %errorlevel%==0 (
    echo  完成。按任意键关闭窗口。
) else (
    echo  出错了。请把上面的报错复制给 AI。按任意键关闭窗口。
)
pause >nul
