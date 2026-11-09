# Origin Maine Mfg Ops — Production Deployment & Authorization Guide

## 1. Where It Is Hosted in Your Google Cloud
We inspected your Google Cloud projects and configured deployment for **Origin Maine Mfg Ops**:
- **`manufacturing-data-415015` (App Hosting Project — Region `us-east4`):**
  - Your account (`andy@originmfg.com`) is already a **Project Owner (`roles/owner`)** on `manufacturing-data-415015`.
  - This is the exact same project and region (`us-east4`) where Origin already hosts **`workorder-generator`** (`https://workorder-generator-704023821794.us-east4.run.app`).
- **`origin-enterprise-prd` (BigQuery Enterprise Data Warehouse):**
  - Hosts `origin_operations.finished_goods_inventory_health` and `origin_operations.sku_facts`.
  - Grants `READER` access on `origin_operations` to the Google Group **`bi_users@originmfg.com`**.

---

## 2. How to Deploy to Google Cloud Run (2 Steps)

### Step 1: Run the Automated Deployment Script
Open PowerShell in `c:\Users\Andy\Desktop\Antigravity Projects\PO Generator` and run:

```powershell
.\deploy_cloud_run.ps1
```

What this script does automatically in `manufacturing-data-415015`:
1. Creates a dedicated Service Account:
   `origin-maine-mfg-ops-sa@manufacturing-data-415015.iam.gserviceaccount.com`
2. Grants it `roles/bigquery.jobUser` on `manufacturing-data-415015` so it can execute read-only BigQuery query jobs.
3. Creates a persistent Google Cloud Storage bucket (`gs://origin-maine-mfg-ops-state`) and mounts it into the Cloud Run container at `/app/persistent_data`.
   - Every config change, validated SKU, Pending PO Bridge state, and exported ShipHero CSV is saved directly to Cloud Storage so nothing is ever lost when containers scale or restart.
4. Builds the container from `Dockerfile` in Google Cloud Build and deploys **`origin-maine-mfg-ops`** to Cloud Run (`us-east4`), outputting a live `https://origin-maine-mfg-ops-...us-east4.run.app` URL that runs 24/7 independent of your computer.

### Step 2: Grant the Cloud Run Service Account Read Access to `origin_operations`
Because `origin-enterprise-prd.origin_operations` grants `READER` access via the **`bi_users@originmfg.com`** group (or via `origin-enterprise-prd` IAM managed by `wbates@originmfg.com` / `sid@originmfg.com`):
- **Option A (Easiest — Google Workspace Admin):** Add `origin-maine-mfg-ops-sa@manufacturing-data-415015.iam.gserviceaccount.com` as a member of **`bi_users@originmfg.com`**.
- **Option B (GCP Admin on `origin-enterprise-prd`):** Grant `origin-maine-mfg-ops-sa@manufacturing-data-415015.iam.gserviceaccount.com` the **`BigQuery Data Viewer`** (`roles/bigquery.dataViewer`) role on the dataset `origin-enterprise-prd.origin_operations`.

*(Even before Step 2 is completed, the deployed Cloud Run app will boot and work immediately using the latest cached BigQuery snapshot bundled in `data/bq_cache.json`, and once Step 2 is granted, the 15-minute auto-sync and manual `↻ Sync BigQuery` button will query `origin-enterprise-prd` directly from the cloud 24/7.)*
