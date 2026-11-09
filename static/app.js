// Origin Manufacturing — BJJ PO Calculator Frontend (Simplified 2-Page Flow)

const state = {
  config: null,
  bqSkus: {},
  candidateGroups: [],
  archivedGroups: [],
  syncedAt: null,
  activeTabId: "JACKET_PO_CALC",
  activePage: "inputs", // 'inputs' | 'output' | 'validate' | 'archived'
  activeFilter: "all",
  searchQuery: "",
  activeCandFilter: "tracked_style_expansion",
  candSearchQuery: "",
  archSearchQuery: "",
  expandedGroupKeys: new Set(),
  groupSelectedSkus: new Map(),
  currentUser: null,
  simulateViewerRole: false,
  pendingPoBySku: {},
  recentPoExports: [],
  includePendingPo: true,
};

function formatAgeMinutes(mins) {
  const m = Number(mins || 0);
  if (m < 1) return "just now";
  if (m < 60) return `${Math.round(m)}m ago`;
  const h = (m / 60).toFixed(1);
  return `${h}h ago`;
}

function canGeneratePo() {
  if (state.simulateViewerRole) return false;
  if (!state.currentUser) return true;
  return Boolean(state.currentUser.can_generate_po);
}

function canManageAccess() {
  if (!state.currentUser) return false;
  return Boolean(state.currentUser.can_manage_access);
}

// Standard commercial rounding (round half away from zero) matching Google Sheets ROUND()
function excelRound(val, digits = 0) {
  if (val === null || val === undefined || Number.isNaN(Number(val))) return 0;
  const factor = Math.pow(10, digits);
  const n = Number((Number(val) * factor).toFixed(8));
  const r = n >= 0 ? Math.floor(n + 0.5) : Math.ceil(n - 0.5);
  return digits === 0 ? r : r / factor;
}

function computeRowMath({
  sku,
  velo90d,
  velo30d,
  available,
  backorder,
  onOrder,
  cmDemand,
  nmDemand,
  phaseOut,
  ignored,
  doiTarget,
  leadTime,
  batchRule,
  manualPoOverride,
}) {
  const v90 = Number(velo90d || 0);
  const v30 = Number(velo30d || 0);
  const avail = Number(available || 0);
  const bo = Number(backorder || 0);
  const wip = Number(onOrder || 0);
  const doi = Number(doiTarget || 0);
  const lt = Number(leadTime || 0);

  const isPhaseOut = Boolean(phaseOut);
  const isIgnored = Boolean(ignored);

  // Column G: OHOO Target
  const ohooTarget = isPhaseOut ? 0 : excelRound(v90 * doi, 0);

  // Column M: Reqd
  const leadTimeDemand = v30 * lt;
  const reqd = isPhaseOut
    ? bo - wip
    : ohooTarget + bo + leadTimeDemand - avail - wip;

  // Column N: Calculated PO Amt
  let calcPoAmt = 0;
  if (isPhaseOut) {
    calcPoAmt = Math.max(0, excelRound(reqd, 0));
  } else if (reqd > 0) {
    if (batchRule === "nogi_10") {
      calcPoAmt = reqd < 10 ? 10 : excelRound(reqd / 10, 0) * 10;
    } else if (batchRule === "pant_10") {
      calcPoAmt = reqd < 6 ? 10 : excelRound(reqd / 10, 0) * 10;
    } else if (batchRule === "jacket_6") {
      calcPoAmt = reqd < 6 ? 6 : excelRound(reqd / 6, 0) * 6;
    } else if (batchRule === "youth_6") {
      calcPoAmt = reqd < 4 ? excelRound(reqd, 0) : excelRound(reqd / 6, 0) * 6;
    } else if (batchRule === "acc_1") {
      if (String(sku).startsWith("9000014")) {
        calcPoAmt = reqd < 3 ? 6 : excelRound(reqd / 6, 0) * 6;
      } else {
        calcPoAmt = reqd < 1 ? 1 : excelRound(reqd, 0);
      }
    } else {
      calcPoAmt = excelRound(reqd, 0);
    }
  }

  const isOverridden =
    manualPoOverride !== null &&
    manualPoOverride !== undefined &&
    manualPoOverride !== "";

  const basePoAmt = isOverridden
    ? Math.max(0, parseInt(manualPoOverride, 10) || 0)
    : calcPoAmt;

  // If Ignore? is checked (e.g., raw material shortage), force PO Amt to 0
  const poAmt = isIgnored ? 0 : basePoAmt;

  // Post-PO Net Supply (Available + On Order + PO Amt - Backorder)
  const netPostPoSupply = Math.max(0, avail + wip + poAmt - bo);
  const cm = Number(cmDemand || 0);
  const nm = Number(nmDemand || 0);
  const fwdDailyDemand = (cm + nm) / 60.0;
  const forwardDoi = fwdDailyDemand > 0 ? excelRound(netPostPoSupply / fwdDailyDemand, 0) : null;
  const trailing90dDoi = v90 > 0 ? excelRound(netPostPoSupply / v90, 0) : null;

  return {
    ohooTarget,
    reqd,
    calcPoAmt,
    basePoAmt,
    poAmt,
    netPostPoSupply,
    fwdDailyDemand,
    forwardDoi,
    trailing90dDoi,
    isOverridden,
    isPhaseOut,
    isIgnored,
  };
}

function renderTypeBadge(typeStr) {
  const t = String(typeStr || "").trim().toUpperCase();
  if (!t) return `<span style="color:#94a3b8;">—</span>`;
  if (t === "RIFT") return `<span class="tag tag-rift">RIFT</span>`;
  return `<span class="tag tag-classic">${t}</span>`;
}

function getRowSourceData(item) {
  const sku = item.sku;
  const snap = item.sheet_snapshot || {};
  const bq = state.bqSkus[sku] || {};

  const styleName = bq.style_name || snap.style_name || "";
  const skuParts = String(sku).split("-");
  const fallbackSize = skuParts.length >= 3 ? skuParts[2] : "";
  const size = bq.size || fallbackSize;
  const rawType = item.planning_style !== undefined ? item.planning_style : (snap.planning_style || "");
  const type = String(rawType || "").trim().toUpperCase();

  const bqOnOrder = Number(bq.wip_quantity ?? snap.on_order ?? 0);
  const pendingPoQty = state.includePendingPo ? Number(state.pendingPoBySku?.[sku] || 0) : 0;

  return {
    sku,
    styleName,
    color: bq.color_name || snap.color || "",
    size,
    type,
    onSite: bq.on_website !== undefined ? Boolean(bq.on_website) : Boolean(snap.on_site),
    available: Number(bq.unallocated ?? snap.available ?? 0),
    backorder: Number(bq.total_backorder ?? snap.backorder ?? 0),
    velo90d: Number(bq.daily_velocity_90d ?? snap.velo_90d ?? 0),
    velo30d: Number(bq.daily_velocity_30d ?? snap.velo_30d ?? 0),
    bqOnOrder,
    pendingPoQty,
    onOrder: bqOnOrder + pendingPoQty,
    cmDemand: Number(bq.current_month_demand ?? 0),
    nmDemand: Number(bq.next_month_demand ?? 0),
  };
}

function evaluateTab(tab) {
  const rows = [];
  let sumAvail = 0;
  let sumTargetStock = 0;
  let sumPoQty = 0;
  let sumVelo90 = 0;
  let sumVelo30 = 0;
  let poSkuCount = 0;
  let riftPoUnits = 0;
  let classicPoUnits = 0;
  let overrideCount = 0;
  let ignoredCount = 0;

  for (const item of tab.skus) {
    const src = getRowSourceData(item);
    const math = computeRowMath({
      sku: item.sku,
      velo90d: src.velo90d,
      velo30d: src.velo30d,
      available: src.available,
      backorder: src.backorder,
      onOrder: src.onOrder,
      cmDemand: src.cmDemand,
      nmDemand: src.nmDemand,
      phaseOut: item.phase_out,
      ignored: item.ignored,
      doiTarget: tab.doi_target,
      leadTime: tab.lead_time,
      batchRule: tab.batch_rule,
      manualPoOverride: item.manual_po_override,
    });

    sumAvail += src.available;
    sumTargetStock += math.ohooTarget;
    sumPoQty += math.poAmt;
    sumVelo90 += src.velo90d;
    sumVelo30 += src.velo30d;

    if (math.poAmt > 0) poSkuCount++;
    if (math.isOverridden) overrideCount++;
    if (math.isIgnored) ignoredCount++;

    if (src.type === "RIFT") riftPoUnits += math.poAmt;
    else if (src.type === "CLASSIC") classicPoUnits += math.poAmt;

    rows.push({ item, src, math });
  }

  // Sort grouped by On Site = True first, then by SKU ascending
  rows.sort((a, b) => {
    if (a.src.onSite !== b.src.onSite) {
      return a.src.onSite ? -1 : 1;
    }
    return a.src.sku.localeCompare(b.src.sku);
  });

  return {
    rows,
    summary: {
      sumAvail,
      sumTargetStock,
      sumPoQty,
      sumVelo90,
      sumVelo30,
      poSkuCount,
      riftPoUnits,
      classicPoUnits,
      overrideCount,
      ignoredCount,
    },
  };
}

function getActiveTab() {
  if (!state.config) return null;
  return state.config.tabs.find((t) => t.id === state.activeTabId) || state.config.tabs[0];
}

function defaultDatePlusDays(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function setPage(page) {
  state.activePage = page;
  document.getElementById("pageInputs").classList.toggle("hidden", page !== "inputs");
  document.getElementById("pageOutput").classList.toggle("hidden", page !== "output");
  document.getElementById("pageValidate").classList.toggle("hidden", page !== "validate");
  document.getElementById("pageArchived").classList.toggle("hidden", page !== "archived");
  document.getElementById("pageAccess").classList.toggle("hidden", page !== "access");
  document
    .getElementById("tabsBar")
    .classList.toggle("hidden", page === "validate" || page === "archived" || page === "access");
  document.getElementById("navPageInputs").classList.toggle("active", page === "inputs");
  document.getElementById("navPageOutput").classList.toggle("active", page === "output");
  document.getElementById("navPageValidate").classList.toggle("active", page === "validate");
  document.getElementById("navPageArchived").classList.toggle("active", page === "archived");
  document.getElementById("navPageAccess").classList.toggle("active", page === "access");
  renderAll();
}

function syncInputsFromActiveTab() {
  const tab = getActiveTab();
  if (!tab) return;
  document.getElementById("inpDoiTarget").value = tab.doi_target;
  document.getElementById("inpLeadTime").value = tab.lead_time;
  document.getElementById("inpVendor").value = tab.vendor;
  document.getElementById("selVendorSkuMode").value = tab.vendor_sku_mode || "style_name";

  const shipStr = defaultDatePlusDays(tab.lead_time);
  const poDateInput = document.getElementById("inpPoDate");
  const shipDateInput = document.getElementById("inpShipDate");
  if (!poDateInput.value) poDateInput.value = shipStr;
  shipDateInput.value = shipStr;
}

function renderTabsBar() {
  const bar = document.getElementById("tabsBar");
  bar.innerHTML = "";
  if (!state.config) return;

  for (const tab of state.config.tabs) {
    const evalRes = evaluateTab(tab);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tab-btn" + (tab.id === state.activeTabId ? " active" : "");
    btn.innerHTML = `
      <span>${tab.id}</span>
      <span class="tab-po-badge">${evalRes.summary.sumPoQty} u</span>
    `;
    btn.addEventListener("click", () => {
      state.activeTabId = tab.id;
      syncInputsFromActiveTab();
      renderAll();
    });
    bar.appendChild(btn);
  }
}

function renderAll() {
  if (!state.config) return;
  renderTabsBar();

  const canEdit = canGeneratePo();
  const userEmail = state.currentUser?.email || "andy@originmfg.com";
  const effRole = state.simulateViewerRole
    ? "viewer"
    : state.currentUser?.effective_role || "admin";

  // Top Header User Badge & Read-Only Banner
  const roleBadgeEl = document.getElementById("userRoleBadge");
  if (roleBadgeEl) {
    const roleTag =
      effRole === "admin"
        ? `<span class="badge badge-yes">Admin</span>`
        : effRole === "po_generator"
        ? `<span class="badge badge-yes">PO Generator</span>`
        : `<span class="badge badge-override">Viewer${state.simulateViewerRole ? " (Preview)" : ""}</span>`;
    roleBadgeEl.innerHTML = `<span>👤 ${userEmail}</span> ${roleTag}`;
  }

  const roBanner = document.getElementById("readOnlyBanner");
  if (roBanner) roBanner.classList.toggle("hidden", canEdit);
  const btnExitSim = document.getElementById("btnExitSimViewer");
  if (btnExitSim) btnExitSim.classList.toggle("hidden", !state.simulateViewerRole);

  // Lock/Unlock Top Calculator Controls & Export Buttons
  document.getElementById("inpDoiTarget").disabled = !canEdit;
  document.getElementById("inpLeadTime").disabled = !canEdit;
  document.getElementById("btnSaveTabDefaults").disabled = !canEdit;
  document.querySelectorAll(".step-btn").forEach((b) => {
    b.disabled = !canEdit;
  });
  const btnExport = document.getElementById("btnExportCsv");
  const btnCopy = document.getElementById("btnCopySTU");
  if (btnExport) {
    btnExport.disabled = !canEdit;
    btnExport.textContent = canEdit ? "⬇ Download ShipHero CSV" : "🔒 PO Export Restricted";
  }
  if (btnCopy) {
    btnCopy.disabled = !canEdit;
  }

  const tab = getActiveTab();
  const { rows, summary } = evaluateTab(tab);

  // Recent PO Export / Duplicate Production Protection Banner for Active Tab
  const recentBanner = document.getElementById("recentPoBanner");
  const recentTextEl = document.getElementById("recentPoBannerText");
  const chkPending = document.getElementById("chkIncludePendingPo");
  const btnDiscardLatest = document.getElementById("btnDiscardLatestPo");
  const isCalcPage = state.activePage === "inputs" || state.activePage === "output";
  const tabRecentExports = (state.recentPoExports || []).filter(
    (e) => e.tab_id === tab.id && e.pending_units > 0
  );

  if (recentBanner && isCalcPage && tabRecentExports.length > 0) {
    const latest = tabRecentExports[0];
    const totalPendingUnits = tabRecentExports.reduce((acc, e) => acc + (e.pending_units || 0), 0);
    recentBanner.classList.remove("hidden");
    if (chkPending) chkPending.checked = state.includePendingPo;
    if (btnDiscardLatest) {
      btnDiscardLatest.disabled = !canEdit;
      btnDiscardLatest.setAttribute("data-export-id", latest.export_id);
    }
    if (recentTextEl) {
      recentTextEl.innerHTML = `🛡️ <strong>PO Recently Exported on <code>${tab.id}</code>:</strong> <code>${
        latest.user_email
      }</code> exported <strong>${latest.line_count} SKUs (${latest.total_units} units)</strong> ${formatAgeMinutes(
        latest.age_minutes
      )}. ${
        state.includePendingPo
          ? `<strong>+${totalPendingUnits} pending units</strong> are automatically added to <code>On Order</code> to prevent duplicate POs before BigQuery syncs.`
          : `<em>Pending PO offset is currently unchecked — caution: exporting now may duplicate those ${totalPendingUnits} units.</em>`
      }`;
    }
  } else if (recentBanner) {
    recentBanner.classList.add("hidden");
  }

  // Header badge
  document.getElementById("navPoBadge").textContent = summary.sumPoQty.toLocaleString();

  // Page 1 Summary Metrics
  document.getElementById("kpiCurrentAvail").textContent = summary.sumAvail.toLocaleString();
  document.getElementById("kpiTargetStock").textContent = summary.sumTargetStock.toLocaleString();
  document.getElementById("kpiVelo90").textContent = summary.sumVelo90.toFixed(1);
  document.getElementById("kpiVelo30").textContent = summary.sumVelo30.toFixed(1);
  document.getElementById("kpiNewPoQty").textContent = summary.sumPoQty.toLocaleString();

  // Jacket Type filter pills (shown on JACKET_PO_CALC or any tab where SKUs have RIFT/CLASSIC assigned)
  const isJacketTab = tab.id === "JACKET_PO_CALC";
  const hasTypedSkus = isJacketTab || rows.some((r) => r.src.type === "RIFT" || r.src.type === "CLASSIC");
  document.getElementById("pillRift").classList.toggle("hidden", !hasTypedSkus);
  document.getElementById("pillClassic").classList.toggle("hidden", !hasTypedSkus);
  document.getElementById("outRiftMetric").classList.toggle("hidden", !hasTypedSkus);

  if (!hasTypedSkus && (state.activeFilter === "rift" || state.activeFilter === "classic")) {
    state.activeFilter = "all";
  }

  // Filter pill counts
  document.getElementById("cntAll").textContent = rows.length;
  document.getElementById("cntProposed").textContent = rows.filter((r) => r.math.poAmt > 0).length;
  document.getElementById("cntOnSite").textContent = rows.filter((r) => r.src.onSite).length;
  document.getElementById("cntPhaseOut").textContent = rows.filter((r) => r.item.phase_out).length;
  document.getElementById("cntIgnored").textContent = summary.ignoredCount;
  document.getElementById("cntRift").textContent = rows.filter((r) => r.src.type === "RIFT").length;
  document.getElementById("cntClassic").textContent = rows.filter((r) => r.src.type === "CLASSIC").length;

  document.querySelectorAll("#filterPills .pill").forEach((el) => {
    el.classList.toggle("active", el.getAttribute("data-filter") === state.activeFilter);
  });

  // Clear Ignored & Reset Overrides buttons
  const btnClearIgnored = document.getElementById("btnClearIgnored");
  if (summary.ignoredCount > 0) {
    btnClearIgnored.classList.remove("hidden");
    btnClearIgnored.textContent = `Clear Ignored (${summary.ignoredCount})`;
  } else {
    btnClearIgnored.classList.add("hidden");
  }

  const btnClearOverrides = document.getElementById("btnClearOverrides");
  if (summary.overrideCount > 0) {
    btnClearOverrides.classList.remove("hidden");
    btnClearOverrides.textContent = `Reset Overrides (${summary.overrideCount})`;
  } else {
    btnClearOverrides.classList.add("hidden");
  }

  // Filter + Search
  const q = state.searchQuery.trim().toLowerCase();
  const filteredRows = rows.filter((r) => {
    if (state.activeFilter === "proposed" && !(r.math.poAmt > 0 || (r.math.isIgnored && r.math.basePoAmt > 0)))
      return false;
    if (state.activeFilter === "on_site" && !r.src.onSite) return false;
    if (state.activeFilter === "phase_out" && !r.item.phase_out) return false;
    if (state.activeFilter === "ignored" && !r.math.isIgnored) return false;
    if (state.activeFilter === "rift" && r.src.type !== "RIFT") return false;
    if (state.activeFilter === "classic" && r.src.type !== "CLASSIC") return false;

    if (q) {
      const hay = `${r.src.sku} ${r.src.styleName} ${r.src.color} ${r.src.size}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  // Render Page 1 Table (grouped by On Site = True first)
  const tbody = document.getElementById("calcTableBody");
  tbody.innerHTML = "";
  let lastOnSiteGroup = null;

  for (const r of filteredRows) {
    if (lastOnSiteGroup !== r.src.onSite) {
      lastOnSiteGroup = r.src.onSite;
      const groupTr = document.createElement("tr");
      groupTr.className = "group-divider";
      groupTr.innerHTML = `<td colspan="16">${
        r.src.onSite ? "● On Site — Active Website SKUs" : "○ Not On Site — Offline SKUs"
      }</td>`;
      tbody.appendChild(groupTr);
    }

    const tr = document.createElement("tr");
    if (r.math.poAmt > 0) tr.classList.add("row-po-active");
    if (r.math.isIgnored) tr.classList.add("row-ignored");
    if (!r.src.onSite) tr.classList.add("row-off-site");

    const typeBadge = renderTypeBadge(r.src.type);

    const onSiteBadge = r.src.onSite
      ? `<span class="tag tag-on">TRUE</span>`
      : `<span class="tag tag-off">FALSE</span>`;

    const poInputCls = [
      "po-input",
      r.math.poAmt > 0 ? "po-positive" : "",
      r.math.isOverridden ? "po-overridden" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const poCellHtml = r.math.isIgnored
      ? `<span class="po-ignored-badge" title="Ignored (would be ${r.math.basePoAmt})">0 (IGN)</span>`
      : `<input
          type="number"
          min="0"
          step="1"
          class="${poInputCls}"
          data-po-sku="${r.src.sku}"
          value="${r.math.poAmt}"
          ${!canEdit ? "disabled" : ""}
        />`;

    tr.innerHTML = `
      <td class="sku-cell">${r.src.sku}</td>
      <td>${r.src.styleName}</td>
      <td>${r.src.color}</td>
      <td><strong>${r.src.size}</strong></td>
      <td>${typeBadge}</td>
      <td class="center">${onSiteBadge}</td>
      <td class="center">
        <input type="checkbox" class="chk-phase-out" data-sku="${r.src.sku}" ${
      r.item.phase_out ? "checked" : ""
    } ${!canEdit ? "disabled" : ""} />
      </td>
      <td class="center">
        <input type="checkbox" class="chk-ignore" data-sku="${r.src.sku}" ${
      r.math.isIgnored ? "checked" : ""
    } ${!canEdit ? "disabled" : ""} />
      </td>
      <td class="num">${r.math.isPhaseOut ? "" : r.math.ohooTarget}</td>
      <td class="num">${r.src.available}</td>
      <td class="num">${r.src.backorder > 0 ? `<strong>${r.src.backorder}</strong>` : 0}</td>
      <td class="num">${r.src.velo90d.toFixed(2)}</td>
      <td class="num">${r.src.velo30d.toFixed(2)}</td>
      <td class="num">${
        r.src.pendingPoQty > 0
          ? `<strong>${r.src.onOrder}</strong> <span class="badge badge-yes" style="font-size:11px;padding:1px 5px;" title="BigQuery WIP: ${r.src.bqOnOrder} + Pending Exported PO: ${r.src.pendingPoQty}">+${r.src.pendingPoQty} PO</span>`
          : r.src.onOrder || 0
      }</td>
      <td class="num">${r.math.reqd.toFixed(1)}</td>
      <td class="num">${poCellHtml}</td>
    `;
    tbody.appendChild(tr);
  }

  // Bind Phase Out checkboxes
  tbody.querySelectorAll(".chk-phase-out").forEach((chk) => {
    chk.addEventListener("change", async () => {
      const sku = chk.getAttribute("data-sku");
      const item = tab.skus.find((s) => s.sku === sku);
      if (!item) return;
      item.phase_out = chk.checked;
      renderAll();
      await postJson("/api/save-tab-settings", {
        tab_id: tab.id,
        sku_updates: { [sku]: { phase_out: chk.checked } },
      });
    });
  });

  // Bind Ignore checkboxes
  tbody.querySelectorAll(".chk-ignore").forEach((chk) => {
    chk.addEventListener("change", async () => {
      const sku = chk.getAttribute("data-sku");
      const item = tab.skus.find((s) => s.sku === sku);
      if (!item) return;
      item.ignored = chk.checked;
      renderAll();
      await postJson("/api/save-tab-settings", {
        tab_id: tab.id,
        sku_updates: { [sku]: { ignored: chk.checked } },
      });
    });
  });

  // Bind Manual PO Amt Overrides
  tbody.querySelectorAll("[data-po-sku]").forEach((inp) => {
    inp.addEventListener("change", async () => {
      const sku = inp.getAttribute("data-po-sku");
      const item = tab.skus.find((s) => s.sku === sku);
      if (!item) return;
      const newVal = parseInt(inp.value, 10);
      item.manual_po_override = Number.isNaN(newVal) ? null : Math.max(0, newVal);
      renderAll();
      await postJson("/api/save-tab-settings", {
        tab_id: tab.id,
        sku_updates: { [sku]: { manual_po_override: item.manual_po_override } },
      });
    });
  });

  // =========================================================================
  // Render Page 2: Proposed PO Output & Analysis
  // Sort by Forward DOI Descending to highlight over-inventory & Demand Plan variance
  // =========================================================================
  const stuRows = rows
    .filter((r) => r.math.poAmt > 0)
    .sort((a, b) => {
      const aHasDoi = a.math.forwardDoi !== null && !a.math.isPhaseOut;
      const bHasDoi = b.math.forwardDoi !== null && !b.math.isPhaseOut;
      if (aHasDoi !== bHasDoi) return aHasDoi ? -1 : 1;
      if (aHasDoi && bHasDoi && b.math.forwardDoi !== a.math.forwardDoi) {
        return b.math.forwardDoi - a.math.forwardDoi;
      }
      // Secondary sort for No-Plan / MTO rows: by trailing 90D DOI descending, then SKU
      const a90 = a.math.trailing90dDoi ?? -1;
      const b90 = b.math.trailing90dDoi ?? -1;
      if (b90 !== a90) return b90 - a90;
      return a.src.sku.localeCompare(b.src.sku);
    });

  const wxyRows = rows
    .filter((r) => r.src.backorder > 0 && r.src.backorder > r.src.onOrder)
    .sort((a, b) => a.src.sku.localeCompare(b.src.sku));

  const totalUncoveredBo = wxyRows.reduce(
    (acc, r) => acc + Math.max(0, r.src.backorder - r.src.onOrder),
    0
  );

  document.getElementById("outTotalUnits").textContent = summary.sumPoQty.toLocaleString();
  document.getElementById("outLineCount").textContent = stuRows.length;
  document.getElementById("outClassicUnits").textContent = summary.classicPoUnits;
  document.getElementById("outRiftUnits").textContent = summary.riftPoUnits;
  document.getElementById("outUncoveredBo").textContent = totalUncoveredBo;

  // Weighted Forward DOI across proposed PO lines with a Demand Plan
  let sumPlanNetSupply = 0;
  let sumPlanFwdDaily = 0;
  for (const r of stuRows) {
    if (r.math.fwdDailyDemand > 0) {
      sumPlanNetSupply += r.math.netPostPoSupply;
      sumPlanFwdDaily += r.math.fwdDailyDemand;
    }
  }
  const weightedFwdDoi = sumPlanFwdDaily > 0 ? excelRound(sumPlanNetSupply / sumPlanFwdDaily, 0) : null;
  document.getElementById("outAvgForwardDoi").textContent =
    weightedFwdDoi !== null ? `${weightedFwdDoi} days` : "—";

  // Proposed PO lines table (S, T, U + context + Forward DOI)
  const stuBody = document.getElementById("stuTableBody");
  stuBody.innerHTML = "";
  for (const r of stuRows) {
    const typeBadge = renderTypeBadge(r.src.type);

    const hasPlan = r.src.cmDemand > 0 || r.src.nmDemand > 0;
    const planText = hasPlan
      ? `${excelRound(r.src.cmDemand, 0)} / ${excelRound(r.src.nmDemand, 0)}`
      : `<span style="color:#94a3b8;">0 / 0</span>`;

    const doiTooltip = `Post-PO Net Supply: ${r.math.netPostPoSupply} u (Avail ${r.src.available} + WIP ${r.src.onOrder} + PO ${r.math.poAmt} - BO ${r.src.backorder}) | Fwd Demand Rate: ${r.math.fwdDailyDemand.toFixed(2)}/day (CM=${r.src.cmDemand}, NM=${r.src.nmDemand}) | Trailing 90D DOI: ${r.math.trailing90dDoi !== null ? r.math.trailing90dDoi + "d" : "N/A"}`;

    let fwdDoiHtml = "";
    const highDoiThreshold = Math.max(105, Math.round(tab.doi_target * 1.35));
    if (r.math.isPhaseOut) {
      fwdDoiHtml = `<span class="badge badge-phase" title="${doiTooltip}">MTO / Phase Out</span>`;
    } else if (r.math.forwardDoi !== null) {
      const d = r.math.forwardDoi;
      if (d >= highDoiThreshold) {
        fwdDoiHtml = `<span class="badge badge-phase" title="High Forward DOI Outlier — ${doiTooltip}"><strong>⚠️ ${d}d</strong></span>`;
      } else if (d < 35) {
        fwdDoiHtml = `<span class="badge badge-override" title="Low Forward DOI (High Upcoming Demand) — ${doiTooltip}"><strong>${d}d</strong></span>`;
      } else {
        fwdDoiHtml = `<span class="badge badge-yes" title="${doiTooltip}"><strong>${d}d</strong></span>`;
      }
    } else if (r.math.trailing90dDoi !== null) {
      fwdDoiHtml = `<span class="badge badge-no" title="${doiTooltip}">No Plan (${r.math.trailing90dDoi}d @ 90D)</span>`;
    } else {
      fwdDoiHtml = `<span class="badge badge-no" title="${doiTooltip}">—</span>`;
    }

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="sku-cell">${r.src.sku}</td>
      <td>${r.src.styleName}</td>
      <td>${r.src.color}</td>
      <td><strong>${r.src.size}</strong></td>
      <td>${typeBadge}</td>
      <td class="num">${r.src.available}</td>
      <td class="num">${
        r.src.pendingPoQty > 0
          ? `<strong>${r.src.onOrder}</strong> <span class="badge badge-yes" style="font-size:11px;padding:1px 5px;" title="BigQuery WIP: ${r.src.bqOnOrder} + Pending Exported PO: ${r.src.pendingPoQty}">+${r.src.pendingPoQty} PO</span>`
          : r.src.onOrder || 0
      }</td>
      <td class="num">${r.math.reqd.toFixed(1)}</td>
      <td class="num"><strong>${r.math.poAmt}</strong></td>
      <td class="num" title="Current Month Demand: ${r.src.cmDemand} | Next Month Demand: ${r.src.nmDemand} (${r.math.fwdDailyDemand.toFixed(2)}/day)">${planText}</td>
      <td class="num">${fwdDoiHtml}</td>
    `;
    stuBody.appendChild(tr);
  }

  // Summary by Style
  const styleMap = new Map();
  for (const r of stuRows) {
    const key = r.src.styleName || "Unknown";
    if (!styleMap.has(key)) {
      styleMap.set(key, {
        styleName: key,
        type: r.src.type,
        skuCount: 0,
        totalUnits: 0,
        netSupply: 0,
        fwdDaily: 0,
      });
    }
    const entry = styleMap.get(key);
    entry.skuCount += 1;
    entry.totalUnits += r.math.poAmt;
    if (r.math.fwdDailyDemand > 0) {
      entry.netSupply += r.math.netPostPoSupply;
      entry.fwdDaily += r.math.fwdDailyDemand;
    }
  }
  const styleSummaryBody = document.getElementById("styleSummaryBody");
  styleSummaryBody.innerHTML = "";
  Array.from(styleMap.values())
    .sort((a, b) => b.totalUnits - a.totalUnits)
    .forEach((st) => {
      const stFwdDoi = st.fwdDaily > 0 ? `${excelRound(st.netSupply / st.fwdDaily, 0)}d` : "—";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${st.styleName}</td>
        <td>${renderTypeBadge(st.type)}</td>
        <td class="num">${st.skuCount}</td>
        <td class="num"><strong>${st.totalUnits}</strong></td>
        <td class="num"><strong>${stFwdDoi}</strong></td>
      `;
      styleSummaryBody.appendChild(tr);
    });

  // Backorder Check (Columns W, X, Y)
  const wxyBody = document.getElementById("wxyTableBody");
  wxyBody.innerHTML = "";
  if (wxyRows.length === 0) {
    wxyBody.innerHTML = `<tr><td colspan="6" class="center" style="color:#94a3b8;padding:12px;">No uncovered backorders on this tab.</td></tr>`;
  } else {
    for (const r of wxyRows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="sku-cell">${r.src.sku}</td>
        <td>${r.src.styleName}</td>
        <td class="num"><strong>${r.src.backorder}</strong></td>
        <td class="num">${r.src.onOrder}</td>
        <td class="num">${r.math.reqd.toFixed(1)}</td>
        <td class="num"><strong>${r.math.poAmt}</strong></td>
      `;
      wxyBody.appendChild(tr);
    }
  }

  renderCandidateValidationPage();
  renderAccessAndAuditPage();
}

function getGroupSelectedSet(g, stateKeyPrefix = "cand") {
  const mapKey = `${stateKeyPrefix}:${g.group_key}`;
  const validSkus = new Set(g.skus.map((s) => s.sku));
  if (!state.groupSelectedSkus.has(mapKey)) {
    state.groupSelectedSkus.set(mapKey, new Set(validSkus));
  } else {
    const existing = state.groupSelectedSkus.get(mapKey);
    for (const s of Array.from(existing)) {
      if (!validSkus.has(s)) existing.delete(s);
    }
  }
  return state.groupSelectedSkus.get(mapKey);
}

function renderCandidateValidationPage() {
  const groups = state.candidateGroups || [];
  const expCount = groups.filter((g) => g.bucket === "tracked_style_expansion").length;
  const newBjjCount = groups.filter((g) => g.bucket === "new_bjj_style").length;
  const compCount = groups.filter((g) => g.bucket === "compression").length;

  const badgeEl = document.getElementById("navCandidateBadge");
  if (badgeEl) badgeEl.textContent = (expCount + newBjjCount).toLocaleString();

  document.getElementById("cntCandExpansion").textContent = expCount;
  document.getElementById("cntCandNewBjj").textContent = newBjjCount;
  document.getElementById("cntCandCompression").textContent = compCount;

  document.querySelectorAll("#candFilterPills .pill").forEach((p) => {
    p.classList.toggle("active", p.getAttribute("data-cfilter") === state.activeCandFilter);
  });

  const q = state.candSearchQuery.trim().toLowerCase();
  const filtered = groups.filter((g) => {
    if (g.bucket !== state.activeCandFilter) return false;
    if (q) {
      const hay = `${g.style_number} ${g.style_name} ${g.color_name} ${g.skus.map((s) => s.sku).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const tbody = document.getElementById("candTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="center" style="padding:24px;color:#64748b;">No unmapped SKU groups in this category.</td></tr>`;
    renderArchivedPage();
    return;
  }

  const tabOptions = (state.config?.tabs || []).map((t) => t.id);

  for (const g of filtered) {
    const expandKey = `cand:${g.group_key}`;
    const isExpanded = state.expandedGroupKeys.has(expandKey);
    const selectedSet = getGroupSelectedSet(g, "cand");
    const selCount = selectedSet.size;
    const totalCount = g.sku_count;

    const tr = document.createElement("tr");
    const sizePills = g.skus
      .map((s) => {
        const isSel = selectedSet.has(s.sku);
        return `<span class="size-pill-toggle ${isSel ? "" : "unselected"}" data-pill-sku="${s.sku}" title="Click to toggle ${s.sku} | Avail: ${s.unallocated} | BO: ${s.total_backorder} | 90D Sold: ${s.units_sold_90d}">${isSel ? "✓ " : ""}${s.size || s.sku}</span>`;
      })
      .join(" ");

    const statusHtml = g.is_valid
      ? `<span class="badge badge-yes">✓ Valid (${g.sku_count} SKUs)</span>`
      : `<span class="badge badge-phase" title="${g.validation_warnings.join(", ")}">⚠️ ${g.validation_warnings[0]}</span>`;

    const selectHtml = `
      <select class="tab-select-sm" style="padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;background:#fff;">
        ${tabOptions
          .map((tid) => `<option value="${tid}" ${tid === g.suggested_tab_id ? "selected" : ""}>${tid}</option>`)
          .join("")}
      </select>
    `;

    const initType = g.suggested_type || "";
    const typeSelectHtml = `
      <select class="type-select-sm" style="padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;background:#fff;font-weight:600;">
        <option value="" ${initType === "" ? "selected" : ""}>— None —</option>
        <option value="CLASSIC" ${initType === "CLASSIC" ? "selected" : ""}>CLASSIC</option>
        <option value="RIFT" ${initType === "RIFT" ? "selected" : ""}>RIFT</option>
      </select>
    `;

    const approveLabel =
      selCount === 0
        ? "Select ≥1 Size"
        : selCount === totalCount
        ? `+ Add All (${totalCount})`
        : `+ Add Selected (${selCount}/${totalCount})`;

    const archiveLabel =
      selCount > 0 && selCount < totalCount ? `Archive (${selCount})` : "Archive";

    tr.innerHTML = `
      <td class="sku-cell">
        <button type="button" class="btn-expand-group" title="Expand to inspect and select individual sizes">
          ${isExpanded ? "▾" : "▸"} ${g.style_number}
        </button>
      </td>
      <td><strong>${g.style_name || "—"}</strong></td>
      <td>${g.color_name || g.color_code}</td>
      <td style="max-width:320px;white-space:normal;">
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;">
          ${sizePills}
          <button type="button" class="btn-expand-inline" style="margin-left:4px;font-size:12px;color:#2563eb;background:none;border:none;cursor:pointer;font-weight:600;text-decoration:underline;">
            ${isExpanded ? "Hide details" : "Select sizes..."}
          </button>
        </div>
      </td>
      <td class="center">${
        g.on_web_count > 0
          ? `<span class="badge badge-yes">${g.on_web_count}/${g.sku_count} Live</span>`
          : `<span class="badge badge-no">Pre-Launch</span>`
      }</td>
      <td class="num">${g.total_sold_90d > 0 ? `<strong>${g.total_sold_90d}</strong>` : "0"}</td>
      <td class="num">${g.total_backorder > 0 ? `<strong style="color:#dc2626">${g.total_backorder}</strong>` : "0"}</td>
      <td class="num">${g.total_demand_plan > 0 ? `<strong style="color:#0284c7">${g.total_demand_plan}</strong>` : "0"}</td>
      <td>${statusHtml}</td>
      <td>${selectHtml}</td>
      <td>${typeSelectHtml}</td>
      <td class="center" style="white-space:nowrap;">
        <button type="button" class="btn btn-sm btn-primary btn-approve-cand" style="padding:5px 10px;font-size:12px;" ${
          selCount === 0 || !canGeneratePo() ? "disabled" : ""
        }>${approveLabel}</button>
        <button type="button" class="btn btn-sm btn-outline btn-archive-cand" title="Archive selected sizes or full group" ${
          !canGeneratePo() ? "disabled" : ""
        }>${archiveLabel}</button>
      </td>
    `;

    const selEl = tr.querySelector(".tab-select-sm");
    const typeSelEl = tr.querySelector(".type-select-sm");
    const btnApprove = tr.querySelector(".btn-approve-cand");
    const btnArchive = tr.querySelector(".btn-archive-cand");
    const btnExpand = tr.querySelector(".btn-expand-group");
    const btnExpandInline = tr.querySelector(".btn-expand-inline");

    const toggleExpand = () => {
      if (state.expandedGroupKeys.has(expandKey)) {
        state.expandedGroupKeys.delete(expandKey);
      } else {
        state.expandedGroupKeys.add(expandKey);
      }
      renderCandidateValidationPage();
    };
    btnExpand.addEventListener("click", toggleExpand);
    btnExpandInline.addEventListener("click", toggleExpand);

    // Click size pill directly to toggle individual size selection
    tr.querySelectorAll("[data-pill-sku]").forEach((pillEl) => {
      pillEl.addEventListener("click", () => {
        const sCode = pillEl.getAttribute("data-pill-sku");
        if (selectedSet.has(sCode)) selectedSet.delete(sCode);
        else selectedSet.add(sCode);
        renderCandidateValidationPage();
      });
    });

    selEl.addEventListener("change", () => {
      g.suggested_tab_id = selEl.value;
      if (selEl.value === "JACKET_PO_CALC" && !typeSelEl.value) {
        typeSelEl.value = (g.style_name || "").toUpperCase().includes("RIFT") ? "RIFT" : "CLASSIC";
        g.suggested_type = typeSelEl.value;
      } else if (selEl.value !== "JACKET_PO_CALC" && !g.is_tracked_style) {
        typeSelEl.value = "";
        g.suggested_type = "";
      }
    });

    typeSelEl.addEventListener("change", () => {
      g.suggested_type = typeSelEl.value;
    });

    btnApprove.addEventListener("click", async () => {
      const targetTabId = selEl.value;
      const assignedType = typeSelEl.value;
      const skusToApprove = g.skus.map((s) => s.sku).filter((sku) => selectedSet.has(sku));
      if (skusToApprove.length === 0) return;
      btnApprove.disabled = true;
      btnApprove.textContent = "Adding...";
      await postJson("/api/manage-candidate-skus", {
        action: "approve",
        tab_id: targetTabId,
        planning_style: assignedType,
        skus: skusToApprove,
      });
    });

    btnArchive.addEventListener("click", async () => {
      btnArchive.disabled = true;
      const isSubset = selCount > 0 && selCount < totalCount;
      await postJson("/api/manage-candidate-skus", {
        action: "archive",
        group_key: g.group_key,
        skus: isSubset ? Array.from(selectedSet) : undefined,
      });
    });

    tbody.appendChild(tr);

    if (isExpanded) {
      const expTr = document.createElement("tr");
      expTr.className = "expanded-sizes-row";
      const rowsHtml = g.skus
        .map((s) => {
          const isSel = selectedSet.has(s.sku);
          return `
            <tr class="${isSel ? "" : "size-row-unselected"}">
              <td class="center">
                <input type="checkbox" class="chk-cand-size" data-sku="${s.sku}" ${
            isSel ? "checked" : ""
          } style="width:16px;height:16px;cursor:pointer;accent-color:#2563eb;" />
              </td>
              <td><strong>${s.size || "—"}</strong></td>
              <td class="sku-cell">${s.sku}</td>
              <td class="center">${
                s.on_website
                  ? `<span class="badge badge-yes">Live</span>`
                  : `<span class="badge badge-no">Pre-Launch</span>`
              }</td>
              <td class="num">${s.unallocated}</td>
              <td class="num">${s.wip_quantity}</td>
              <td class="num">${
                s.total_backorder > 0 ? `<strong style="color:#dc2626">${s.total_backorder}</strong>` : "0"
              }</td>
              <td class="num">${s.units_sold_90d > 0 ? `<strong>${s.units_sold_90d}</strong>` : "0"}</td>
              <td class="num">${s.demand_plan > 0 ? `<strong style="color:#0284c7">${s.demand_plan}</strong>` : "0"}</td>
              <td class="center" style="white-space:nowrap;">
                <button type="button" class="btn btn-sm btn-outline btn-add-single-sku" data-sku="${
                  s.sku
                }" style="padding:3px 8px;font-size:12px;">+ Add Only ${s.size || "SKU"}</button>
                <button type="button" class="btn btn-sm btn-outline btn-arch-single-sku" data-sku="${
                  s.sku
                }" style="padding:3px 8px;font-size:12px;" title="Archive only this size">Archive Size</button>
              </td>
            </tr>
          `;
        })
        .join("");

      expTr.innerHTML = `
        <td colspan="12">
          <div class="size-drawer-box">
            <div class="size-drawer-toolbar">
              <div>
                <strong>${g.style_number} — ${g.style_name || "Unnamed Style"} (${
        g.color_name || g.color_code
      })</strong>
                <span class="subtitle" style="margin-left:8px;">${selCount} of ${totalCount} sizes checked to add</span>
              </div>
              <div class="size-drawer-actions">
                <button type="button" class="btn btn-sm btn-outline btn-sel-all">Select All (${totalCount})</button>
                <button type="button" class="btn btn-sm btn-outline btn-sel-none">Deselect All</button>
                ${
                  g.on_web_count > 0 && g.on_web_count < totalCount
                    ? `<button type="button" class="btn btn-sm btn-outline btn-sel-live">Select Live Only (${g.on_web_count})</button>`
                    : ""
                }
              </div>
            </div>
            <table class="size-subtable">
              <thead>
                <tr>
                  <th class="center" style="width:44px;">Select</th>
                  <th>Size</th>
                  <th>SKU Code</th>
                  <th class="center">On Site</th>
                  <th class="num">Available</th>
                  <th class="num">On Order (WIP)</th>
                  <th class="num">Backorder</th>
                  <th class="num">90D Sold</th>
                  <th class="num">Demand Plan (CM+NM)</th>
                  <th class="center">Single-Size Action</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </td>
      `;

      expTr.querySelector(".btn-sel-all")?.addEventListener("click", () => {
        g.skus.forEach((s) => selectedSet.add(s.sku));
        renderCandidateValidationPage();
      });
      expTr.querySelector(".btn-sel-none")?.addEventListener("click", () => {
        selectedSet.clear();
        renderCandidateValidationPage();
      });
      expTr.querySelector(".btn-sel-live")?.addEventListener("click", () => {
        selectedSet.clear();
        g.skus.filter((s) => s.on_website).forEach((s) => selectedSet.add(s.sku));
        renderCandidateValidationPage();
      });

      expTr.querySelectorAll(".chk-cand-size").forEach((chk) => {
        chk.addEventListener("change", () => {
          const sCode = chk.getAttribute("data-sku");
          if (chk.checked) selectedSet.add(sCode);
          else selectedSet.delete(sCode);
          renderCandidateValidationPage();
        });
      });

      expTr.querySelectorAll(".btn-add-single-sku").forEach((b) => {
        b.addEventListener("click", async () => {
          const sCode = b.getAttribute("data-sku");
          b.disabled = true;
          b.textContent = "Adding...";
          await postJson("/api/manage-candidate-skus", {
            action: "approve",
            tab_id: selEl.value,
            planning_style: typeSelEl.value,
            skus: [sCode],
          });
        });
      });

      expTr.querySelectorAll(".btn-arch-single-sku").forEach((b) => {
        b.addEventListener("click", async () => {
          const sCode = b.getAttribute("data-sku");
          b.disabled = true;
          await postJson("/api/manage-candidate-skus", {
            action: "archive",
            group_key: g.group_key,
            skus: [sCode],
          });
        });
      });

      tbody.appendChild(expTr);
    }
  }

  renderArchivedPage();
}

function renderArchivedPage() {
  const groups = state.archivedGroups || [];
  const archBadge = document.getElementById("navArchivedBadge");
  if (archBadge) archBadge.textContent = groups.length.toLocaleString();

  const summaryEl = document.getElementById("archivedSummaryCount");
  if (summaryEl) {
    const totalSkus = groups.reduce((acc, g) => acc + g.sku_count, 0);
    summaryEl.textContent = `${groups.length} archived/excluded style groups (${totalSkus} SKUs)`;
  }

  const q = state.archSearchQuery.trim().toLowerCase();
  const filtered = groups.filter((g) => {
    if (!q) return true;
    const hay = `${g.style_number} ${g.style_name} ${g.color_name} ${g.archive_reason || ""} ${g.skus
      .map((s) => s.sku)
      .join(" ")}`.toLowerCase();
    return hay.includes(q);
  });

  const tbody = document.getElementById("archTableBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="center" style="padding:24px;color:#64748b;">No archived SKU groups match your filter.</td></tr>`;
    return;
  }

  const tabOptions = (state.config?.tabs || []).map((t) => t.id);

  for (const g of filtered) {
    const expandKey = `arch:${g.group_key}`;
    const isExpanded = state.expandedGroupKeys.has(expandKey);
    const selectedSet = getGroupSelectedSet(g, "arch");
    const selCount = selectedSet.size;
    const totalCount = g.sku_count;

    const tr = document.createElement("tr");
    const sizePills = g.skus
      .map((s) => {
        const isSel = selectedSet.has(s.sku);
        return `<span class="size-pill-toggle ${isSel ? "" : "unselected"}" data-pill-sku="${s.sku}" title="Click to toggle ${s.sku} | Avail: ${s.unallocated} | BO: ${s.total_backorder} | 90D Sold: ${s.units_sold_90d}">${isSel ? "✓ " : ""}${s.size || s.sku}</span>`;
      })
      .join(" ");

    const selectHtml = `
      <select class="tab-select-sm" style="padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;background:#fff;">
        ${tabOptions
          .map((tid) => `<option value="${tid}" ${tid === g.suggested_tab_id ? "selected" : ""}>${tid}</option>`)
          .join("")}
      </select>
    `;

    const initType = g.suggested_type || "";
    const typeSelectHtml = `
      <select class="type-select-sm" style="padding:5px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;background:#fff;font-weight:600;">
        <option value="" ${initType === "" ? "selected" : ""}>— None —</option>
        <option value="CLASSIC" ${initType === "CLASSIC" ? "selected" : ""}>CLASSIC</option>
        <option value="RIFT" ${initType === "RIFT" ? "selected" : ""}>RIFT</option>
      </select>
    `;

    const transferLabel =
      selCount === 0
        ? "Select ≥1 Size"
        : selCount === totalCount
        ? `+ Transfer All (${totalCount})`
        : `+ Transfer (${selCount}/${totalCount})`;

    tr.innerHTML = `
      <td class="sku-cell">
        <button type="button" class="btn-expand-group" title="Expand to inspect and select individual sizes">
          ${isExpanded ? "▾" : "▸"} ${g.style_number}
        </button>
      </td>
      <td><strong>${g.style_name || "—"}</strong></td>
      <td>${g.color_name || g.color_code}</td>
      <td><span class="badge badge-classic">${g.business_category || "—"}</span></td>
      <td style="max-width:300px;white-space:normal;">
        <div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;">
          ${sizePills}
          <button type="button" class="btn-expand-inline" style="margin-left:4px;font-size:12px;color:#2563eb;background:none;border:none;cursor:pointer;font-weight:600;text-decoration:underline;">
            ${isExpanded ? "Hide details" : "Select sizes..."}
          </button>
        </div>
      </td>
      <td><span class="badge badge-no">${g.archive_reason || "Archived"}</span></td>
      <td class="num">${g.total_sold_90d > 0 ? `<strong>${g.total_sold_90d}</strong>` : "0"}</td>
      <td class="num">${g.total_backorder > 0 ? `<strong style="color:#dc2626">${g.total_backorder}</strong>` : "0"}</td>
      <td>${selectHtml}</td>
      <td>${typeSelectHtml}</td>
      <td class="center" style="white-space:nowrap;">
        <button type="button" class="btn btn-sm btn-primary btn-transfer-arch" style="padding:5px 10px;font-size:12px;" ${
          selCount === 0 || !canGeneratePo() ? "disabled" : ""
        }>${transferLabel}</button>
        <button type="button" class="btn btn-sm btn-outline btn-unarchive-group" title="Move this group back to the active validation queue" ${
          !canGeneratePo() ? "disabled" : ""
        }>Return to Queue</button>
      </td>
    `;

    const selEl = tr.querySelector(".tab-select-sm");
    const typeSelEl = tr.querySelector(".type-select-sm");
    const btnTransfer = tr.querySelector(".btn-transfer-arch");
    const btnUnarchive = tr.querySelector(".btn-unarchive-group");
    const btnExpand = tr.querySelector(".btn-expand-group");
    const btnExpandInline = tr.querySelector(".btn-expand-inline");

    const toggleExpand = () => {
      if (state.expandedGroupKeys.has(expandKey)) {
        state.expandedGroupKeys.delete(expandKey);
      } else {
        state.expandedGroupKeys.add(expandKey);
      }
      renderArchivedPage();
    };
    btnExpand.addEventListener("click", toggleExpand);
    btnExpandInline.addEventListener("click", toggleExpand);

    tr.querySelectorAll("[data-pill-sku]").forEach((pillEl) => {
      pillEl.addEventListener("click", () => {
        const sCode = pillEl.getAttribute("data-pill-sku");
        if (selectedSet.has(sCode)) selectedSet.delete(sCode);
        else selectedSet.add(sCode);
        renderArchivedPage();
      });
    });

    selEl.addEventListener("change", () => {
      g.suggested_tab_id = selEl.value;
      if (selEl.value === "JACKET_PO_CALC" && !typeSelEl.value) {
        typeSelEl.value = (g.style_name || "").toUpperCase().includes("RIFT") ? "RIFT" : "CLASSIC";
        g.suggested_type = typeSelEl.value;
      } else if (selEl.value !== "JACKET_PO_CALC" && !g.is_tracked_style) {
        typeSelEl.value = "";
        g.suggested_type = "";
      }
    });

    typeSelEl.addEventListener("change", () => {
      g.suggested_type = typeSelEl.value;
    });

    btnTransfer.addEventListener("click", async () => {
      const targetTabId = selEl.value;
      const assignedType = typeSelEl.value;
      const skusToTransfer = g.skus.map((s) => s.sku).filter((sku) => selectedSet.has(sku));
      if (skusToTransfer.length === 0) return;
      btnTransfer.disabled = true;
      btnTransfer.textContent = "Transferring...";
      await postJson("/api/manage-candidate-skus", {
        action: "approve",
        tab_id: targetTabId,
        planning_style: assignedType,
        group_key: g.group_key,
        clear_archived_group: skusToTransfer.length === totalCount,
        skus: skusToTransfer,
      });
    });

    btnUnarchive.addEventListener("click", async () => {
      btnUnarchive.disabled = true;
      await postJson("/api/manage-candidate-skus", {
        action: "unarchive_group",
        group_key: g.group_key,
        style_number: g.style_number,
        skus: g.skus.map((s) => s.sku),
      });
    });

    tbody.appendChild(tr);

    if (isExpanded) {
      const expTr = document.createElement("tr");
      expTr.className = "expanded-sizes-row";
      const rowsHtml = g.skus
        .map((s) => {
          const isSel = selectedSet.has(s.sku);
          return `
            <tr class="${isSel ? "" : "size-row-unselected"}">
              <td class="center">
                <input type="checkbox" class="chk-arch-size" data-sku="${s.sku}" ${
            isSel ? "checked" : ""
          } style="width:16px;height:16px;cursor:pointer;accent-color:#2563eb;" />
              </td>
              <td><strong>${s.size || "—"}</strong></td>
              <td class="sku-cell">${s.sku}</td>
              <td class="center">${
                s.on_website
                  ? `<span class="badge badge-yes">Live</span>`
                  : `<span class="badge badge-no">Offline</span>`
              }</td>
              <td class="num">${s.unallocated}</td>
              <td class="num">${s.wip_quantity}</td>
              <td class="num">${
                s.total_backorder > 0 ? `<strong style="color:#dc2626">${s.total_backorder}</strong>` : "0"
              }</td>
              <td class="num">${s.units_sold_90d > 0 ? `<strong>${s.units_sold_90d}</strong>` : "0"}</td>
              <td class="num">${s.demand_plan > 0 ? `<strong style="color:#0284c7">${s.demand_plan}</strong>` : "0"}</td>
              <td class="center" style="white-space:nowrap;">
                <button type="button" class="btn btn-sm btn-outline btn-transfer-single-sku" data-sku="${
                  s.sku
                }" style="padding:3px 8px;font-size:12px;">+ Transfer Only ${s.size || "SKU"}</button>
              </td>
            </tr>
          `;
        })
        .join("");

      expTr.innerHTML = `
        <td colspan="11">
          <div class="size-drawer-box">
            <div class="size-drawer-toolbar">
              <div>
                <strong>${g.style_number} — ${g.style_name || "Unnamed Style"} (${
        g.color_name || g.color_code
      })</strong>
                <span class="subtitle" style="margin-left:8px;">${selCount} of ${totalCount} sizes checked to transfer</span>
              </div>
              <div class="size-drawer-actions">
                <button type="button" class="btn btn-sm btn-outline btn-arch-sel-all">Select All (${totalCount})</button>
                <button type="button" class="btn btn-sm btn-outline btn-arch-sel-none">Deselect All</button>
              </div>
            </div>
            <table class="size-subtable">
              <thead>
                <tr>
                  <th class="center" style="width:44px;">Select</th>
                  <th>Size</th>
                  <th>SKU Code</th>
                  <th class="center">On Site</th>
                  <th class="num">Available</th>
                  <th class="num">On Order (WIP)</th>
                  <th class="num">Backorder</th>
                  <th class="num">90D Sold</th>
                  <th class="num">Demand Plan (CM+NM)</th>
                  <th class="center">Single-Size Action</th>
                </tr>
              </thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
        </td>
      `;

      expTr.querySelector(".btn-arch-sel-all")?.addEventListener("click", () => {
        g.skus.forEach((s) => selectedSet.add(s.sku));
        renderArchivedPage();
      });
      expTr.querySelector(".btn-arch-sel-none")?.addEventListener("click", () => {
        selectedSet.clear();
        renderArchivedPage();
      });

      expTr.querySelectorAll(".chk-arch-size").forEach((chk) => {
        chk.addEventListener("change", () => {
          const sCode = chk.getAttribute("data-sku");
          if (chk.checked) selectedSet.add(sCode);
          else selectedSet.delete(sCode);
          renderArchivedPage();
        });
      });

      expTr.querySelectorAll(".btn-transfer-single-sku").forEach((b) => {
        b.addEventListener("click", async () => {
          const sCode = b.getAttribute("data-sku");
          b.disabled = true;
          b.textContent = "Transferring...";
          await postJson("/api/manage-candidate-skus", {
            action: "approve",
            tab_id: selEl.value,
            planning_style: typeSelEl.value,
            group_key: g.group_key,
            clear_archived_group: totalCount === 1,
            skus: [sCode],
          });
        });
      });

      tbody.appendChild(expTr);
    }
  }
}

function renderAccessAndAuditPage() {
  const ac = state.config?.access_control || {};
  const poGens = ac.po_generators || [];
  const admins = new Set((ac.admins || []).map((e) => String(e).toLowerCase()));
  const userEmail = state.currentUser?.email || "andy@originmfg.com";
  const actualRole = state.currentUser?.actual_role || "admin";
  const effRole = state.simulateViewerRole ? "viewer" : state.currentUser?.effective_role || "admin";
  const isAdmin = canManageAccess();

  const summaryEl = document.getElementById("accessCurrentUserSummary");
  if (summaryEl) {
    const authSrc =
      state.currentUser?.auth_source === "google_iap"
        ? "Google Cloud IAP"
        : "Local Workstation";
    summaryEl.innerHTML = `${userEmail} · <span class="badge ${
      effRole === "viewer" ? "badge-override" : "badge-yes"
    }">${effRole.toUpperCase()}</span> <span class="subtitle">(${authSrc})</span>`;
  }

  const btnToggleSim = document.getElementById("btnToggleSimViewer");
  if (btnToggleSim) {
    btnToggleSim.textContent = state.simulateViewerRole
      ? "✓ Exit Read-Only Viewer Preview"
      : "👁️ Preview as Read-Only Viewer";
  }

  const formBox = document.getElementById("addUserFormBox");
  if (formBox) {
    formBox.style.display = isAdmin ? "flex" : "none";
  }

  const usersBody = document.getElementById("accessUsersBody");
  if (usersBody) {
    usersBody.innerHTML = "";
    const allUsers = Array.from(new Set([...poGens.map((e) => String(e).toLowerCase()), ...admins])).sort();
    for (const email of allUsers) {
      const userIsAdmin = admins.has(email);
      const isLastAdmin = userIsAdmin && admins.size <= 1;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="sku-cell">${email}</td>
        <td>
          ${
            userIsAdmin
              ? `<span class="badge badge-yes">Admin + PO Generator</span>`
              : `<span class="badge badge-classic">PO Generator</span>`
          }
        </td>
        <td class="center">
          ${
            isAdmin
              ? `<button type="button" class="btn btn-sm btn-outline btn-remove-user" data-email="${email}" ${
                  isLastAdmin ? 'disabled title="Cannot remove the last Admin"' : ""
                }>Remove</button>`
              : `<span class="subtitle">—</span>`
          }
        </td>
      `;
      tr.querySelector(".btn-remove-user")?.addEventListener("click", async (e) => {
        const target = e.currentTarget.getAttribute("data-email");
        await postJson("/api/manage-access", {
          action: "remove_user",
          email: target,
        });
      });
      usersBody.appendChild(tr);
    }
  }

  const auditBody = document.getElementById("auditLogBody");
  if (auditBody) {
    const logs = state.config?.po_audit_log || [];
    auditBody.innerHTML = "";
    if (logs.length === 0) {
      auditBody.innerHTML = `<tr><td colspan="10" class="center" style="padding:24px;color:#64748b;">No Purchase Order CSVs exported yet. When a PO is downloaded, its details will appear here automatically.</td></tr>`;
    } else {
      for (const entry of logs) {
        const dtStr = entry.timestamp ? new Date(entry.timestamp).toLocaleString() : "—";
        const isDiscarded = entry.status === "discarded";
        const pUnits = Number(entry.pending_units || 0);
        let statusHtml = "";
        if (isDiscarded) {
          statusHtml = `<span class="badge badge-no" title="Marked as not uploaded to ShipHero">Discarded</span>`;
        } else if (pUnits > 0) {
          statusHtml = `<span class="badge badge-yes" title="+${pUnits} units currently held in On-Order to prevent double-ordering">🛡️ Active (+${pUnits}u Pending BQ)</span>`;
        } else {
          statusHtml = `<span class="badge badge-classic" title="BigQuery WIP has caught up or export is older than 48h">✓ Absorbed / Complete</span>`;
        }

        const actionHtml = canGeneratePo()
          ? isDiscarded
            ? `<button type="button" class="btn btn-sm btn-outline btn-audit-restore" data-export-id="${entry.export_id}">Restore</button>`
            : `<button type="button" class="btn btn-sm btn-outline btn-audit-discard" data-export-id="${entry.export_id}" title="Discard if this CSV was NOT uploaded to ShipHero">Discard</button>`
          : `<span class="subtitle">—</span>`;

        const tr = document.createElement("tr");
        if (isDiscarded) tr.style.opacity = "0.6";
        tr.innerHTML = `
          <td>${dtStr}</td>
          <td class="sku-cell">${entry.user_email || "—"}</td>
          <td><span class="badge badge-classic">${entry.tab_id || "—"}</span></td>
          <td>${entry.vendor || "—"}</td>
          <td>${entry.ship_date || "—"}</td>
          <td class="num">${entry.line_count || 0}</td>
          <td class="num"><strong>${(entry.total_units || 0).toLocaleString()}</strong></td>
          <td>${statusHtml}</td>
          <td class="sku-cell" style="font-size:12.5px;">${entry.filename || "—"}</td>
          <td class="center">${actionHtml}</td>
        `;
        tr.querySelector(".btn-audit-discard")?.addEventListener("click", async (e) => {
          const eid = e.currentTarget.getAttribute("data-export-id");
          await postJson("/api/manage-po-audit", { action: "discard", export_id: eid });
        });
        tr.querySelector(".btn-audit-restore")?.addEventListener("click", async (e) => {
          const eid = e.currentTarget.getAttribute("data-export-id");
          await postJson("/api/manage-po-audit", { action: "restore", export_id: eid });
        });
        auditBody.appendChild(tr);
      }
    }
  }
}

async function postJson(url, payload, updateState = true) {
  const headers = { "Content-Type": "application/json" };
  if (state.simulateViewerRole) {
    headers["X-Simulated-Role"] = "viewer";
  }
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const data = await resp.json();
  if (!resp.ok) {
    alert(data.error || "Request failed");
    throw new Error(data.error || "Request failed");
  }
  if (updateState && data.config) {
    applyServerState(data);
  }
  return data;
}

function applyServerState(data) {
  state.config = data.config;
  if (data.current_user) {
    state.currentUser = data.current_user;
  }
  state.bqSkus = data.bq_skus || {};
  state.pendingPoBySku = data.pending_po_by_sku || {};
  state.recentPoExports = data.recent_po_exports || [];
  state.candidateGroups = data.candidate_sku_groups || [];
  state.archivedGroups = data.archived_sku_groups || [];
  state.syncedAt = data.synced_at;

  const tsEl = document.getElementById("syncTimestamp");
  if (state.syncedAt) {
    const dt = new Date(state.syncedAt);
    tsEl.textContent = `BigQuery Synced: ${dt.toLocaleString()}`;
  }

  renderAll();
}

async function initApp() {
  const resp = await fetch("/api/state");
  const data = await resp.json();
  applyServerState(data);
  syncInputsFromActiveTab();
  renderAll();

  // Page navigation
  document.getElementById("navPageInputs").addEventListener("click", () => setPage("inputs"));
  document.getElementById("navPageOutput").addEventListener("click", () => setPage("output"));
  document.getElementById("navPageValidate").addEventListener("click", () => setPage("validate"));
  document.getElementById("navPageArchived").addEventListener("click", () => setPage("archived"));
  document.getElementById("navPageAccess").addEventListener("click", () => setPage("access"));
  document.getElementById("userRoleBadge").addEventListener("click", () => setPage("access"));
  document.getElementById("btnGoToOutput").addEventListener("click", () => setPage("output"));
  document.getElementById("btnBackToInputs").addEventListener("click", () => setPage("inputs"));
  document.getElementById("btnGoToArchived").addEventListener("click", () => setPage("archived"));
  document.getElementById("btnBackToValidate").addEventListener("click", () => setPage("validate"));

  // Preview as Read-Only Viewer toggle
  const toggleViewerPreview = () => {
    state.simulateViewerRole = !state.simulateViewerRole;
    renderAll();
  };
  document.getElementById("btnToggleSimViewer").addEventListener("click", toggleViewerPreview);
  document.getElementById("btnExitSimViewer").addEventListener("click", () => {
    state.simulateViewerRole = false;
    renderAll();
  });

  // Pending PO Bridge controls on the Recent PO Banner
  const chkPending = document.getElementById("chkIncludePendingPo");
  if (chkPending) {
    chkPending.addEventListener("change", () => {
      state.includePendingPo = chkPending.checked;
      renderAll();
    });
  }
  const btnDiscardLatest = document.getElementById("btnDiscardLatestPo");
  if (btnDiscardLatest) {
    btnDiscardLatest.addEventListener("click", async () => {
      const eid = btnDiscardLatest.getAttribute("data-export-id");
      if (!eid) return;
      await postJson("/api/manage-po-audit", { action: "discard", export_id: eid });
    });
  }

  // Add Authorized User (Admin)
  document.getElementById("btnAddAuthorizedUser").addEventListener("click", async () => {
    const emailInp = document.getElementById("inpNewUserEmail");
    const roleSel = document.getElementById("selNewUserRole");
    const email = emailInp.value.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      alert("Please enter a valid @originmfg.com email address.");
      return;
    }
    await postJson("/api/manage-access", {
      action: "add_user",
      email,
      role: roleSel.value,
    });
    emailInp.value = "";
  });

  // Candidate validation filters & search
  document.querySelectorAll("#candFilterPills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      state.activeCandFilter = pill.getAttribute("data-cfilter");
      renderCandidateValidationPage();
    });
  });

  document.getElementById("inpCandSearch").addEventListener("input", (e) => {
    state.candSearchQuery = e.target.value;
    renderCandidateValidationPage();
  });

  document.getElementById("inpArchSearch").addEventListener("input", (e) => {
    state.archSearchQuery = e.target.value;
    renderArchivedPage();
  });

  // Sync BigQuery
  const btnSync = document.getElementById("btnSyncBQ");
  const authBanner = document.getElementById("gcloudAuthBanner");
  const lnkSignIn = document.getElementById("lnkGcloudSignIn");
  const btnDismissAuth = document.getElementById("btnDismissAuthBanner");
  let authPollInterval = null;

  const stopAuthPolling = () => {
    if (authPollInterval) {
      clearInterval(authPollInterval);
      authPollInterval = null;
    }
  };

  if (btnDismissAuth) {
    btnDismissAuth.addEventListener("click", () => {
      stopAuthPolling();
      authBanner.classList.add("hidden");
    });
  }

  const runBigQuerySync = async () => {
    btnSync.disabled = true;
    let elapsedSec = 0;
    btnSync.textContent = "⏳ Querying BigQuery (0s / ~5s)...";
    const progressTimer = setInterval(() => {
      elapsedSec += 1;
      if (btnSync.disabled) {
        btnSync.textContent = `⏳ Querying BigQuery (${elapsedSec}s / ~5s)...`;
      }
    }, 1000);
    try {
      const data = await postJson("/api/sync-bigquery", {});
      clearInterval(progressTimer);

      if (data && data.auth_expired) {
        btnSync.disabled = false;
        btnSync.textContent = "↻ Sync BigQuery";
        if (data.auth_url && authBanner && lnkSignIn) {
          lnkSignIn.href = data.auth_url;
          authBanner.classList.remove("hidden");
          stopAuthPolling();
          authPollInterval = setInterval(async () => {
            try {
              const stResp = await fetch("/api/gcloud-auth-status");
              const stData = await stResp.json();
              if (stData.authenticated) {
                stopAuthPolling();
                authBanner.classList.add("hidden");
                runBigQuerySync();
              }
            } catch (_) {}
          }, 2000);
        } else {
          alert(data.error || "Google Cloud session expired.");
        }
        return;
      }

      authBanner?.classList.add("hidden");
      stopAuthPolling();
      btnSync.textContent = `✓ Synced (${(data.total_bq_skus_cached || 0).toLocaleString()} SKUs)`;
      setTimeout(() => {
        btnSync.disabled = false;
        btnSync.textContent = "↻ Sync BigQuery";
      }, 2000);
    } catch (err) {
      clearInterval(progressTimer);
      btnSync.disabled = false;
      btnSync.textContent = "↻ Sync BigQuery";
    }
  };

  btnSync.addEventListener("click", runBigQuerySync);

  // Q5 & Q6 live tuning
  const inpDoi = document.getElementById("inpDoiTarget");
  const inpLt = document.getElementById("inpLeadTime");

  inpDoi.addEventListener("input", () => {
    const tab = getActiveTab();
    if (!tab) return;
    tab.doi_target = Number(inpDoi.value || 0);
    renderAll();
  });

  inpLt.addEventListener("input", () => {
    const tab = getActiveTab();
    if (!tab) return;
    tab.lead_time = Number(inpLt.value || 0);
    document.getElementById("inpShipDate").value = defaultDatePlusDays(tab.lead_time);
    renderAll();
  });

  document.querySelectorAll(".step-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = btn.getAttribute("data-target");
      const step = Number(btn.getAttribute("data-step"));
      const inp = document.getElementById(targetId);
      inp.value = Math.max(0, Number(inp.value || 0) + step);
      inp.dispatchEvent(new Event("input"));
    });
  });

  // Save Q5/Q6 Defaults
  document.getElementById("btnSaveTabDefaults").addEventListener("click", async (e) => {
    const tab = getActiveTab();
    if (!tab) return;
    const btn = e.currentTarget;
    btn.textContent = "Saving...";
    await postJson("/api/save-tab-settings", {
      tab_id: tab.id,
      doi_target: tab.doi_target,
      lead_time: tab.lead_time,
      vendor: document.getElementById("inpVendor").value,
      vendor_sku_mode: document.getElementById("selVendorSkuMode").value,
    });
    btn.textContent = "✓ Saved";
    setTimeout(() => {
      btn.textContent = "Save Target & Lead Time";
    }, 1200);
  });

  // Filter pills
  document.querySelectorAll("#filterPills .pill").forEach((pill) => {
    pill.addEventListener("click", () => {
      state.activeFilter = pill.getAttribute("data-filter");
      renderAll();
    });
  });

  // Search box
  document.getElementById("inpSearch").addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderAll();
  });

  // Clear Ignored
  document.getElementById("btnClearIgnored").addEventListener("click", async () => {
    const tab = getActiveTab();
    if (!tab) return;
    await postJson("/api/save-tab-settings", {
      tab_id: tab.id,
      clear_ignored: true,
    });
  });

  // Reset overrides
  document.getElementById("btnClearOverrides").addEventListener("click", async () => {
    const tab = getActiveTab();
    if (!tab) return;
    await postJson("/api/save-tab-settings", {
      tab_id: tab.id,
      clear_overrides: true,
    });
  });

  // Export ShipHero CSV
  document.getElementById("btnExportCsv").addEventListener("click", async () => {
    const tab = getActiveTab();
    if (!tab) return;
    const { rows } = evaluateTab(tab);
    const lines = rows
      .filter((r) => r.math.poAmt > 0)
      .map((r) => ({
        sku: r.src.sku,
        style_name: r.src.styleName,
        po_amt: r.math.poAmt,
      }));

    if (lines.length === 0) {
      alert("No SKUs currently have PO Amt > 0 on this tab.");
      return;
    }

    const vendor = document.getElementById("inpVendor").value.trim() || tab.vendor;
    const poDate = document.getElementById("inpPoDate").value;
    const shipDate = document.getElementById("inpShipDate").value;
    const vendorSkuMode = document.getElementById("selVendorSkuMode").value;

    const res = await postJson(
      "/api/export-shiphero-csv",
      {
        tab_id: tab.id,
        vendor,
        po_date: poDate,
        ship_date: shipDate,
        vendor_sku_mode: vendorSkuMode,
        lines,
      },
      false
    );

    if (res.state) {
      applyServerState(res.state);
    } else if (res.po_audit_log && state.config) {
      state.config.po_audit_log = res.po_audit_log;
      renderAccessAndAuditPage();
    }

    const blob = new Blob([res.csv_text], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = res.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    const statusEl = document.getElementById("exportStatusMsg");
    statusEl.classList.remove("hidden");
    statusEl.textContent = `✓ Exported ${res.line_count} unique SKUs (${res.total_units} units) by ${
      state.currentUser?.email || "andy@originmfg.com"
    } to exports/${res.filename}`;
  });

  // Copy S, T, U to clipboard
  document.getElementById("btnCopySTU").addEventListener("click", async (e) => {
    const tab = getActiveTab();
    if (!tab) return;
    const { rows } = evaluateTab(tab);
    const stuRows = rows
      .filter((r) => r.math.poAmt > 0)
      .sort((a, b) => a.src.sku.localeCompare(b.src.sku));
    const tsv = [
      "sku_code\tStyle_Name\tPO Amt",
      ...stuRows.map((r) => `${r.src.sku}\t${r.src.styleName}\t${r.math.poAmt}`),
    ].join("\n");
    await navigator.clipboard.writeText(tsv);
    const btn = e.currentTarget;
    const orig = btn.textContent;
    btn.textContent = "✓ Copied!";
    setTimeout(() => {
      btn.textContent = orig;
    }, 1400);
  });
}

window.addEventListener("DOMContentLoaded", initApp);
