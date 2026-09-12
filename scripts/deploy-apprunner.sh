#!/usr/bin/env bash
# StayQuiet — build, push to Amazon ECR, and run on AWS App Runner.
# Prints the public HTTPS URL as its LAST line. Idempotent: re-running updates the
# existing service instead of creating a second one.
#
#   AWS_ACCOUNT_ID=123456789012 AWS_REGION=us-west-2 bash scripts/deploy-apprunner.sh
#
# Requires: aws CLI v2 authenticated, Docker running.
set -euo pipefail

: "${AWS_ACCOUNT_ID:?set AWS_ACCOUNT_ID (see .env.example)}"
: "${AWS_REGION:=us-west-2}"
: "${ECR_REPOSITORY:=stayquiet}"
SERVICE_NAME="${SERVICE_NAME:-stayquiet}"
# Immutable image tag per deploy (git sha, timestamp fallback). App Runner treats
# an update-service call with an unchanged image identifier as a no-op and keeps
# serving the old revision, so :latest alone never rolls out — the service must
# point at a tag that changes on every deploy.
IMAGE_TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
echo "[deploy] image tag=${IMAGE_TAG}"
ROLE_NAME="${ROLE_NAME:-StayQuietAppRunnerECRAccess}"
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"

echo "[deploy] region=${AWS_REGION} repo=${ECR_REPOSITORY} service=${SERVICE_NAME}"

# 1. ECR repository ---------------------------------------------------------
aws ecr describe-repositories --repository-names "$ECR_REPOSITORY" --region "$AWS_REGION" \
  >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$ECR_REPOSITORY" --region "$AWS_REGION" >/dev/null
echo "[deploy] ECR repository ready"

# 2. Build and push ---------------------------------------------------------
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
docker build -t "${ECR_URI}:${IMAGE_TAG}" -t "${ECR_URI}:latest" .
docker push "${ECR_URI}:${IMAGE_TAG}"
docker push "${ECR_URI}:latest"
echo "[deploy] image pushed: ${ECR_URI}:${IMAGE_TAG}"

# 3. Access role App Runner uses to pull from a private ECR ------------------
ROLE_ARN="arn:aws:iam::${AWS_ACCOUNT_ID}:role/${ROLE_NAME}"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"build.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
    >/dev/null
  aws iam attach-role-policy --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess >/dev/null
  echo "[deploy] created access role ${ROLE_NAME}; waiting 15s for IAM propagation"
  sleep 15
fi

# 4. Create or update the service -------------------------------------------
SERVICE_ARN="$(aws apprunner list-services --region "$AWS_REGION" \
  --query "ServiceSummaryList[?ServiceName=='${SERVICE_NAME}'].ServiceArn | [0]" --output text)"

SOURCE_CFG=$(cat <<JSON
{"ImageRepository":{"ImageIdentifier":"${ECR_URI}:${IMAGE_TAG}","ImageRepositoryType":"ECR",
 "ImageConfiguration":{"Port":"8080","RuntimeEnvironmentVariables":{"STAYQUIET_CYCLE_INTERVAL_S":"300"}}},
 "AutoDeploymentsEnabled":false,
 "AuthenticationConfiguration":{"AccessRoleArn":"${ROLE_ARN}"}}
JSON
)

if [ "$SERVICE_ARN" = "None" ] || [ -z "$SERVICE_ARN" ]; then
  SERVICE_ARN="$(aws apprunner create-service --region "$AWS_REGION" \
    --service-name "$SERVICE_NAME" \
    --source-configuration "$SOURCE_CFG" \
    --instance-configuration '{"Cpu":"1 vCPU","Memory":"2 GB"}' \
    --health-check-configuration '{"Protocol":"HTTP","Path":"/healthz","Interval":10,"Timeout":5,"HealthyThreshold":1,"UnhealthyThreshold":5}' \
    --query 'Service.ServiceArn' --output text)"
  echo "[deploy] service created"
else
  aws apprunner update-service --region "$AWS_REGION" --service-arn "$SERVICE_ARN" \
    --source-configuration "$SOURCE_CFG" >/dev/null
  echo "[deploy] service updated"
fi

# 5. Wait for RUNNING -------------------------------------------------------
for _ in $(seq 1 60); do
  STATUS="$(aws apprunner describe-service --region "$AWS_REGION" --service-arn "$SERVICE_ARN" \
    --query 'Service.Status' --output text)"
  [ "$STATUS" = "RUNNING" ] && break
  case "$STATUS" in
    CREATE_FAILED|DELETE_FAILED|PAUSED)
      echo "[deploy] service status ${STATUS} — see the App Runner console event log." >&2
      echo "[deploy] Fallback ladder: (1) run locally with 'python -m src.stayquiet' and demo on localhost," >&2
      echo "[deploy]   (2) STAYQUIET_DEMO_MODE=1 for the offline recorded run, (3) use the recorded capture." >&2
      exit 1 ;;
  esac
  echo "[deploy] status=${STATUS}; waiting"
  sleep 15
done

URL="https://$(aws apprunner describe-service --region "$AWS_REGION" --service-arn "$SERVICE_ARN" \
  --query 'Service.ServiceUrl' --output text)"
echo "[deploy] live at:"
echo "$URL"
