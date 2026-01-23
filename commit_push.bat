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
echo [1/3] Adding changes...
echo -----------------------------------------
git add .

echo.
echo -----------------------------------------
echo [2/3] Committing with message: "%COMMIT_MSG%"
echo -----------------------------------------
git commit -m "%COMMIT_MSG%"

if %errorlevel% neq 0 (
    echo.
    echo [INFO] No changes detected to commit.
)

echo.
echo -----------------------------------------
echo [3/3] Pushing to remote...
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
echo [SUCCESS] Done!
echo -----------------------------------------
pause