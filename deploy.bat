@echo off
setlocal EnableExtensions EnableDelayedExpansion

:: ECS deploy. Defaults: cluster default, service quickscribe-site,
:: profile quickscribe-ecs. If that profile is missing or still the Koyeb
:: uploader, you are prompted for infra IAM keys once, then deploy runs.
::
::   deploy.bat
::   deploy.bat default quickscribe-site

set AWS_REGION=eu-north-1
set AWS_ACCOUNT_ID=760351563015
set IMAGE_NAME=quickscribe-site
set ECR_REPO=%AWS_ACCOUNT_ID%.dkr.ecr.%AWS_REGION%.amazonaws.com
set IMAGE_REPOSITORY=%ECR_REPO%/%IMAGE_NAME%
set "KOYEB_UPLOAD_USER=QuickScribe_Koyeb_Uploader"
if not defined AWS_PROFILE set "AWS_PROFILE=quickscribe-ecs"

:: Env static keys override --profile and often point at the Koyeb uploader.
set "AWS_ACCESS_KEY_ID="
set "AWS_SECRET_ACCESS_KEY="
set "AWS_SESSION_TOKEN="

if not "%~1"=="" (set "ECS_CLUSTER=%~1") else if not defined ECS_CLUSTER set "ECS_CLUSTER=default"
if not "%~2"=="" (set "ECS_SERVICE=%~2") else if not defined ECS_SERVICE set "ECS_SERVICE=quickscribe-site"

echo Deploying %ECS_CLUSTER%/%ECS_SERVICE% in %AWS_REGION% via AWS profile [%AWS_PROFILE%]
call :resolve_identity
if not defined AWS_CALLER_ARN goto :prompt_keys
echo %AWS_CALLER_ARN% | findstr /I /C:"%KOYEB_UPLOAD_USER%" >nul
if !errorlevel! == 0 goto :prompt_keys
goto :have_identity

:prompt_keys
echo.
echo AWS profile [%AWS_PROFILE%] is missing or is %KOYEB_UPLOAD_USER%.
echo Paste the IAM access keys for user quickscribe-ecs.
python scripts\aws_profile_prompt_keys.py "%AWS_PROFILE%" "%AWS_REGION%"
if errorlevel 1 (
    echo Error: Could not save AWS keys.
    exit /b 1
)
call :resolve_identity
if not defined AWS_CALLER_ARN (
    echo Error: Could not resolve AWS identity for profile %AWS_PROFILE%.
    exit /b 1
)
echo %AWS_CALLER_ARN% | findstr /I /C:"%KOYEB_UPLOAD_USER%" >nul
if !errorlevel! == 0 (
    echo Error: Refusing to deploy as %KOYEB_UPLOAD_USER%.
    echo Those keys are the public/Koyeb upload identity. Use user quickscribe-ecs.
    exit /b 1
)

:have_identity
echo AWS identity: %AWS_CALLER_ARN%

for /f %%I in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "IMAGE_TAG=%%I"
set "IMMUTABLE_IMAGE=%IMAGE_REPOSITORY%:%IMAGE_TAG%"
set "LATEST_IMAGE=%IMAGE_REPOSITORY%:latest"
set "SERVICE_REVISION_FILE=%TEMP%\quickscribe-service-revision-%RANDOM%.txt"

echo [1/6] Building fresh Docker image %IMAGE_TAG%...
docker build --pull --label "quickscribe.build=%IMAGE_TAG%" -t "%IMMUTABLE_IMAGE%" .
if %errorlevel% neq 0 (
    echo Error: Docker build failed!
    exit /b %errorlevel%
)

echo [2/6] Logging into AWS ECR...
aws ecr get-login-password --region %AWS_REGION% --profile %AWS_PROFILE% --no-cli-pager | docker login --username AWS --password-stdin %ECR_REPO%
if %errorlevel% neq 0 (
    echo Error: AWS ECR login failed!
    exit /b %errorlevel%
)

echo [3/6] Pushing immutable image %IMMUTABLE_IMAGE%...
docker push "%IMMUTABLE_IMAGE%"
if %errorlevel% neq 0 (
    echo Error: Immutable image push failed!
    exit /b %errorlevel%
)

echo [4/6] Updating latest tag...
docker tag "%IMMUTABLE_IMAGE%" "%LATEST_IMAGE%"
if %errorlevel% neq 0 (
    echo Error: Docker tag failed!
    exit /b %errorlevel%
)
docker push "%LATEST_IMAGE%"
if %errorlevel% neq 0 (
    echo Error: Latest image push failed!
    exit /b %errorlevel%
)

echo [5/6] Registering a new task definition with %IMMUTABLE_IMAGE%...
python scripts\register_ecs_image.py --cluster "%ECS_CLUSTER%" --service "%ECS_SERVICE%" --image "%IMMUTABLE_IMAGE%" --region "%AWS_REGION%" > "%SERVICE_REVISION_FILE%"
if %errorlevel% neq 0 (
    echo Error: register-task-definition failed.
    echo Migrate first if the classic service does not exist:
    echo   python scripts/migrate_express_to_classic_ecs.py --apply
    del "%SERVICE_REVISION_FILE%" 2>nul
    exit /b %errorlevel%
)
set /p "NEW_TASK_DEF="<"%SERVICE_REVISION_FILE%"
del "%SERVICE_REVISION_FILE%" 2>nul
if not defined NEW_TASK_DEF (
    echo Error: AWS did not return a new task definition ARN.
    exit /b 1
)

echo [6/6] Rolling the classic ECS service (minimumHealthyPercent=100)...
aws ecs update-service --cluster "%ECS_CLUSTER%" --service "%ECS_SERVICE%" --task-definition "%NEW_TASK_DEF%" --deployment-configuration "minimumHealthyPercent=100,maximumPercent=200" --health-check-grace-period-seconds 120 --force-new-deployment --region "%AWS_REGION%" --profile %AWS_PROFILE% --query "service.serviceArn" --output text --no-cli-pager
if %errorlevel% neq 0 (
    echo Error: ecs update-service failed.
    echo Classic service name is quickscribe-site, not the Express c259 name.
    exit /b %errorlevel%
)

echo Deployment started.
echo Image %IMMUTABLE_IMAGE%
echo Task definition %NEW_TASK_DEF%
echo Service %ECS_CLUSTER%/%ECS_SERVICE%
echo Monitor with: aws ecs describe-services --cluster %ECS_CLUSTER% --services %ECS_SERVICE% --profile %AWS_PROFILE% --region %AWS_REGION%
pause
exit /b 0

:resolve_identity
set "AWS_CALLER_ARN="
for /f "delims=" %%I in ('aws sts get-caller-identity --profile %AWS_PROFILE% --query Arn --output text --region %AWS_REGION% --no-cli-pager 2^>nul') do set "AWS_CALLER_ARN=%%I"
exit /b 0
