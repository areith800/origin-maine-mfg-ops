# Origin Maine Mfg Ops — BJJ Purchase Order Calculator

Internal manufacturing operations & purchase order planning web application for Origin Maine (`originmfg.com`), replacing manual Google Sheets PO calculation workflows with a deterministic, auditable web application backed by BigQuery.

---

## 1. Security & IT Code Review Highlights

* **Zero Third-Party Package Dependencies:**
  * Backend ([`server.py`](./server.py), [`po_engine.py`](./po_engine.py)) uses **100% Python 3.11 Standard Library** (`http.server`, `urllib.request`, `decimal`, `json`, `csv`).
  * Frontend ([`static/index.html`](./static/index.html), [`static/app.js`](./static/app.js), [`static/styles.css`](./static/styles.css)) uses **100% Vanilla JavaScript/HTML/CSS**.
  * There are **zero** external `pip` or `npm` packages, eliminating third-party supply-chain vulnerabilities.
* **Zero Stored Credentials or API Keys:**
  * No service account JSON keys, OAuth secrets, or tokens are stored in the repository or container image.
  * In Google Cloud Run (`K_SERVICE`), [`po_engine.get_gcp_access_token()`](./po_engine.py) fetches short-lived OAuth2 tokens directly from the internal GCP Metadata Server (`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token`).
* **Strictly Read-Only BigQuery Access:**
  * [`po_engine.fetch_bigquery_live_data()`](./po_engine.py) executes a single read-only `SELECT` query joining:
    * `origin-enterprise-prd.origin_operations.finished_goods_inventory_health`
    * `origin-enterprise-prd.origin_operations.sku_facts`
  * No DML/DDL (`INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`) exists anywhere in the codebase.
  * Factory Seconds (`-X`) and Custom (`-C`) SKUs are excluded at both the SQL query level and application layer.

---

## 2. Repository Structure

| File / Directory | Purpose |
| :--- | :--- |
| [`po_engine.py`](./po_engine.py) | Core PO calculation math (commercial half-away-from-zero rounding matching Google Sheets `ROUND()`), batch-size rounding rules (`nogi_10`, `pant_10`, `jacket_6`, `youth_6`, `acc_1`), GCP Metadata Server / `gcloud` token acquisition, and read-only BigQuery synchronization. |
| [`server.py`](./server.py) | Multi-threaded HTTP/JSON server (`ThreadingHTTPServer`), Role-Based Access Control (`Admin`, `PO Generator`, `Read-Only Viewer`), 15-minute automatic BigQuery cache refresh, 48-hour Pending PO Order Bridge (`compute_pending_po_state`), and deduplicated ShipHero CSV exporter. |
| [`static/index.html`](./static/index.html) | 5-step application layout (`1. Calculator Inputs`, `2. Proposed PO Output`, `3. Validate New SKUs`, `4. Archived SKUs`, `5. Access & Audit`). |
| [`static/app.js`](./static/app.js) | Interactive frontend state, real-time DOI/Lead-Time recalculation, Forward DOI vs. 90d Velocity DOI comparison, size-level SKU expansion/archiving, and audit log controls. |
| [`static/styles.css`](./static/styles.css) | Application stylesheet. |
| [`data/bjj_tabs_config.json`](./data/bjj_tabs_config.json) | Seed configuration for the 5 BJJ calculator tabs (`NOGI_PO_CALC`, `BJJACC_PO_CALC`, `YOUTH_PO_CALC`, `JACKET_PO_CALC`, `PANT_PO_CALC`), SKU flags (`phase_out`, `ignored`, `type_label`), access control list, and PO export audit log. |
| [`data/bq_cache.json`](./data/bq_cache.json) | Seed BigQuery inventory/velocity cache snapshot. |
| [`Dockerfile`](./Dockerfile) | Production container definition (`python:3.11-slim`). |
| [`deploy_cloud_run.ps1`](./deploy_cloud_run.ps1) | Automated Cloud Run deployment script targeting `manufacturing-data-415015` (`us-east4`). |
| [`PRODUCTION_DEPLOYMENT.md`](./PRODUCTION_DEPLOYMENT.md) | Cloud Run architecture, IAM permissions, and deployment runbook. |
| [`PO_PLANNING_CONTEXT.md`](./PO_PLANNING_CONTEXT.md) | Business rules, batch rounding logic, and spreadsheet parity documentation. |

---

## 3. Cloud Run Architecture & IAM Requirements

1. **Hosting Project:** `manufacturing-data-415015` (Region: `us-east4`)
2. **Cloud Run Service:** `origin-maine-mfg-ops` (`--cpu=1`, `--memory=512Mi`, `--max-instances=2`)
3. **Persistent Storage:** GCS Bucket `gs://origin-maine-mfg-ops-state` mounted at `/app/persistent_data` (`PO_DATA_DIR=/app/persistent_data`)
4. **Service Account:** `origin-maine-mfg-ops-sa@manufacturing-data-415015.iam.gserviceaccount.com`
   * **On `manufacturing-data-415015`:**
     * `roles/bigquery.jobUser` (to submit read-only BigQuery query jobs via `BQ_JOB_PROJECT=manufacturing-data-415015`)
     * `roles/storage.objectAdmin` on bucket `gs://origin-maine-mfg-ops-state`
   * **On `origin-enterprise-prd` (Required for live BigQuery refreshes):**
     * Add `origin-maine-mfg-ops-sa@manufacturing-data-415015.iam.gserviceaccount.com` to the **`bi_users@originmfg.com`** Google Group, **OR**
     * Grant `roles/bigquery.dataViewer` on dataset `origin-enterprise-prd.origin_operations`.

---

## 4. Running Locally

```powershell
py server.py
```
Then open `http://127.0.0.1:8765` in your browser.
