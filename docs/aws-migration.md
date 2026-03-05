# AWS Migration Runbook (Astro SSR + Postgres)

This project is currently Astro SSR (`output: "server"`) with API routes and Postgres.
Do not migrate it as a fully static site unless you remove admin/API features.

Recommended AWS target:
- Compute: AWS App Runner (container deployment)
- Database: Amazon RDS for PostgreSQL
- DNS/edge: Cloudflare (optional but recommended)

## 1. Choose Region

Pick one region for both App Runner and RDS.

Suggestion for CN-friendly latency:
- `ap-southeast-1` (Singapore)
- `ap-northeast-1` (Tokyo)

Use a region where App Runner is available.

## 2. Prepare RDS PostgreSQL

1. Create an RDS PostgreSQL instance.
2. Create database/user credentials for this app.
3. Security Group:
   - Allow TCP `5432` from:
     - App Runner VPC connector security group
     - Your temporary local IP (only for bootstrap scripts)
4. Keep the connection URL ready:

```bash
postgresql://<db_user>:<db_password>@<db_host>:5432/<db_name>
```

## 3. Build and Push Image to ECR

Create an ECR repository and push the new `Dockerfile` image:

```bash
# set your values first
$env:AWS_REGION="ap-southeast-1"
$env:AWS_ACCOUNT_ID="<your-account-id>"
$env:ECR_REPO="apparent-ascension"

aws ecr create-repository --repository-name $env:ECR_REPO --region $env:AWS_REGION

aws ecr get-login-password --region $env:AWS_REGION `
| docker login --username AWS --password-stdin "$env:AWS_ACCOUNT_ID.dkr.ecr.$env:AWS_REGION.amazonaws.com"

docker build -t "${env:ECR_REPO}:latest" .
docker tag "${env:ECR_REPO}:latest" "$env:AWS_ACCOUNT_ID.dkr.ecr.$env:AWS_REGION.amazonaws.com/$env:ECR_REPO:latest"
docker push "$env:AWS_ACCOUNT_ID.dkr.ecr.$env:AWS_REGION.amazonaws.com/$env:ECR_REPO:latest"
```

## 4. Create App Runner Service

1. App Runner -> Create service -> Source: ECR.
2. Select image: `<account>.dkr.ecr.<region>.amazonaws.com/apparent-ascension:latest`
3. Container port: `8080`
4. Environment variables:
   - `NODE_ENV=production`
   - `DATABASE_URL=<your-rds-url>`
5. CPU/memory: start with `1 vCPU / 2 GB`.
6. Health check: HTTP path `/`.
7. Deploy and verify the generated `*.awsapprunner.com` URL.

## 5. Bootstrap Database

Run once from local terminal (while your local IP is allowed to RDS):

```bash
$env:DATABASE_URL="postgresql://<db_user>:<db_password>@<db_host>:5432/<db_name>"
npm ci
npm run db:init
npm run admin:create -- <admin_username> <strong_password>
```

Then remove your local IP from RDS inbound rules if not needed.

## 6. Domain and HTTPS

Option A (simple): Use App Runner custom domain.

Option B (recommended if you already use Cloudflare):
1. Add domain in Cloudflare.
2. Create `CNAME` record to App Runner default domain.
3. Keep proxy enabled (orange cloud).
4. SSL mode: `Full`.

## 7. Cache Rules (Cloudflare)

Cache aggressively:
- `/_astro/*`
- `/images/*`
- `*.js`, `*.css`, `*.webp`, `*.avif`

Bypass cache:
- `/api/*`
- `/admin*`

## 8. Cutover Checklist

1. App Runner URL works.
2. `/admin` login works.
3. `/schedule` save/update works.
4. DB tables are created.
5. Domain resolves and HTTPS is valid.
6. China multi-node tests (17CE/ITDog) pass basic availability.

## 9. Rollback Plan

If issues happen after DNS cutover:
1. Point DNS back to Heroku target.
2. Keep AWS service running for debugging.
3. Compare request logs and DB connectivity before retrying cutover.
