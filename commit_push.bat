@echo off
cls

:: Check if the user provided a comment as an argument
set COMMENT=%~1

:: If no comment was provided, use the timestamp
if "%COMMENT%"=="" (
    set TIMESTAMP=%date% %time%
    set COMMIT_MSG=Auto-commit: %TIMESTAMP%
) else (
    set COMMIT_MSG=%COMMENT%
)

echo -----------------------------------------
echo [0/4] Verifying Build (Syntax Check)...
echo -----------------------------------------
:: This command checks all .py files in the current directory for syntax errors
python -m compileall -q .

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Build verification failed! 
    echo Please fix the syntax errors above before committing.
    pause
    exit /b %errorlevel%
)
echo [SUCCESS] Syntax check passed.

echo -----------------------------------------
echo [0.5/4] Checking Simulation Mode...
echo -----------------------------------------
:: Using $null works in PowerShell, and >nul works in CMD.
:: For a batch file, we use >nul 2>&1 to be safe.
findstr /C:"SIMULATION_MODE = True" siteapp.py >nul 2>&1

if %errorlevel% equ 0 (
    echo.
    echo [ERROR] SIMULATION_MODE is still set to True!
    echo Please set it to False in siteapp.py before deploying.
    pause
    exit /b 1
) else (
    echo [SUCCESS] Production mode verified.
)

echo -----------------------------------------
echo [1/4] Adding changes...
echo -----------------------------------------
git add .

echo.
echo -----------------------------------------
echo [2/4] Committing with message: "%COMMIT_MSG%"
echo -----------------------------------------
git commit -m "%COMMIT_MSG%"

if %errorlevel% neq 0 (
    echo.
    echo [INFO] No changes detected to commit.
)

echo.
echo -----------------------------------------
echo [3/4] Pushing to remote...
echo -----------------------------------------
git push

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Push failed!
    pause
    exit /b %errorlevel%
)

echo.
echo -----------------------------------------
echo [4/4] [SUCCESS] Build verified and changes live!
echo -----------------------------------------
pause

set KOYEB_TOKEN=8wt69rbq7xta5ivm21s2xmkjimo3wkie43581w15kwq8pf2a13bpd03v3zmgjtti
set SERVICE_ID=c7fcdc62-2caf-4dba-a397-35d4a85b8ead?deploymentId=5a4a3f8a-c89d-45ec-8671-12b387dbb4a7

curl -X POST https://app.koyeb.com/v1/services/%SERVICE_ID%/redeploy ^
     -H "Authorization: Bearer %KOYEB_TOKEN%" ^
     -H "Content-Type: application/json