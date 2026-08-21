@echo off
setlocal

REM Run this file from the ROOT of your CURRENT Git repository after extracting
REM the FamFin Unified API package over the old tracked files.

git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo ERROR: This folder is not a Git repository.
  echo Open Command Prompt in the folder that contains the .git directory.
  exit /b 1
)

REM Never stage local secrets or dependencies.
git add -A
git restore --staged .env >nul 2>&1
git restore --staged node_modules >nul 2>&1

echo.
echo ===== GIT STATUS =====
git status

echo.
echo Committing FamFin Family Sharing API...
git commit -m "Add FamFin family sharing API"
if errorlevel 1 (
  echo.
  echo NOTE: Commit was not created. If Git said there is nothing to commit,
  echo the files may already be committed. Otherwise review the error above.
)

echo.
echo Pushing current main branch to origin...
git push origin main
if errorlevel 1 (
  echo.
  echo PUSH FAILED. Review the Git message above.
  exit /b 1
)

echo.
echo SUCCESS: pushed to origin/main.
echo If Render Auto-Deploy is enabled, Render will deploy this commit.
endlocal
