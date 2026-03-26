@echo off
cls
setlocal EnableExtensions

:: Usage:
::   commit_push.bat "message"            -> quiet mode (default)
::   commit_push.bat "message" console    -> verbose command output

:: Check if the user provided a comment as an argument
set "COMMENT=%~1"
set "LOG_MODE=%~2"
set "SHOW_CONSOLE=0"
if /I "%LOG_MODE%"=="console" set "SHOW_CONSOLE=1"

:: If no comment was provided, use the timestamp
if "%COMMENT%"=="" (
    set TIMESTAMP=%date% %time%
    set COMMIT_MSG=Auto-commit: %TIMESTAMP%
) else (
    set COMMIT_MSG=%COMMENT%
)

echo -----------------------------------------
echo [0/5] Verifying Build (Syntax Check)...
echo -----------------------------------------
:: This command checks all .py files in the current directory for syntax errors
if "%SHOW_CONSOLE%"=="1" (
    python -m compileall -q .
) else (
    python -m compileall -q . >nul 2>&1
)

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Build verification failed! 
    echo Please fix the syntax errors above before committing.
    pause
    exit /b %errorlevel%
)
echo [SUCCESS] Syntax check passed.

echo -----------------------------------------
echo [0.5/5] Checking Simulation Mode...
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
echo [1/5] Adding changes...
echo -----------------------------------------
if "%SHOW_CONSOLE%"=="1" (
    git add .
) else (
    git add . >nul 2>&1
)

echo.
echo -----------------------------------------
echo [2/5] Committing with message: "%COMMIT_MSG%"
echo -----------------------------------------
if "%SHOW_CONSOLE%"=="1" (
    git commit --trailer "Made-with: Cursor" -m "%COMMIT_MSG%"
) else (
    git commit --trailer "Made-with: Cursor" -m "%COMMIT_MSG%" >nul 2>&1
)

if %errorlevel% neq 0 (
    echo.
    echo [INFO] No changes detected to commit.
)

echo.
echo -----------------------------------------
echo [3/5] Pushing current branch...
echo -----------------------------------------
for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set CURRENT_BRANCH=%%i
if "%SHOW_CONSOLE%"=="1" (
    git push origin %CURRENT_BRANCH%
) else (
    git push origin %CURRENT_BRANCH% >nul 2>&1
)

if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Push failed!
    pause
    exit /b %errorlevel%
)

echo -----------------------------------------
echo [4/5] Updating master branch...
echo -----------------------------------------
for /f "delims=" %%i in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set CURRENT_BRANCH=%%i

if "%CURRENT_BRANCH%"=="master" (
    echo [INFO] Already on master.
) else (
    if "%SHOW_CONSOLE%"=="1" (
        git checkout master
    ) else (
        git checkout master >nul 2>&1
    )
    if %errorlevel% neq 0 (
        echo [ERROR] Could not checkout master.
        pause
        exit /b 1
    )

    :: Check if master and dev share history
    if "%SHOW_CONSOLE%"=="1" (
        git merge --no-commit --no-ff %CURRENT_BRANCH%
    ) else (
        git merge --no-commit --no-ff %CURRENT_BRANCH% >nul 2>&1
    )
    if %errorlevel% neq 0 (
        echo [WARNING] Histories are unrelated. Force updating master to match dev.
        if "%SHOW_CONSOLE%"=="1" (
            git reset --hard %CURRENT_BRANCH%
        ) else (
            git reset --hard %CURRENT_BRANCH% >nul 2>&1
        )
    ) else (
        if "%SHOW_CONSOLE%"=="1" (
            git merge %CURRENT_BRANCH% -m "Merge %CURRENT_BRANCH% into master"
        ) else (
            git merge %CURRENT_BRANCH% -m "Merge %CURRENT_BRANCH% into master" >nul 2>&1
        )
    )

    :: Push master forcefully
    if "%SHOW_CONSOLE%"=="1" (
        git push -f origin master
    ) else (
        git push -f origin master >nul 2>&1
    )
    if %errorlevel% neq 0 (
        echo [ERROR] Push to master failed!
        if "%SHOW_CONSOLE%"=="1" (
            git checkout %CURRENT_BRANCH%
        ) else (
            git checkout %CURRENT_BRANCH% >nul 2>&1
        )
        pause
        exit /b %errorlevel%
    )

    if "%SHOW_CONSOLE%"=="1" (
        git checkout %CURRENT_BRANCH%
    ) else (
        git checkout %CURRENT_BRANCH% >nul 2>&1
    )
    echo [SUCCESS] Master updated from %CURRENT_BRANCH% and pushed.
)

echo.
echo -----------------------------------------
echo [5/5] [SUCCESS] Build verified and changes live on master!
echo -----------------------------------------

endlocal

::set KOYEB_TOKEN=8wt69rbq7xta5ivm21s2xmkjimo3wkie43581w15kwq8pf2a13bpd03v3zmgjtti
::set SERVICE_ID=c7fcdc62-2caf-4dba-a397-35d4a85b8ead?deploymentId=5a4a3f8a-c89d-45ec-8671-12b387dbb4a7

::curl -X POST https://app.koyeb.com/v1/services/%SERVICE_ID%/redeploy ^
::     -H "Authorization: Bearer %KOYEB_TOKEN%" ^
::     -H "Content-Type: application/json"
