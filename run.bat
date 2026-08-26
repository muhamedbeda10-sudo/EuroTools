@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   ATC Quality Inspection
echo   URL:  http://localhost:3001
echo   (keep this window open while working)
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed. Install it from https://nodejs.org then run setup.bat first.
  pause
  exit /b 1
)

rem Without node_modules nothing can build - setup.bat has not been run yet.
if not exist "node_modules" (
  echo [ERROR] Packages are not installed. Run setup.bat first.
  pause
  exit /b 1
)

rem Everything below is self-healing: setup.bat may have failed part-way, or
rem someone may have double-clicked this file on a fresh clone. Each step is
rem skipped when it is already done, so starting the app is never blocked by a
rem half-finished setup.

rem .env is not in git, so a fresh clone has no DATABASE_URL and every page
rem would fail at the first database query.
if not exist ".env" (
  echo Config file .env is missing - creating it from .env.example...
  copy /y ".env.example" ".env" >nul
  if errorlevel 1 (
    echo [ERROR] Could not create .env - copy .env.example to .env by hand.
    pause
    exit /b 1
  )
)

rem No database file means the migrations have never been applied.
if not exist "prisma\dev.db" (
  echo Database not found - preparing it now...
  call npx prisma migrate deploy
  if errorlevel 1 (
    echo [ERROR] Could not prepare the database - see the messages above.
    pause
    exit /b 1
  )
  echo.
  echo The database is empty. Load demo data to try every stage?
  echo WARNING: this wipes any data already in the database.
  choice /c YN /n /m "Press Y to load or N to skip: "
  if not errorlevel 2 call npm run seed
)

rem A folder called .next is not enough - a valid build has BUILD_ID inside it.
if not exist ".next\BUILD_ID" (
  echo No valid production build found - building now ^(1-2 minutes^)...
  call npm run build
)
if not exist ".next\BUILD_ID" (
  echo.
  echo [ERROR] Build failed - see the messages above. Fix and try again.
  pause
  exit /b 1
)

start "" http://localhost:3001
call npm run start
pause
