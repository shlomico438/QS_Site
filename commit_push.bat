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

echo.
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