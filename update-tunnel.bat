@echo off
REM ─── LedgerIQ Tunnel URL Updater ─────────────────────────────────
REM Run this AFTER starting cloudflared to update Vercel with the new tunnel URL.
REM Usage: paste the trycloudflare.com URL when prompted, then run "vercel --prod"

set /p TUNNEL_URL="Paste your tunnel URL (e.g. https://abc-xyz.trycloudflare.com): "

REM Strip trailing slash if present
if "%TUNNEL_URL:~-1%"=="/" set TUNNEL_URL=%TUNNEL_URL:~0,-1%

echo.
echo Writing vercel.json with tunnel: %TUNNEL_URL%

(
echo {
echo   "rewrites": [
echo     {
echo       "source": "/api/(.*)",
echo       "destination": "%TUNNEL_URL%/api/$1"
echo     }
echo   ]
echo }
) > vercel.json

echo.
echo vercel.json updated. Now run:
echo   vercel --prod
echo.
pause
