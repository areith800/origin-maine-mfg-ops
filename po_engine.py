import json
import math
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
BUNDLED_DATA_DIR = BASE_DIR / "data"
DATA_DIR = Path(os.environ.get("PO_DATA_DIR", str(BUNDLED_DATA_DIR))).resolve()
DATA_DIR.mkdir(parents=True, exist_ok=True)
CONFIG_PATH = DATA_DIR / "bjj_tabs_config.json"
BQ_CACHE_PATH = DATA_DIR / "bq_cache.json"

# Seed persistent volume on first Cloud Run boot if mounted directory is empty
if DATA_DIR != BUNDLED_DATA_DIR:
    if not CONFIG_PATH.exists() and (BUNDLED_DATA_DIR / "bjj_tabs_config.json").exists():
        shutil.copy2(BUNDLED_DATA_DIR / "bjj_tabs_config.json", CONFIG_PATH)
    if not BQ_CACHE_PATH.exists() and (BUNDLED_DATA_DIR / "bq_cache.json").exists():
        shutil.copy2(BUNDLED_DATA_DIR / "bq_cache.json", BQ_CACHE_PATH)


def excel_round(val: float, digits: int = 0) -> float:
    """Matches Google Sheets / Excel ROUND() (round half away from zero)."""
    if val is None or math.isnan(val):
        return 0.0
    d = Decimal(f"{float(val):.10f}")
    q = Decimal("10") ** (-digits) if digits != 0 else Decimal("1")
    res = d.quantize(q, rounding=ROUND_HALF_UP)
    return float(res) if digits != 0 else int(res)


def compute_row_math(
    *,
    sku: str = "",
    velo_90d: float,
    velo_30d: float,
    available: float,
    backorder: float,
    on_order: float,
    on_site: bool,
    phase_out: bool,
    pre_launch: bool,
    doi_target: float,
    lead_time: float,
    batch_rule: str,
    manual_po_override: int | None = None,
    enforce_on_site_guardrail: bool = True,
) -> dict:
    """
    Bulletproof implementation of the Origin BJJ PO Calculator math.
    """
    v90 = float(velo_90d or 0.0)
    v30 = float(velo_30d or 0.0)
    avail = float(available or 0.0)
    bo = float(backorder or 0.0)
    wip = float(on_order or 0.0)
    doi = float(doi_target or 0.0)
    lt = float(lead_time or 0.0)

    # Off-site guardrail: if a SKU is not on website and not marked Pre-Launch,
    # treat it like Phase-Out/MTO (no target inventory stock build, only cover backorders)
    effective_phase_out = bool(phase_out) or (
        enforce_on_site_guardrail and (not on_site) and (not pre_launch)
    )

    # Column G: OHOO Target
    # =IF(F2=FALSE, ROUND(J2*Q$5, 0), "")
    if effective_phase_out:
        ohoo_target = 0
    else:
        ohoo_target = int(excel_round(v90 * doi, 0))

    # Column M: Reqd
    # =IF(F2=TRUE, I2-L2, (G2 + I2 + K2*Q$6 - H2 - L2))
    lead_time_demand = v30 * lt
    if effective_phase_out:
        reqd = bo - wip
    else:
        reqd = ohoo_target + bo + lead_time_demand - avail - wip

    # Column N: PO Amt (calculated before manual override)
    if effective_phase_out:
        # Fix #1: Clamp Phase-Out / MTO PO Amt to MAX(0, ROUND(M, 0)) so excess WIP never creates negative POs
        calc_po_amt = max(0, int(excel_round(reqd, 0)))
    else:
        if reqd <= 0:
            calc_po_amt = 0
        elif batch_rule == "nogi_10":
            # =IF(M2>0, IF(AND(M2>0, M2<10), 10, ROUND(M2/10, 0)*10), 0)
            calc_po_amt = 10 if reqd < 10 else int(excel_round(reqd / 10.0, 0) * 10)
        elif batch_rule == "pant_10":
            # =IF(M2>0, IF(AND(M2>0, M2<6), 10, ROUND(M2/10, 0)*10), 0)
            calc_po_amt = 10 if reqd < 6 else int(excel_round(reqd / 10.0, 0) * 10)
        elif batch_rule == "jacket_6":
            # =IF(M2>0, IF(AND(M2>0, M2<6), 6, ROUND(M2/6, 0)*6), 0)
            calc_po_amt = 6 if reqd < 6 else int(excel_round(reqd / 6.0, 0) * 6)
        elif batch_rule == "youth_6":
            # =IF(M2>0, IF(AND(M2>0, M2<4), ROUND(M2, 0), ROUND(M2/6, 0)*6), 0)
            calc_po_amt = int(excel_round(reqd, 0)) if reqd < 4 else int(excel_round(reqd / 6.0, 0) * 6)
        elif batch_rule == "acc_1":
            # In BJJACC_PO_CALC, Sling Sacks (9000014) batch in multiples of 6:
            # =IF(M37>0, IF(AND(M37>0, M37<3), 6, MROUND(M37, 6)), 0)
            # While Belts (9000057, 9000077) batch in whole units (min 1):
            if sku.startswith("9000014"):
                calc_po_amt = 6 if reqd < 3 else int(excel_round(reqd / 6.0, 0) * 6)
            else:
                calc_po_amt = 1 if reqd < 1 else int(excel_round(reqd, 0))
        else:
            calc_po_amt = int(excel_round(reqd, 0))

    final_po_amt = int(manual_po_override) if manual_po_override is not None else calc_po_amt

    # Warnings / Guardrail flags
    warnings = []
    if bo > 0 and bo > wip and final_po_amt < (bo - wip):
        warnings.append("UNCOVERED_BACKORDER")
    if (not on_site) and (not phase_out) and (not pre_launch):
        warnings.append("OFF_SITE_AUTO_SUPPRESSED")
    if v90 >= 0.25 and v30 < (v90 * 0.45) and final_po_amt > 0:
        warnings.append("VELOCITY_DECELERATING")
    if v90 >= 0.1 and v30 > (v90 * 2.2) and final_po_amt > 0:
        warnings.append("VELOCITY_SPIKE_30D")

    post_po_supply = avail + wip + final_po_amt - bo
    post_po_doi = round(post_po_supply / v90, 1) if v90 > 0 else None

    return {
        "ohoo_target": ohoo_target,
        "lead_time_demand": round(lead_time_demand, 2),
        "reqd": round(reqd, 2),
        "calc_po_amt": calc_po_amt,
        "po_amt": final_po_amt,
        "is_overridden": manual_po_override is not None,
        "effective_phase_out": effective_phase_out,
        "post_po_doi": post_po_doi,
        "warnings": warnings,
    }


class GCloudAuthExpiredError(RuntimeError):
    """Raised when local gcloud OAuth session has expired and needs interactive login."""


_ACTIVE_LOGIN_PROC: subprocess.Popen | None = None
_ACTIVE_LOGIN_URL: str | None = None


def get_gcloud_cmd() -> str:
    return (
        shutil.which("gcloud.cmd")
        or shutil.which("gcloud")
        or r"C:\Users\Andy\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"
    )


def start_gcloud_login_flow(account: str = "andy@originmfg.com") -> str | None:
    """
    Starts `gcloud auth login` in the background (listening on localhost:8085)
    and captures the https://accounts.google.com/o/oauth2/auth?... URL so the
    web UI can render a direct clickable link for the user.
    """
    global _ACTIVE_LOGIN_PROC, _ACTIVE_LOGIN_URL

    if _ACTIVE_LOGIN_PROC is not None and _ACTIVE_LOGIN_PROC.poll() is None and _ACTIVE_LOGIN_URL:
        return _ACTIVE_LOGIN_URL

    if _ACTIVE_LOGIN_PROC is not None and _ACTIVE_LOGIN_PROC.poll() is None:
        try:
            _ACTIVE_LOGIN_PROC.terminate()
        except Exception:
            pass

    gcloud_cmd = get_gcloud_cmd()
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["CLOUDSDK_CORE_DISABLE_PROMPTS"] = "1"

    proc = subprocess.Popen(
        [gcloud_cmd, "auth", "login", f"--account={account}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=env,
    )
    _ACTIVE_LOGIN_PROC = proc
    _ACTIVE_LOGIN_URL = None

    start_ts = time.time()
    while time.time() - start_ts < 7.0:
        line = proc.stdout.readline()
        if not line:
            break
        m = re.search(r"(https://accounts\.google\.com/\S+)", line)
        if m:
            _ACTIVE_LOGIN_URL = m.group(1).strip()
            break

    def _drain_output(p: subprocess.Popen):
        try:
            for _ in p.stdout:
                pass
        except Exception:
            pass

    threading.Thread(target=_drain_output, args=(proc,), daemon=True).start()
    return _ACTIVE_LOGIN_URL


def is_local_gcloud_authenticated() -> bool:
    """Checks whether `gcloud auth print-access-token` currently succeeds."""
    global _ACTIVE_LOGIN_PROC, _ACTIVE_LOGIN_URL
    gcloud_cmd = get_gcloud_cmd()
    proc = subprocess.run(
        [gcloud_cmd, "auth", "print-access-token"],
        capture_output=True,
        text=True,
        check=False,
        timeout=6,
    )
    if proc.returncode == 0 and proc.stdout.strip():
        _ACTIVE_LOGIN_PROC = None
        _ACTIVE_LOGIN_URL = None
        return True
    return False


def get_gcp_access_token() -> str:
    """
    Acquires a Google Cloud OAuth2 access token for read-only BigQuery queries:
    1. Explicit GCP_ACCESS_TOKEN environment variable (if set).
    2. GCP Metadata Server when running on Cloud Run (K_SERVICE is set) — instant & never expires.
    3. Local workstation gcloud CLI (fails fast in <1s if session expired so UI can prompt cleanly).
    """
    env_token = os.environ.get("GCP_ACCESS_TOKEN", "").strip()
    if env_token:
        return env_token

    # Only probe the GCP Metadata Server when running in Cloud Run
    if os.environ.get("K_SERVICE"):
        try:
            meta_req = urllib.request.Request(
                "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
                headers={"Metadata-Flavor": "Google"},
                method="GET",
            )
            with urllib.request.urlopen(meta_req, timeout=2.0) as resp:
                meta_payload = json.loads(resp.read().decode("utf-8"))
                if meta_payload.get("access_token"):
                    return meta_payload["access_token"].strip()
        except Exception as e:
            raise RuntimeError(f"Cloud Run Service Account token error: {e}") from e

    # Local workstation gcloud CLI check (fast, non-blocking)
    gcloud_cmd = get_gcloud_cmd()
    try:
        token_proc = subprocess.run(
            [gcloud_cmd, "auth", "print-access-token"],
            capture_output=True,
            text=True,
            check=False,
            timeout=20,
        )
    except subprocess.TimeoutExpired:
        raise GCloudAuthExpiredError(
            "Your local Google Cloud (gcloud) authentication check timed out. "
            "Your session likely expired overnight. Click 'Sign In with Google' above to refresh credentials."
        )

    if token_proc.returncode != 0:
        err_detail = (token_proc.stderr or token_proc.stdout or "").strip()
        raise GCloudAuthExpiredError(
            "Your local Google Cloud (gcloud) login session has expired. "
            "Click 'Sign In to Google Cloud' to open the Google login window, then click Sync BigQuery again.\n\n"
            f"Details: {err_detail}"
        )
    return token_proc.stdout.strip()


def fetch_bigquery_live_data(config: dict) -> dict:
    """
    Strictly READ-ONLY query against origin-enterprise-prd.origin_operations
    joining sku_facts and finished_goods_inventory_health.
    """
    token = get_gcp_access_token()

    # Collect all tracked SKUs and style numbers
    tracked_skus = set()
    tracked_styles = set()
    for tab in config.get("tabs", []):
        for item in tab.get("skus", []):
            sku = item["sku"]
            tracked_skus.add(sku)
            tracked_styles.add(sku.split("-")[0])

    sql = """
    SELECT
      COALESCE(fg.sku, sf.sku) AS sku,
      COALESCE(fg.style_number, sf.style_number) AS style_number,
      COALESCE(fg.style_name, sf.style_name) AS style_name,
      COALESCE(fg.color_name, sf.color_name) AS color_name,
      COALESCE(fg.size, sf.size) AS size,
      COALESCE(fg.business_category, sf.business_category) AS business_category,
      sf.silhouette AS silhouette,
      CAST(sf.on_website AS STRING) AS on_website,
      COALESCE(fg.unallocated, 0) AS unallocated,
      COALESCE(fg.available, sf.total_available, 0) AS available_raw,
      COALESCE(sf.total_backorder, 0) AS total_backorder,
      COALESCE(sf.daily_velocity_90d, 0) AS daily_velocity_90d,
      COALESCE(sf.daily_velocity_30d, 0) AS daily_velocity_30d,
      COALESCE(sf.units_sold_90d, 0) AS units_sold_90d,
      COALESCE(sf.units_sold_30d, 0) AS units_sold_30d,
      COALESCE(fg.wip_quantity, 0) AS wip_quantity,
      COALESCE(sf.product_margins_total_cost, 0) AS unit_cost,
      COALESCE(sf.msrp, fg.price, 0) AS msrp,
      COALESCE(sf.current_month_demand, 0) AS current_month_demand,
      COALESCE(sf.next_month_demand, 0) AS next_month_demand,
      COALESCE(sf.two_months_ahead_demand, 0) AS two_months_ahead_demand
    FROM `origin-enterprise-prd.origin_operations.finished_goods_inventory_health` fg
    FULL OUTER JOIN `origin-enterprise-prd.origin_operations.sku_facts` sf
      ON fg.sku = sf.sku
    WHERE
      (
        COALESCE(fg.business_category, sf.business_category) IN ('BJJ GI', 'COMPRESSION')
        OR COALESCE(fg.style_number, sf.style_number) IN ('1000529', '1000530', '9000014', '9000057', '9000077')
      )
      AND NOT REGEXP_CONTAINS(UPPER(COALESCE(fg.sku, sf.sku)), r'-(C|X)$')
    """

    bq_job_project = os.environ.get("BQ_JOB_PROJECT", "origin-enterprise-prd").strip() or "origin-enterprise-prd"
    req_body = json.dumps({"query": sql, "useLegacySql": False, "maxResults": 30000}).encode("utf-8")
    req = urllib.request.Request(
        f"https://bigquery.googleapis.com/bigquery/v2/projects/{bq_job_project}/queries",
        data=req_body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        payload = json.loads(resp.read().decode("utf-8"))

    fields = [f["name"] for f in payload.get("schema", {}).get("fields", [])]
    skus_map = {}
    for row in payload.get("rows", []):
        vals = [cell.get("v") for cell in row.get("f", [])]
        rec = dict(zip(fields, vals))
        sku = rec.get("sku")
        if not sku:
            continue
        sku_upper = sku.upper()
        if sku_upper.endswith("-C") or sku_upper.endswith("-X"):
            continue
        on_web_str = str(rec.get("on_website") or "").strip().lower()
        skus_map[sku] = {
            "sku": sku,
            "style_number": rec.get("style_number") or sku.split("-")[0],
            "style_name": rec.get("style_name") or "",
            "color_name": rec.get("color_name") or "",
            "size": rec.get("size") or "",
            "business_category": rec.get("business_category") or "",
            "silhouette": rec.get("silhouette") or "",
            "on_website": on_web_str in ("true", "1"),
            "unallocated": float(rec.get("unallocated") or 0.0),
            "available_raw": float(rec.get("available_raw") or 0.0),
            "total_backorder": float(rec.get("total_backorder") or 0.0),
            "daily_velocity_90d": float(rec.get("daily_velocity_90d") or 0.0),
            "daily_velocity_30d": float(rec.get("daily_velocity_30d") or 0.0),
            "units_sold_90d": float(rec.get("units_sold_90d") or 0.0),
            "units_sold_30d": float(rec.get("units_sold_30d") or 0.0),
            "wip_quantity": float(rec.get("wip_quantity") or 0.0),
            "unit_cost": float(rec.get("unit_cost") or 0.0),
            "msrp": float(rec.get("msrp") or 0.0),
            "current_month_demand": float(rec.get("current_month_demand") or 0.0),
            "next_month_demand": float(rec.get("next_month_demand") or 0.0),
            "two_months_ahead_demand": float(rec.get("two_months_ahead_demand") or 0.0),
        }

    cache_obj = {
        "synced_at": datetime.now(timezone.utc).isoformat(),
        "sku_count": len(skus_map),
        "skus": skus_map,
    }
    BQ_CACHE_PATH.write_text(json.dumps(cache_obj, indent=2), encoding="utf-8")
    return cache_obj


if __name__ == "__main__":
    # Verify math parity against the spreadsheet snapshot first
    cfg = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    for tab in cfg["tabs"]:
        mismatches = []
        calc_po_sum = 0
        sheet_po_sum = 0
        for item in tab["skus"]:
            snap = item["sheet_snapshot"]
            res = compute_row_math(
                sku=item["sku"],
                velo_90d=snap["velo_90d"],
                velo_30d=snap["velo_30d"],
                available=snap["available"],
                backorder=snap["backorder"],
                on_order=snap["on_order"],
                on_site=snap["on_site"],
                phase_out=item["phase_out"],
                pre_launch=item["pre_launch"],
                doi_target=tab["doi_target"],
                lead_time=tab["lead_time"],
                batch_rule=tab["batch_rule"],
                enforce_on_site_guardrail=False,
            )
            calc_po_sum += res["po_amt"]
            sheet_po_pos = max(0, excel_round(snap["po_amt"], 0))
            sheet_po_sum += sheet_po_pos
            if res["po_amt"] != sheet_po_pos:
                mismatches.append((item["sku"], snap["reqd"], res["reqd"], snap["po_amt"], res["po_amt"]))
        print(f"{tab['id']}: Engine PO Sum = {calc_po_sum}, Sheet Positive PO Sum (rounded) = {sheet_po_sum}, Mismatches = {len(mismatches)}")
        for m in mismatches[:5]:
            print("  Mismatch:", m)
