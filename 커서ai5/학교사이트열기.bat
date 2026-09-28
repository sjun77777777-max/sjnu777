@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo 스쿨 럭키포인트
echo 브라우저에서  http://localhost:4173  으로 열어 주세요.
echo index.html 을 더블클릭하지 마세요.
echo 끝내려면 이 창에서 Ctrl+C 를 누르세요.
echo.
npx --yes serve -l 4173
