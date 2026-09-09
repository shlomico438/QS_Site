@echo off
setlocal EnableExtensions

:: Define configuration variables
set AWS_REGION=eu-north-1
set AWS_ACCOUNT_ID=760351563015
set IMAGE_NAME=quickscribe-site
set ECR_REPO=%AWS_ACCOUNT_ID%.dkr.ecr.%AWS_REGION%.amazonaws.com
set IMAGE_REPOSITORY=%ECR_REPO%/%IMAGE_NAME%
set "KOYEB_UPLOAD_USER=QuickScribe_Koyeb_Uploader"

:: AWS CLI uses the default chain (env keys, then ~/.aws/credentials [default]).
:: On this machine [default] is the Koyeb S3 upload user. Do not widen that
:: user's IAM. ECS deploy must use a named infra profile:
::   set AWS_PROFILE=quickscribe-ecs
::   python scripts/migrate_express_to_classic_ecs.py --apply
::   deploy.bat default quickscribe-site
if not defined AWS_PROFILE (
    echo AWS_PROFILE is not set. The AWS CLI default profile is the Koyeb upload user.
    echo Set a named infra profile before deploy, for example:
    echo   aws configure --profile quickscribe-ecs
    echo   set AWS_PROFILE=quickscribe-ecs
    echo Do not grant ECS deploy IAM to QuickScribe_Koyeb_Uploader.
    exit /b 1
)

echo Using AWS_PROFILE=%AWS_PROFILE%
for /f "delims=" %%I in ('aws sts get-caller-identity --query Arn --output text --region %AWS_REGION% --no-cli-pager 2^>nul') do set "AWS_CALLER_ARN=%%I"
if not defined AWS_CALLER_ARN (
    echo Error: Could not resolve AWS identity for profile %AWS_PROFILE%.
    echo Run: aws sts get-caller-identity --profile %AWS_PROFILE%
    exit /b 1
)
echo AWS identity: %AWS_CALLER_ARN%
echo %AWS_CALLER_ARN% | findstr /I /C:"%KOYEB_UPLOAD_USER%" >nul
if %errorlevel%==0 (
    echo Error: Refusing to deploy as %KOYEB_UPLOAD_USER%.
    echo That user is the public/Koyeb upload identity. Use AWS_PROFILE with an infra user.
    exit /b 1
)

:: Pass cluster/service as arguments, or define ECS_CLUSTER and ECS_SERVICE
:: before running this script:
::   deploy.bat my-cluster my-service
if not "%~1"=="" set "ECS_CLUSTER=%~1"
if not "%~2"=="" set "ECS_SERVICE=%~2"
if not defined ECS_CLUSTER (
    set /p "ECS_CLUSTER=ECS cluster name: "
)
if not defined ECS_SERVICE (
    set /p "ECS_SERVICE=ECS service name: "
)
if not defined ECS_CLUSTER (
    echo Error: ECS cluster name is required.
    exit /b 1
)
if not defined ECS_SERVICE (
    echo Error: ECS service name is required.
    exit /b 1
)

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
aws ecr get-login-password --region %AWS_REGION% | docker login --username AWS --password-stdin %ECR_REPO%
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
aws ecs update-service --cluster "%ECS_CLUSTER%" --service "%ECS_SERVICE%" --task-definition "%NEW_TASK_DEF%" --deployment-configuration "minimumHealthyPercent=100,maximumPercent=200" --health-check-grace-period-seconds 120 --force-new-deployment --region "%AWS_REGION%" --query "service.serviceArn" --output text --no-cli-pager
if %errorlevel% neq 0 (
    echo Error: ecs update-service failed.
    echo Classic service name is quickscribe-site, not the Express c259 name.
    exit /b %errorlevel%
)

echo Deployment started.
echo Image %IMMUTABLE_IMAGE%
echo Task definition %NEW_TASK_DEF%
echo Service %ECS_CLUSTER%/%ECS_SERVICE%
echo Monitor with: aws ecs describe-services --cluster %ECS_CLUSTER% --services %ECS_SERVICE%
pause
endlocal
