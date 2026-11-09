# Origin Manufacturing — PO Planning & Inventory Context

This living document captures the manufacturing rules, inventory valuation guardrails, vendor mappings, and shop-floor nuances used to generate Purchase Orders (POs) for ShipHero.

---

## 1. Three-Site Manufacturing Architecture

Origin operates three primary manufacturing sites, each with its own PO calculator workflow:

1. **Site 1: BJJ & Compression (Current Focus)**
   - Products: BJJ Gi Jackets, BJJ Gi Pants, Youth Gis, NoGi Shorts, BJJ Belts & Sling Sacks, Compression Rashguards/Spats/Shorts.
   - ShipHero Vendors:
     - `Gi Jackets` — Adult BJJ Gi Jackets (`JACKET_PO_CALC`)
     - `Gi Pants` — Adult BJJ Gi Pants (`PANT_PO_CALC`)
     - `Gi Youth` — Youth BJJ Gis (`YOUTH_PO_CALC`)
     - `BJJ Accessories` — BJJ Belts, Comp Belts, Sling Sacks (`BJJACC_PO_CALC`) and NoGi Shorts (`NOGI_PO_CALC`)
     - `Compression` — All `COMPRESSION` business category SKUs
   - *Historical Note:* `Lebanon Apparel Corporation` and `Wells Hosiery Mills Inc` previously manufactured some of these items (such as NoGi shorts) but no longer do.

2. **Site 2: Footwear & Leather Goods (Phase 2)**
   - Products: Boots, Shoes, Belts, Wallets, Mousepads, Leather Accessories.
   - ShipHero Vendors: `Footwear`, `Leather Goods`, etc.

3. **Site 3: Main Apparel (Phase 3)**
   - Products: Denim, Work/Chino/Mountain Pants, Flannels, Polos, Fleece, Tees, Outerwear.

---

## 2. BJJ Calculator Tabs, Batching Rules & Controls

Each calculator tab maintains two interactive tuning parameters—**`DOI Inv Target` (`Q5`)** and **`Lead Time` (`Q6`)**—which are adjusted so the total PO quantity (`New PO Qty`) aligns with shop-floor production capacity.

| Calculator Tab | ShipHero `Vendor` | Default `DOI Target` (`Q5`) | Default `Lead Time` (`Q6`) | Active SKU Batching Rule (`PO Amt` when `F = FALSE` and `M > 0`) |
| :--- | :--- | :--- | :--- | :--- |
| **`NOGI_PO_CALC`** | `BJJ Accessories` | `79` days | `14` days | Min `10`, else nearest `10` (`ROUND(M/10, 0)*10`) |
| **`BJJACC_PO_CALC`** | `BJJ Accessories` | `45` days | `7` days | **Belts (`9000057`, `9000077`):** Min `1`, else `ROUND(M, 0)`<br>**Sling Sacks (`9000014`):** If `M < 3` then `6`, else `MROUND(M, 6)` |
| **`YOUTH_PO_CALC`** | `Gi Youth` | `70` days | `14` days | If `M < 4` then `ROUND(M, 0)`, else nearest `6` (`ROUND(M/6, 0)*6`) |
| **`JACKET_PO_CALC`** | `Gi Jackets` | `68` days | `10` days | Min `6`, else nearest `6` (`ROUND(M/6, 0)*6`) |
| **`PANT_PO_CALC`** | `Gi Pants` | `75` days | `14` days | If `M < 6` then `10`, else nearest `10` (`ROUND(M/10, 0)*10`) |

---

## 3. Core Mathematical Model (Per SKU)

### Data Sources (`origin-enterprise-prd.origin_operations`)
- **`sku_facts`**:
  - `on_website` (`On Site?` — Column E)
  - `total_backorder` (`Backorder` — Column I)
  - `daily_velocity_90d` (`Daily Velocity (90D)` — Column J)
  - `daily_velocity_30d` (`Daily Velocity (30D)` — Column K)
  - `product_margins_total_cost`, `msrp` (for Inventory Valuation checks)
  - `current_month_demand`, `next_month_demand`, `two_months_ahead_demand` (for future Demand Plan integration)
- **`finished_goods_inventory_health`**:
  - `style_name` (`Style_Name` — Column B)
  - `color_name` (`Color` — Column C)
  - `unallocated` (`Available` — Column H)
  - `wip_quantity` (`On Order` — Column L)

### Equations
1. **Eligibility & Phase-Out / MTO (`Phase Out?` — Column F):**
   - `Phase Out? = TRUE` means the SKU is either being discontinued **or** is Made-to-Order (MTO) with a customer lead time.
   - If `On Site? = FALSE` (`on_website = false`), the SKU must not generate stock replenishment (`OHOO Target = 0`) unless explicitly flagged as a **Pre-Launch / New SKU**.

2. **On-Hand + On-Order Target (`OHOO Target` — Column G):**
   - If `Phase Out? = TRUE` (or `On Site? = FALSE` without Pre-Launch): `0`
   - If Active (`Phase Out? = FALSE` and `On Site? = TRUE`):
     $$\text{OHOO Target (G)} = \text{ROUND}(\text{Daily Velocity}_{90\text{D}} \times \text{DOI Target }(Q5),\ 0)$$

3. **Net Units Required (`Reqd` — Column M):**
   - If `Phase Out? = TRUE`:
     $$\text{Reqd (M)} = \text{Backorder (I)} - \text{On Order (L)}$$
   - If Active (`Phase Out? = FALSE`):
     $$\text{Reqd (M)} = \text{OHOO Target (G)} + \text{Backorder (I)} + \left(\text{Daily Velocity}_{30\text{D}} \times \text{Lead Time }(Q6)\right) - \text{Unallocated (H)} - \text{On Order (L)}$$

4. **Batched PO Quantity (`PO Amt` — Column N):**
   - If `Ignore? = TRUE` (Raw Material Shortage / Production Hold):
     $$\text{PO Amt (N)} = 0$$
     *(Temporarily excludes the SKU from the proposed PO when raw material shortages prevent production, while keeping its calculated `OHOO Target (G)` and `Reqd (M)` visible on the input table.)*
   - If `Phase Out? = TRUE`:
     $$\text{PO Amt (N)} = \max(0,\ \text{ROUND}(\text{Reqd (M)},\ 0))$$
     *(Produces exact uncovered customer backorders without batch rounding, clamped at `0` so excess WIP never creates negative PO quantities.)*
   - If Active (`Phase Out? = FALSE`):
     Applies the tab-specific batch rounding rule to positive `Reqd (M)`.

5. **Post-PO Forward DOI Projection (Demand Plan):**
   - Uses `current_month_demand` (`CM`) and `next_month_demand` (`NM`) from `origin_operations.sku_facts`:
     $$\text{Forward Daily Demand Rate} = \frac{\text{CM Demand} + \text{NM Demand}}{60}$$
     $$\text{Post-PO Net Supply} = \max\big(0,\ \text{Available (H)} + \text{On Order (L)} + \text{PO Amt (U)} - \text{Backorder (I)}\big)$$
     $$\text{Forward DOI} = \text{ROUND}\left(\frac{\text{Post-PO Net Supply}}{\text{Forward Daily Demand Rate}},\ 0\right)\text{ days}$$
   - Displayed per SKU, per Style, and as a weighted portfolio KPI on **Page 2 (`2. Proposed PO Output`)**. If a SKU has no Demand Plan (`CM = 0` and `NM = 0`), it falls back to displaying trailing 90D DOI (`No Plan (Xd @ 90D)`).

---

## 4. Production Line & Changeover Nuances

- **`JACKET_PO_CALC` — `RIFT` vs. `CLASSIC` Grouping:**
  - `Planning Style` (Column D) classifies Gi Jackets as `"RIFT"` (if `Style_Name` contains `"RIFT"`, e.g. `RAPTOR RIFT 2.0 JACKET`) or `"CLASSIC"`.
  - **Manufacturing Constraint:** `RIFT` jackets require a weaving/line changeover. Rather than ordering small trickle batches on every PO, `RIFT` jackets should be grouped into larger runs of **42–72 units** within a total batch of roughly **~300 jackets** when inventory allows.
- **Critical Pre-PO & SKU Hygiene Checks:**
  1. **Exclude `-X` and `-C` SKUs:** Any SKU ending in `-X` (factory seconds) or `-C` (customized) is permanently excluded from the PO calculator and BigQuery sync.
  2. **No Duplicate SKUs:** ShipHero rejects any PO upload containing duplicate SKU rows. Every calculator tab and CSV export must enforce 100% SKU uniqueness.
  3. **New & Pre-Launch SKU Validation & `Type` Assignment (`origin_operations.sku_facts`):** Because SKUs are defined in ERP weeks or months before launch, new styles/colorways/sizes found in `sku_facts` are staged in **`3. Validate New SKUs`** (checking for placeholder tokens like `-TBD-` or `One Size` on sized apparel). During validation (or when transferring from **`4. Archived SKUs`**), the planner assigns both the **Target Calculator Tab** and the **`Type`** (`RIFT`, `CLASSIC`, or `— None —`), which is saved directly into `data/bjj_tabs_config.json`. *(Future enhancement: tie directly to the Monday.com Upcoming Launches board.)*
  4. **Uncovered Backorders Check:** Always surface SKUs where `Backorder (I) > On Order (L)` even if their calculated batch quantity is `0` or modified.

---

## 5. ShipHero PO Upload CSV Specification

- **Columns (21 total):**
  `PO Number,Vendor,Ship Date,PO Date,Status,Shipping Carrier,Shipping Method,Shipping Price,Discount,Tax,Tracking Number,Packer Note,Payment Method,Payment Due By,PO Note,Packer Note,Sku,Vendor Sku,Quantity,Sell Ahead,Price`
- **Populated Fields:**
  - `Vendor` (Col 2): Mapped per tab (`Gi Jackets`, `Gi Pants`, `Gi Youth`, `BJJ Accessories`)
  - `Ship Date` (Col 3) & `PO Date` (Col 4): `YYYY-MM-DD`
  - `Sku` (Col 17): `sku_code` (strictly unique per PO file)
  - `Vendor Sku` (Col 18): Blank, `sku_code`, or `Style_Name`
  - `Quantity` (Col 19): Whole integer `PO Amt > 0`
