@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js est requis pour lancer l'apercu Web.
  echo Installez Node.js, puis relancez ce fichier.
  pause
  exit /b 1
)

if not exist "node_modules\esbuild\package.json" (
  echo Installation des dependances Web...
  call npm install
  if errorlevel 1 (
    echo L'installation des dependances a echoue.
    pause
    exit /b 1
  )
)

call npm start -- --open

echo.
echo Le serveur s'est arrete.
pause
