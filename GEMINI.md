# BigQuery Warehouse Access & Read-Only Rules

## Connected Warehouses (GCP Projects)

1. **`origin-enterprise-prd`**
   - Datasets: `analytics_427173347`, `origin_app_workorder_generator`, `origin_finance`, `origin_intermediate`, `origin_master_data`, `origin_monday`, `origin_operations`, `origin_product`, `origin_snapshots`, `origin_sources`, `origin_staging`, `temp`
2. **`manufacturing-data-415015`**
   - Datasets: `Apparel_ME`, `Apparel_NC`, `Footwear_Maine`, `analysis_tables`, `reference`, `workorder_generator`

## Strict Read-Only Policy

All BigQuery access in this workspace MUST remain strictly **read-only**:

- **Allowed Operations:**
  - Listing datasets and tables: `bq ls --project_id=<project_id> [dataset]`
  - Inspecting schemas and metadata: `bq show --schema --format=prettyjson <project_id>:<dataset>.<table>`
  - Previewing rows: `bq head -n 20 <project_id>:<dataset>.<table>`
  - Running read-only queries: `bq query --project_id=<project_id> --use_legacy_sql=false "SELECT ..."` (only `SELECT` / `WITH ... SELECT` statements, or `INFORMATION_SCHEMA` queries).
- **Prohibited Operations:**
  - Never run any DML or DDL statements (`INSERT`, `UPDATE`, `DELETE`, `MERGE`, `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `EXPORT`).
  - Never run mutating `bq` CLI commands (`bq mk`, `bq rm`, `bq update`, `bq load`, `bq cp`, `bq extract`).
