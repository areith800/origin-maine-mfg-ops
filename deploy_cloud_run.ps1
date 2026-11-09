# =============================================================================
# Origin Maine Mfg Ops — Cloud Run Deployment Script
# Target Hosting Project: manufacturing-data-415015 (same project/region as workorder-generator)
# Target BigQuery Data Source: origin-enterprise-prd.origin_operations (Read-Only)
# =============================================================================
param(
    [string]$ProjectId = "manufacturing-data-415015",
    [string]$Region = "us-east4",
    [string]$ServiceName = "origin-maine-mfg-ops",
    [string]$StateBucket = "origin-maine-mfg-ops-state",
    [string]$ServiceAccountName = "origin-maine-mfg-ops-sa"
)

$ErrorActionPreference = "Stop"
$Gcloud = "C:\Users\Andy\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
$ServiceAccountEmail = "${ServiceAccountName}@${ProjectId}.iam.gserviceaccount.com"

Write-Host "1. Setting active GCP Hosting Project to $ProjectId ($Region)..." -ForegroundColor Cyan
& $Gcloud config set project $ProjectId

Write-Host "2. Creating/Verifying Dedicated Cloud Run Service Account ($ServiceAccountEmail)..." -ForegroundColor Cyan
$saExists = & $Gcloud iam service-accounts list --project=$ProjectId --filter="email:$ServiceAccountEmail" --format="value(email)"
if (-not $saExists) {
    & $Gcloud iam service-accounts create $ServiceAccountName `
        --project=$ProjectId `
        --display-name="Origin Maine Mfg Ops Service Account (Read-Only BQ)"
}

# Allow the Service Account to run BigQuery SELECT query jobs in $ProjectId
& $Gcloud projects add-iam-policy-binding $ProjectId `
    --member="serviceAccount:$ServiceAccountEmail" `
    --role="roles/bigquery.jobUser" --quiet

Write-Host "3. Creating/Verifying Persistent State GCS Bucket (gs://$StateBucket)..." -ForegroundColor Cyan
$bucketExists = & $Gcloud storage buckets list --project=$ProjectId --filter="name:$StateBucket" --format="value(name)"
if (-not $bucketExists) {
    & $Gcloud storage buckets create "gs://$StateBucket" --project=$ProjectId --location=$Region --uniform-bucket-level-access
}

& $Gcloud storage buckets add-iam-policy-binding "gs://$StateBucket" `
    --member="serviceAccount:$ServiceAccountEmail" `
    --role="roles/storage.objectAdmin" --quiet

Write-Host "4. Building & Deploying $ServiceName to Cloud Run (with persistent GCS volume mount)..." -ForegroundColor Cyan
& $Gcloud run deploy $ServiceName `
    --source . `
    --project $ProjectId `
    --region $Region `
    --service-account $ServiceAccountEmail `
    --execution-environment gen2 `
    --cpu=1 `
    --memory=512Mi `
    --max-instances=2 `
    --add-volume="name=ops-state,type=cloud-storage,bucket=$StateBucket" `
    --add-volume-mount="volume=ops-state,mount-path=/app/persistent_data" `
    --set-env-vars="PO_DATA_DIR=/app/persistent_data,BQ_JOB_PROJECT=$ProjectId,DEFAULT_CLOUD_USER_EMAIL=andy@originmfg.com" `
    --allow-unauthenticated `
    --quiet

Write-Host ""
Write-Host "=============================================================================" -ForegroundColor Green
Write-Host "✓ Origin Maine Mfg Ops — Cloud Run Deployment Complete!" -ForegroundColor Green
Write-Host "Service Account Email: $ServiceAccountEmail" -ForegroundColor Yellow
Write-Host "IMPORTANT FOR LIVE BIGQUERY REFRESHES:" -ForegroundColor Yellow
Write-Host "Add $ServiceAccountEmail to the Google Group 'bi_users@originmfg.com'" -ForegroundColor Cyan
Write-Host "(or grant it BigQuery Data Viewer on origin-enterprise-prd.origin_operations)." -ForegroundColor Cyan
Write-Host "=============================================================================" -ForegroundColor Green
