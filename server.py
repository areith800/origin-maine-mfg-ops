import csv
import io
import json
import mimetypes
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import po_engine

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
DEFAULT_EXPORTS_DIR = (
    po_engine.DATA_DIR / "exports"
    if po_engine.DATA_DIR != po_engine.BUNDLED_DATA_DIR
    else BASE_DIR / "exports"
)
EXPORTS_DIR = Path(os.environ.get("PO_EXPORT_DIR", str(DEFAULT_EXPORTS_DIR))).resolve()
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)

SHIPHERO_HEADERS = [
    "PO Number",
    "Vendor",
    "Ship Date",
    "PO Date",
    "Status",
    "Shipping Carrier",
    "Shipping Method",
    "Shipping Price",
    "Discount",
    "Tax",
    "Tracking Number",
    "Packer Note",
    "Payment Method",
    "Payment Due By",
    "PO Note",
    "Packer Note",
    "Sku",
    "Vendor Sku",
    "Quantity",
    "Sell Ahead",
    "Price",
]


def load_config() -> dict:
    cfg = json.loads(po_engine.CONFIG_PATH.read_text(encoding="utf-8"))
    ac = cfg.setdefault("access_control", {})
    ac.setdefault("enforce_auth", True)
    ac.setdefault("default_authenticated_role", "viewer")
    ac.setdefault("local_dev_email", "andy@originmfg.com")
    ac.setdefault("po_generators", ["andy@originmfg.com"])
    ac.setdefault("admins", ["andy@originmfg.com"])
    cfg.setdefault("po_audit_log", [])
    return cfg


def resolve_user_context(headers, cfg: dict) -> dict:
    ac = cfg.get("access_control", {})
    admins = {str(e).strip().lower() for e in ac.get("admins", []) if e}
    po_gens = {str(e).strip().lower() for e in ac.get("po_generators", []) if e} | admins
    is_cloud_run = bool(os.environ.get("K_SERVICE"))

    # 1. Check Google Cloud Identity-Aware Proxy (IAP) or reverse-proxy identity headers
    iap_email = headers.get("X-Goog-Authenticated-User-Email", "").strip()
    if iap_email.startswith("accounts.google.com:"):
        iap_email = iap_email[len("accounts.google.com:"):].strip()

    proxy_email = (
        iap_email
        or headers.get("X-Forwarded-Email", "").strip()
        or headers.get("X-User-Email", "").strip()
    )

    if proxy_email:
        email = proxy_email.lower()
        auth_source = "google_iap"
    elif not is_cloud_run:
        email = str(ac.get("local_dev_email") or "andy@originmfg.com").strip().lower()
        auth_source = "local_dev"
    else:
        email = str(os.environ.get("DEFAULT_CLOUD_USER_EMAIL") or "").strip().lower()
        auth_source = "cloud_unauthenticated"

    if email in admins:
        actual_role = "admin"
    elif email in po_gens:
        actual_role = "po_generator"
    else:
        actual_role = ac.get("default_authenticated_role", "viewer") if email else "viewer"

    sim_role = headers.get("X-Simulated-Role", "").strip().lower()
    is_simulating_viewer = sim_role == "viewer"
    effective_role = "viewer" if is_simulating_viewer else actual_role

    return {
        "email": email or "anonymous",
        "auth_source": auth_source,
        "actual_role": actual_role,
        "effective_role": effective_role,
        "is_simulating_viewer": is_simulating_viewer,
        "can_generate_po": effective_role in ("admin", "po_generator"),
        "can_manage_access": actual_role == "admin",
        "is_cloud_run": is_cloud_run,
    }


def save_config(cfg: dict) -> None:
    po_engine.CONFIG_PATH.write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def load_bq_cache(cfg: dict, auto_refresh: bool = False) -> dict:
    if not po_engine.BQ_CACHE_PATH.exists():
        return po_engine.fetch_bigquery_live_data(cfg)
    cache_obj = json.loads(po_engine.BQ_CACHE_PATH.read_text(encoding="utf-8"))
    if auto_refresh:
        synced_at_str = cache_obj.get("synced_at")
        is_stale = True
        if synced_at_str:
            try:
                dt = datetime.fromisoformat(synced_at_str.replace("Z", "+00:00"))
                age_sec = (datetime.now(timezone.utc) - dt).total_seconds()
                is_stale = age_sec > 900  # 15 minutes TTL
            except Exception:
                is_stale = True
        if is_stale:
            try:
                if os.environ.get("K_SERVICE") or po_engine.is_local_gcloud_authenticated():
                    cache_obj = po_engine.fetch_bigquery_live_data(cfg)
            except Exception:
                pass
    return cache_obj


def infer_target_tab_id(style_num: str, style_name: str, silhouette: str, style_to_tab: dict) -> str:
    if style_num in style_to_tab:
        return style_to_tab[style_num]
    sn = (style_name or "").upper()
    sil = (silhouette or "").upper()
    if "YOUTH" in sn or style_num.startswith("2000"):
        return "YOUTH_PO_CALC"
    if "PANT" in sn or sil == "PANTS":
        return "PANT_PO_CALC"
    if "SHORT" in sn or sil == "SHORTS":
        return "NOGI_PO_CALC"
    if "BELT" in sn or "SACK" in sn or style_num.startswith("9000"):
        return "BJJACC_PO_CALC"
    return "JACKET_PO_CALC"


def find_candidate_sku_groups(cfg: dict, bq_skus: dict) -> tuple[list[dict], list[dict]]:
    tracked_skus = set()
    style_to_tab = {}
    style_to_type = {}
    for tab in cfg.get("tabs", []):
        for item in tab.get("skus", []):
            sku = item["sku"]
            tracked_skus.add(sku)
            st_num = sku.split("-")[0]
            style_to_tab[st_num] = tab["id"]
            p_style = str(item.get("planning_style") or "").strip().upper()
            if p_style and st_num not in style_to_type:
                style_to_type[st_num] = p_style

    excluded_styles = set(cfg.get("excluded_collab_styles", []))
    archived_groups = set(cfg.get("archived_sku_groups", []))
    archived_skus = set(cfg.get("archived_skus", []))

    groups_map = {}
    for sku, rec in bq_skus.items():
        if sku in tracked_skus:
            continue
        sku_upper = sku.upper()
        if sku_upper.endswith("-C") or sku_upper.endswith("-X"):
            continue

        parts = sku.split("-")
        style_num = rec.get("style_number") or parts[0]
        color_code = parts[1] if len(parts) >= 2 else (rec.get("color_name") or "DEFAULT")
        style_name = rec.get("style_name") or ""
        group_key = f"{style_num}|{color_code}|{style_name}"

        is_archived = (
            style_num in excluded_styles
            or group_key in archived_groups
            or f"{style_num}|*" in archived_groups
            or sku in archived_skus
        )
        if style_num in excluded_styles:
            archive_reason = "Excluded Collab / Legacy Style"
        elif group_key in archived_groups or f"{style_num}|*" in archived_groups:
            archive_reason = "Archived Group"
        elif sku in archived_skus:
            archive_reason = "Archived Size(s)"
        else:
            archive_reason = ""

        cat = rec.get("business_category") or ""
        is_tracked_style = style_num in style_to_tab
        if is_tracked_style:
            bucket = "tracked_style_expansion"
        elif cat == "BJJ GI" or style_num.startswith("9000"):
            bucket = "new_bjj_style"
        elif cat == "COMPRESSION":
            bucket = "compression"
        else:
            continue

        map_key = f"{group_key}|{'ARCH' if is_archived else 'ACT'}"
        if map_key not in groups_map:
            suggested_tab_id = infer_target_tab_id(
                style_num, style_name, rec.get("silhouette") or "", style_to_tab
            )
            if style_num in style_to_type:
                suggested_type = style_to_type[style_num]
            elif suggested_tab_id == "JACKET_PO_CALC":
                suggested_type = "RIFT" if "RIFT" in style_name.upper() else "CLASSIC"
            else:
                suggested_type = ""

            groups_map[map_key] = {
                "group_key": group_key,
                "style_number": style_num,
                "color_code": color_code,
                "style_name": style_name,
                "color_name": rec.get("color_name") or "",
                "business_category": cat,
                "silhouette": rec.get("silhouette") or "",
                "bucket": bucket,
                "is_tracked_style": is_tracked_style,
                "is_archived": is_archived,
                "archive_reason": archive_reason,
                "suggested_tab_id": suggested_tab_id,
                "suggested_type": suggested_type,
                "skus": [],
            }

        size_val = rec.get("size") or (parts[2] if len(parts) >= 3 else "")
        groups_map[map_key]["skus"].append({
            "sku": sku,
            "size": size_val,
            "on_website": bool(rec.get("on_website")),
            "unallocated": float(rec.get("unallocated") or 0.0),
            "total_backorder": float(rec.get("total_backorder") or 0.0),
            "daily_velocity_90d": float(rec.get("daily_velocity_90d") or 0.0),
            "daily_velocity_30d": float(rec.get("daily_velocity_30d") or 0.0),
            "units_sold_90d": float(rec.get("units_sold_90d") or 0.0),
            "wip_quantity": float(rec.get("wip_quantity") or 0.0),
            "demand_plan": float(rec.get("current_month_demand") or 0.0) + float(rec.get("next_month_demand") or 0.0),
            "unit_cost": float(rec.get("unit_cost") or 0.0),
            "msrp": float(rec.get("msrp") or 0.0),
        })

    active_result = []
    archived_result = []
    for g in groups_map.values():
        g["skus"].sort(key=lambda x: x["sku"])
        sku_list = g["skus"]
        g["sku_count"] = len(sku_list)
        g["on_web_count"] = sum(1 for x in sku_list if x["on_website"])
        g["total_avail"] = sum(x["unallocated"] for x in sku_list)
        g["total_backorder"] = sum(x["total_backorder"] for x in sku_list)
        g["total_sold_90d"] = sum(x["units_sold_90d"] for x in sku_list)
        g["total_wip"] = sum(x["wip_quantity"] for x in sku_list)
        g["total_demand_plan"] = sum(x["demand_plan"] for x in sku_list)

        warnings = []
        if any("-TBD-" in x["sku"].upper() or x["sku"].upper().endswith("-TBD") for x in sku_list):
            warnings.append("Contains placeholder 'TBD' color/size code")
        if (
            g["business_category"] == "BJJ GI"
            and not g["style_number"].startswith("9000")
            and any(x["size"].upper() in ("ONE SIZE", "OS", "") for x in sku_list)
        ):
            warnings.append("Contains placeholder 'One Size' on sized apparel")
        if not g["style_name"] or not g["color_name"]:
            warnings.append("Missing Style Name or Color Name in sku_facts")

        g["validation_warnings"] = warnings
        g["is_valid"] = len(warnings) == 0
        if g["is_archived"]:
            archived_result.append(g)
        else:
            active_result.append(g)

    sort_fn = lambda g: (
        0 if g["bucket"] == "tracked_style_expansion" else (1 if g["bucket"] == "new_bjj_style" else 2),
        -(g["total_backorder"] * 100 + g["total_sold_90d"] * 10 + g["total_demand_plan"] * 5 + g["on_web_count"]),
        -int(g["style_number"]) if g["style_number"].isdigit() else 0,
        g["group_key"],
    )
    active_result.sort(key=sort_fn)
    archived_result.sort(key=sort_fn)
    return active_result, archived_result


def compute_pending_po_state(cfg: dict, bq_skus: dict) -> tuple[dict[str, int], list[dict]]:
    """
    Computes in-flight (Pending PO) units per SKU from exports within the last 48 hours
    that have not yet been absorbed by an increase in BigQuery's wip_quantity (On Order).
    """
    now_utc = datetime.now(timezone.utc)
    ttl_seconds = 48 * 3600  # 48 hours
    audit_log = cfg.get("po_audit_log", [])

    # Track earliest baseline WIP, earliest baseline Available, and cumulative exported qty per SKU
    sku_earliest_baseline_wip: dict[str, float] = {}
    sku_earliest_baseline_avail: dict[str, float] = {}
    sku_total_exported: dict[str, int] = {}

    # Process chronological (oldest to newest within 48h window)
    recent_active_entries = []
    for entry in reversed(audit_log):
        entry.setdefault("export_id", f"exp_{entry.get('timestamp', '')}_{entry.get('tab_id', '')}")
        entry.setdefault("status", "active")
        ts_str = entry.get("timestamp")
        age_sec = 999999.0
        if ts_str:
            try:
                dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                age_sec = max(0.0, (now_utc - dt).total_seconds())
            except Exception:
                pass
        entry["age_minutes"] = round(age_sec / 60.0, 1)
        entry["within_window"] = age_sec <= ttl_seconds

        if entry["status"] == "active" and entry["within_window"]:
            sku_items = entry.get("sku_items") or {}
            for s_code, info in sku_items.items():
                qty = int(info.get("po_qty") or 0)
                base_wip = float(info.get("bq_wip_baseline") or 0.0)
                base_avail = float(
                    info.get("bq_avail_baseline")
                    if info.get("bq_avail_baseline") is not None
                    else (bq_skus.get(s_code, {}).get("unallocated") or 0.0)
                )
                if qty <= 0:
                    continue
                if s_code not in sku_earliest_baseline_wip:
                    sku_earliest_baseline_wip[s_code] = base_wip
                    sku_earliest_baseline_avail[s_code] = base_avail
                sku_total_exported[s_code] = sku_total_exported.get(s_code, 0) + qty
            recent_active_entries.append(entry)

    pending_by_sku: dict[str, int] = {}
    for s_code, total_exp in sku_total_exported.items():
        cur_wip = float(bq_skus.get(s_code, {}).get("wip_quantity") or 0.0)
        cur_avail = float(bq_skus.get(s_code, {}).get("unallocated") or 0.0)
        base_wip = sku_earliest_baseline_wip.get(s_code, cur_wip)
        base_avail = sku_earliest_baseline_avail.get(s_code, cur_avail)

        # Account for older open POs closing into Available inventory while the new PO enters WIP:
        # When an older open PO of X units closes into Available, WIP drops by X and Available rises by X
        # (net change to Available + WIP is 0), whereas the newly uploaded PO increases (Available + WIP) by +PO_Qty.
        wip_delta = cur_wip - base_wip
        total_supply_delta = (cur_avail + cur_wip) - (base_avail + base_wip)
        absorbed_increase = max(0.0, wip_delta, total_supply_delta)

        still_pending = max(0, int(round(total_exp - absorbed_increase)))
        if still_pending > 0:
            pending_by_sku[s_code] = still_pending

    # Annotate each audit log entry with how many of its units are still pending in BigQuery
    recent_banners = []
    for entry in audit_log:
        sku_items = entry.get("sku_items") or {}
        if not sku_items:
            entry["pending_units"] = 0
            entry["pending_skus"] = 0
            continue
        if entry.get("status") != "active" or not entry.get("within_window"):
            entry["pending_units"] = 0
            entry["pending_skus"] = 0
            continue
        p_units = 0
        p_skus = 0
        for s_code, info in sku_items.items():
            rem = pending_by_sku.get(s_code, 0)
            if rem > 0:
                contrib = min(int(info.get("po_qty") or 0), rem)
                if contrib > 0:
                    p_units += contrib
                    p_skus += 1
        entry["pending_units"] = p_units
        entry["pending_skus"] = p_skus
        if p_units > 0:
            recent_banners.append(entry)

    return pending_by_sku, recent_banners


def build_state_payload(cfg: dict, bq_cache: dict, user_ctx: dict | None = None) -> dict:
    bq_skus = bq_cache.get("skus", {})
    relevant_bq = {}
    for tab in cfg.get("tabs", []):
        for item in tab.get("skus", []):
            sku = item["sku"]
            if sku in bq_skus:
                relevant_bq[sku] = bq_skus[sku]
            else:
                snap = item.get("sheet_snapshot", {})
                relevant_bq[sku] = {
                    "sku": sku,
                    "style_number": sku.split("-")[0],
                    "style_name": snap.get("style_name", ""),
                    "color_name": snap.get("color", ""),
                    "size": "",
                    "business_category": "BJJ GI",
                    "silhouette": "",
                    "on_website": bool(snap.get("on_site", True)),
                    "unallocated": float(snap.get("available", 0.0)),
                    "available_raw": float(snap.get("available", 0.0)),
                    "total_backorder": float(snap.get("backorder", 0.0)),
                    "daily_velocity_90d": float(snap.get("velo_90d", 0.0)),
                    "daily_velocity_30d": float(snap.get("velo_30d", 0.0)),
                    "units_sold_90d": 0.0,
                    "units_sold_30d": 0.0,
                    "wip_quantity": float(snap.get("on_order", 0.0)),
                    "unit_cost": 0.0,
                    "msrp": 0.0,
                    "current_month_demand": 0.0,
                    "next_month_demand": 0.0,
                }

    candidate_groups, archived_groups = find_candidate_sku_groups(cfg, bq_skus)
    pending_by_sku, recent_po_banners = compute_pending_po_state(cfg, relevant_bq)
    return {
        "config": cfg,
        "current_user": user_ctx or {},
        "synced_at": bq_cache.get("synced_at"),
        "total_bq_skus_cached": bq_cache.get("sku_count", len(bq_skus)),
        "bq_skus": relevant_bq,
        "pending_po_by_sku": pending_by_sku,
        "recent_po_exports": recent_po_banners,
        "candidate_sku_groups": candidate_groups,
        "archived_sku_groups": archived_groups,
    }


def generate_shiphero_csv_text(
    *,
    vendor: str,
    ship_date: str,
    po_date: str,
    vendor_sku_mode: str,
    po_note: str = "",
    lines: list[dict],
) -> tuple[str, int, int]:
    """
    Generates ShipHero 21-column CSV string.
    Strictly enforces SKU deduplication and whole positive integer quantities.
    Returns (csv_text, unique_sku_count, total_units).
    """
    seen_skus = set()
    clean_rows = []
    total_units = 0

    # Sort ascending by SKU to match QUERY(... ORDER BY A ASC)
    sorted_lines = sorted(lines, key=lambda r: r.get("sku", ""))
    for item in sorted_lines:
        sku = str(item.get("sku") or "").strip()
        qty = int(round(float(item.get("po_amt") or 0)))
        if not sku or qty <= 0:
            continue
        if sku in seen_skus:
            # Strict deduplication guardrail for ShipHero
            continue
        seen_skus.add(sku)
        total_units += qty

        style_name = str(item.get("style_name") or "").strip()
        if vendor_sku_mode == "style_name":
            vendor_sku = style_name
        elif vendor_sku_mode == "sku":
            vendor_sku = sku
        else:
            vendor_sku = ""

        row = [
            "",          # 1. PO Number
            vendor,      # 2. Vendor
            ship_date,   # 3. Ship Date
            po_date,     # 4. PO Date
            "",          # 5. Status
            "",          # 6. Shipping Carrier
            "",          # 7. Shipping Method
            "",          # 8. Shipping Price
            "",          # 9. Discount
            "",          # 10. Tax
            "",          # 11. Tracking Number
            "",          # 12. Packer Note
            "",          # 13. Payment Method
            "",          # 14. Payment Due By
            po_note,     # 15. PO Note
            "",          # 16. Packer Note
            sku,         # 17. Sku
            vendor_sku,  # 18. Vendor Sku
            str(qty),    # 19. Quantity
            "",          # 20. Sell Ahead
            "",          # 21. Price
        ]
        clean_rows.append(row)

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\r\n")
    writer.writerow(SHIPHERO_HEADERS)
    writer.writerows(clean_rows)
    return buf.getvalue(), len(clean_rows), total_units


class POGeneratorHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, data: dict, status: int = 200):
        raw = json.dumps(data).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/healthz":
            self._send_json({"status": "ok"})
            return

        if path == "/api/gcloud-auth-status":
            self._send_json({"authenticated": po_engine.is_local_gcloud_authenticated()})
            return

        if path == "/api/state":
            try:
                cfg = load_config()
                user_ctx = resolve_user_context(self.headers, cfg)
                bq_cache = load_bq_cache(cfg, auto_refresh=True)
                self._send_json(build_state_payload(cfg, bq_cache, user_ctx))
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return

        if path == "/" or path == "/index.html":
            file_path = STATIC_DIR / "index.html"
        elif path.startswith("/static/"):
            rel = path[len("/static/"):]
            file_path = (STATIC_DIR / rel).resolve()
            if not str(file_path).startswith(str(STATIC_DIR.resolve())):
                self.send_error(403)
                return
        else:
            self.send_error(404)
            return

        if not file_path.exists() or not file_path.is_file():
            self.send_error(404)
            return

        mime, _ = mimetypes.guess_type(str(file_path))
        content = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        try:
            body = self._read_json_body()
        except Exception as e:
            self._send_json({"error": f"Invalid JSON body: {e}"}, status=400)
            return

        if path == "/api/sync-bigquery":
            try:
                cfg = load_config()
                user_ctx = resolve_user_context(self.headers, cfg)
                bq_cache = po_engine.fetch_bigquery_live_data(cfg)
                self._send_json(build_state_payload(cfg, bq_cache, user_ctx))
            except po_engine.GCloudAuthExpiredError as e:
                cfg = load_config()
                user_ctx = resolve_user_context(self.headers, cfg)
                acct = user_ctx["email"] if "@" in user_ctx["email"] else "andy@originmfg.com"
                auth_url = po_engine.start_gcloud_login_flow(acct)
                self._send_json(
                    {
                        "error": str(e),
                        "auth_expired": True,
                        "auth_url": auth_url,
                    },
                    status=200,
                )
            except Exception as e:
                self._send_json({"error": f"BigQuery sync failed: {e}"}, status=500)
            return

        if path == "/api/gcloud-login":
            try:
                cfg = load_config()
                user_ctx = resolve_user_context(self.headers, cfg)
                acct = user_ctx["email"] if "@" in user_ctx["email"] else "andy@originmfg.com"
                auth_url = po_engine.start_gcloud_login_flow(acct)
                self._send_json({"status": "launched", "auth_url": auth_url})
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return

        if path == "/api/save-tab-settings":
            try:
                cfg = load_config()
                user_ctx = resolve_user_context(self.headers, cfg)
                if not user_ctx["can_generate_po"]:
                    self._send_json(
                        {
                            "error": f"Read-Only Access ({user_ctx['email']}): Only authorized PO Generators can modify calculator targets, flags, or overrides."
                        },
                        status=403,
                    )
                    return

                tab_id = body.get("tab_id")
                target_tab = next((t for t in cfg.get("tabs", []) if t["id"] == tab_id), None)
                if not target_tab:
                    self._send_json({"error": f"Tab {tab_id} not found"}, status=404)
                    return

                if "doi_target" in body:
                    target_tab["doi_target"] = float(body["doi_target"])
                if "lead_time" in body:
                    target_tab["lead_time"] = float(body["lead_time"])
                if "vendor" in body:
                    target_tab["vendor"] = str(body["vendor"]).strip()
                if "vendor_sku_mode" in body:
                    target_tab["vendor_sku_mode"] = str(body["vendor_sku_mode"]).strip()

                if "sku_updates" in body and isinstance(body["sku_updates"], dict):
                    sku_map = {s["sku"]: s for s in target_tab.get("skus", [])}
                    for sku_code, upd in body["sku_updates"].items():
                        if sku_code in sku_map:
                            item = sku_map[sku_code]
                            if "phase_out" in upd:
                                item["phase_out"] = bool(upd["phase_out"])
                            if "ignored" in upd:
                                item["ignored"] = bool(upd["ignored"])
                            if "pre_launch" in upd:
                                item["pre_launch"] = bool(upd["pre_launch"])
                            if "planning_style" in upd:
                                item["planning_style"] = str(upd["planning_style"] or "").strip().upper()
                            if "manual_po_override" in upd:
                                val = upd["manual_po_override"]
                                item["manual_po_override"] = int(val) if val not in (None, "") else None

                if "add_sku" in body and body["add_sku"]:
                    new_sku = str(body["add_sku"]).strip()
                    existing = {s["sku"] for s in target_tab.get("skus", [])}
                    if new_sku and new_sku not in existing:
                        target_tab["skus"].append({
                            "sku": new_sku,
                            "planning_style": str(body.get("planning_style") or "").strip().upper(),
                            "phase_out": bool(body.get("phase_out", False)),
                            "pre_launch": bool(body.get("pre_launch", False)),
                            "manual_po_override": None,
                            "sheet_snapshot": {}
                        })

                if "clear_overrides" in body and body["clear_overrides"]:
                    for item in target_tab.get("skus", []):
                        item["manual_po_override"] = None

                if "clear_ignored" in body and body["clear_ignored"]:
                    for item in target_tab.get("skus", []):
                        item["ignored"] = False

                save_config(cfg)
                bq_cache = load_bq_cache(cfg)
                self._send_json(build_state_payload(cfg, bq_cache, user_ctx))
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return

        if path == "/api/manage-candidate-skus":
            try:
                cfg = load_config()
                user_ctx = resolve_user_context(self.headers, cfg)
                if not user_ctx["can_generate_po"]:
                    self._send_json(
                        {
                            "error": f"Read-Only Access ({user_ctx['email']}): Only authorized PO Generators can validate, transfer, or archive SKUs."
                        },
                        status=403,
                    )
                    return

                action = body.get("action")
                if action == "approve":
                    tab_id = body.get("tab_id")
                    target_tab = next((t for t in cfg.get("tabs", []) if t["id"] == tab_id), None)
                    if not target_tab:
                        self._send_json({"error": f"Tab {tab_id} not found"}, status=404)
                        return
                    all_tracked = {
                        s["sku"]
                        for t in cfg.get("tabs", [])
                        for s in t.get("skus", [])
                    }
                    skus_to_add = body.get("skus", [])
                    planning_style = str(body.get("planning_style") or "").strip().upper()
                    added_set = set()
                    for raw_sku in skus_to_add:
                        s_code = str(raw_sku or "").strip()
                        if not s_code or s_code in all_tracked:
                            continue
                        if s_code.upper().endswith("-C") or s_code.upper().endswith("-X"):
                            continue
                        target_tab["skus"].append({
                            "sku": s_code,
                            "planning_style": planning_style,
                            "phase_out": bool(body.get("phase_out", False)),
                            "ignored": False,
                            "pre_launch": True,
                            "manual_po_override": None,
                            "sheet_snapshot": {},
                        })
                        all_tracked.add(s_code)
                        added_set.add(s_code)
                    if added_set and "archived_skus" in cfg:
                        cfg["archived_skus"] = [s for s in cfg.get("archived_skus", []) if s not in added_set]
                    group_key = body.get("group_key")
                    if group_key and bool(body.get("clear_archived_group", False)):
                        archived = [g for g in cfg.get("archived_sku_groups", []) if g != group_key]
                        cfg["archived_sku_groups"] = archived
                elif action == "archive":
                    group_key = body.get("group_key")
                    skus_to_archive = body.get("skus")
                    if isinstance(skus_to_archive, list) and len(skus_to_archive) > 0:
                        arch_skus = list(cfg.get("archived_skus", []))
                        for raw_s in skus_to_archive:
                            s_code = str(raw_s or "").strip()
                            if s_code and s_code not in arch_skus:
                                arch_skus.append(s_code)
                        cfg["archived_skus"] = arch_skus
                    else:
                        archived = list(cfg.get("archived_sku_groups", []))
                        if group_key and group_key not in archived:
                            archived.append(group_key)
                        cfg["archived_sku_groups"] = archived
                elif action == "unarchive_group":
                    group_key = body.get("group_key")
                    style_num = body.get("style_number")
                    skus_to_unarchive = set(body.get("skus") or [])
                    archived = [g for g in cfg.get("archived_sku_groups", []) if g != group_key]
                    cfg["archived_sku_groups"] = archived
                    if skus_to_unarchive and "archived_skus" in cfg:
                        cfg["archived_skus"] = [s for s in cfg.get("archived_skus", []) if s not in skus_to_unarchive]
                    if style_num and style_num in cfg.get("excluded_collab_styles", []):
                        cfg["excluded_collab_styles"] = [
                            s for s in cfg.get("excluded_collab_styles", []) if s != style_num
                        ]
                elif action == "unarchive_all":
                    cfg["archived_sku_groups"] = []

                save_config(cfg)
                bq_cache = load_bq_cache(cfg)
                self._send_json(build_state_payload(cfg, bq_cache, user_ctx))
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return

        if path == "/api/manage-access":
            try:
                cfg = load_config()
                user_ctx = resolve_user_context(self.headers, cfg)
                if not user_ctx["can_manage_access"]:
                    self._send_json(
                        {"error": "Admin privileges required to manage authorized PO Generators."},
                        status=403,
                    )
                    return

                ac = cfg.setdefault("access_control", {})
                po_gens = [str(e).strip().lower() for e in ac.get("po_generators", []) if e]
                admins = [str(e).strip().lower() for e in ac.get("admins", []) if e]

                action = body.get("action")
                target_email = str(body.get("email") or "").strip().lower()
                role = str(body.get("role") or "po_generator").strip().lower()

                if action == "add_user" and target_email and "@" in target_email:
                    if target_email not in po_gens:
                        po_gens.append(target_email)
                    if role == "admin" and target_email not in admins:
                        admins.append(target_email)
                    elif role != "admin" and target_email in admins and len(admins) > 1:
                        admins = [a for a in admins if a != target_email]
                elif action == "remove_user" and target_email:
                    if target_email in admins and len(admins) <= 1:
                        self._send_json(
                            {"error": "Cannot remove the last remaining Admin account."},
                            status=400,
                        )
                        return
                    po_gens = [e for e in po_gens if e != target_email]
                    admins = [e for e in admins if e != target_email]

                ac["po_generators"] = sorted(set(po_gens | set(admins) if isinstance(po_gens, set) else set(po_gens) | set(admins)))
                ac["admins"] = sorted(set(admins))
                save_config(cfg)
                bq_cache = load_bq_cache(cfg)
                self._send_json(build_state_payload(cfg, bq_cache, resolve_user_context(self.headers, cfg)))
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return

        if path == "/api/manage-po-audit":
            try:
                cfg = load_config()
                user_ctx = resolve_user_context(self.headers, cfg)
                if not user_ctx["can_generate_po"]:
                    self._send_json(
                        {"error": "Only authorized PO Generators can discard or restore PO exports."},
                        status=403,
                    )
                    return

                export_id = str(body.get("export_id") or "").strip()
                action = str(body.get("action") or "").strip().lower()
                for entry in cfg.get("po_audit_log", []):
                    eid = entry.get("export_id") or f"exp_{entry.get('timestamp', '')}_{entry.get('tab_id', '')}"
                    if eid == export_id:
                        if action == "discard":
                            entry["status"] = "discarded"
                            entry["discarded_by"] = user_ctx["email"]
                            entry["discarded_at"] = datetime.now(timezone.utc).isoformat()
                        elif action == "restore":
                            entry["status"] = "active"
                            entry["discarded_by"] = None
                            entry["discarded_at"] = None
                        break

                save_config(cfg)
                bq_cache = load_bq_cache(cfg)
                self._send_json(build_state_payload(cfg, bq_cache, user_ctx))
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return

        if path == "/api/export-shiphero-csv":
            try:
                cfg = load_config()
                user_ctx = resolve_user_context(self.headers, cfg)
                if not user_ctx["can_generate_po"]:
                    self._send_json(
                        {
                            "error": f"Read-Only Access ({user_ctx['email']}): You do not have permission to generate or export Purchase Orders."
                        },
                        status=403,
                    )
                    return

                tab_id = body.get("tab_id", "PO")
                vendor = body.get("vendor", "Origin")
                ship_date = body.get("ship_date") or datetime.now().strftime("%Y-%m-%d")
                po_date = body.get("po_date") or ship_date
                vendor_sku_mode = body.get("vendor_sku_mode", "style_name")
                po_note = body.get("po_note", "")
                lines = body.get("lines", [])

                # Persist active DOI Target & Lead Time used for this export so state refresh doesn't revert unsaved inputs
                target_tab = next((t for t in cfg.get("tabs", []) if t["id"] == tab_id), None)
                if target_tab:
                    if body.get("doi_target") is not None:
                        target_tab["doi_target"] = float(body["doi_target"])
                    if body.get("lead_time") is not None:
                        target_tab["lead_time"] = float(body["lead_time"])
                    if vendor:
                        target_tab["vendor"] = str(vendor).strip()
                    if vendor_sku_mode:
                        target_tab["vendor_sku_mode"] = str(vendor_sku_mode).strip()

                csv_text, line_count, total_units = generate_shiphero_csv_text(
                    vendor=vendor,
                    ship_date=ship_date,
                    po_date=po_date,
                    vendor_sku_mode=vendor_sku_mode,
                    po_note=po_note,
                    lines=lines,
                )

                safe_vendor = "".join(c if c.isalnum() else "_" for c in vendor).strip("_")
                filename = f"ShipHero_PO_{safe_vendor}_{tab_id}_{ship_date}.csv"
                out_path = EXPORTS_DIR / filename
                out_path.write_text(csv_text, encoding="utf-8")

                bq_cache = load_bq_cache(cfg)
                bq_skus = bq_cache.get("skus", {})
                sku_items = {}
                for item in lines:
                    s_code = str(item.get("sku") or "").strip()
                    qty = int(round(float(item.get("po_amt") or 0)))
                    if s_code and qty > 0 and s_code not in sku_items:
                        cur_wip = float(bq_skus.get(s_code, {}).get("wip_quantity") or 0.0)
                        cur_avail = float(bq_skus.get(s_code, {}).get("unallocated") or 0.0)
                        sku_items[s_code] = {
                            "po_qty": qty,
                            "bq_wip_baseline": cur_wip,
                            "bq_avail_baseline": cur_avail,
                        }

                now_iso = datetime.now(timezone.utc).isoformat()
                audit_entry = {
                    "export_id": f"exp_{int(datetime.now(timezone.utc).timestamp() * 1000)}_{tab_id}",
                    "timestamp": now_iso,
                    "user_email": user_ctx["email"],
                    "tab_id": tab_id,
                    "vendor": vendor,
                    "ship_date": ship_date,
                    "line_count": line_count,
                    "total_units": total_units,
                    "filename": filename,
                    "status": "active",
                    "sku_items": sku_items,
                }
                audit_log = list(cfg.get("po_audit_log", []))
                audit_log.insert(0, audit_entry)
                cfg["po_audit_log"] = audit_log[:100]
                save_config(cfg)

                state_payload = build_state_payload(cfg, bq_cache, user_ctx)
                self._send_json({
                    "filename": filename,
                    "saved_path": str(out_path),
                    "line_count": line_count,
                    "total_units": total_units,
                    "csv_text": csv_text,
                    "po_audit_log": cfg["po_audit_log"],
                    "state": state_payload,
                })
            except Exception as e:
                self._send_json({"error": str(e)}, status=500)
            return

        self.send_error(404)


def run_server(port: int | None = None):
    listen_port = port or int(os.environ.get("PORT", "8765"))
    listen_host = (
        "0.0.0.0"
        if (os.environ.get("K_SERVICE") or os.environ.get("PO_BIND_ALL"))
        else "127.0.0.1"
    )
    server = ThreadingHTTPServer((listen_host, listen_port), POGeneratorHandler)
    print(f"Origin BJJ PO Generator running at http://{listen_host}:{listen_port}")
    server.serve_forever()


if __name__ == "__main__":
    run_server()
