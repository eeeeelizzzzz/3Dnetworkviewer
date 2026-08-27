/**
 * Portal app — layout: analysis column | 3D | control bar.
 * Shared series toggles; probe at sites or any grid column.
 */
import { createEngine } from "./portal_engine.js?v=20260822n";
import {
  colormapCssGradient,
  colorHexForValue,
  contourLevels,
} from "./marching_cubes.js?v=20260822n";
import {
  exportPlotlyPanel,
  exportPlanMap,
  renderPlanMap,
  downloadDataUrl,
  sanitizeFilename,
} from "./figure_export.js?v=20260822n";
import { initClassicViewer, resizeClassicViewer } from "./classic_viewer.js?v=20260826r";

const LAYER_COLORS = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#f472b6"];

const DEFAULT_SERIES_PALETTE = {
  UAS: "#B900C7",
  HRRR: "#777777",
  A: "#DE8A00",
  B: "#3018A9",
  C: "#88CCEE",
};

const MODEL_SRC = {
  HRRR: "hrrr",
  A: "A",
  B: "B",
  C: "C",
};

const els = {
  model: document.getElementById("model-select"),
  timeSlider: document.getElementById("time-slider"),
  timeSliderMain: document.getElementById("time-slider-main"),
  timeSliderViewer: document.getElementById("time-slider-viewer"),
  timeLabel: document.getElementById("time-label"),
  timeBarLabel: document.getElementById("time-bar-label"),
  timeLabelViewer: document.getElementById("time-label-viewer"),
  btnPlay: document.getElementById("btn-play"),
  btnPlayMain: document.getElementById("btn-play-main"),
  btnPlayViewer: document.getElementById("btn-play-viewer"),
  btnTimePrev: document.getElementById("btn-time-prev"),
  btnTimeNext: document.getElementById("btn-time-next"),
  btnTimePrevSettings: document.getElementById("btn-time-prev-settings"),
  btnTimeNextSettings: document.getElementById("btn-time-next-settings"),
  var3d: document.getElementById("var-3d"),
  mode3d: document.getElementById("mode-3d"),
  viewDim: document.getElementById("view-dim"),
  viewport3d: document.getElementById("viewport3d"),
  viewport2d: document.getElementById("viewport2d"),
  mapSamplePopup: document.getElementById("map-sample-popup"),
  mapSamplePopupTitle: document.getElementById("map-sample-popup-title"),
  mapSamplePopupCanvas: document.getElementById("map-sample-popup-canvas"),
  mapSamplePopupClose: document.getElementById("map-sample-popup-close"),
  nLayers: document.getElementById("n-layers"),
  nLayersReadout: document.getElementById("n-layers-readout"),
  layerValues: document.getElementById("layer-values"),
  focusSlider: document.getElementById("focus-slider"),
  focusReadout: document.getElementById("focus-readout"),
  sliceSlider: document.getElementById("slice-slider"),
  sliceReadout: document.getElementById("slice-readout"),
  opacitySlider: document.getElementById("opacity-slider"),
  opacityReadout: document.getElementById("opacity-readout"),
  terrainOpacity: document.getElementById("terrain-opacity"),
  terrainOpacityNum: document.getElementById("terrain-opacity-num"),
  terrainOpacityReadout: document.getElementById("terrain-opacity-readout"),
  vertScale: document.getElementById("vert-scale"),
  vertReadout: document.getElementById("vert-readout"),
  isoGroup: document.getElementById("iso-group"),
  sliceGroup: document.getElementById("slice-group"),
  site: document.getElementById("site-select"),
  seriesVar: document.getElementById("series-var"),
  tsHeight: document.getElementById("ts-height"),
  tsHeightNum: document.getElementById("ts-height-num"),
  tsHeightReadout: document.getElementById("ts-height-readout"),
  tsSubtitle: document.getElementById("ts-subtitle"),
  networkStatus: document.getElementById("network-status"),
  headerMeta: document.getElementById("header-meta"),
  viewStatus: document.getElementById("view-status"),
  btnHelp: document.getElementById("btn-help"),
  helpModal: document.getElementById("help-modal"),
  profileViewMode: document.getElementById("profile-view-mode"),
  profileSubtitle: document.getElementById("profile-subtitle"),
  camReset: document.getElementById("cam-reset"),
  camTop: document.getElementById("cam-top"),
  camSide: document.getElementById("cam-side"),
  btnSection: document.getElementById("btn-section"),
  btnClearSection: document.getElementById("btn-clear-section"),
  sectionMode: document.getElementById("section-mode"),
  sectionSubtitle: document.getElementById("section-subtitle"),
  sectionPanel: document.querySelector(".section-panel"),
  hudColorbar: document.getElementById("hud-colorbar"),
  hudCbTitle: document.getElementById("hud-cb-title"),
  hudCbMin: document.getElementById("hud-cb-min"),
  hudCbMax: document.getElementById("hud-cb-max"),
  hudElevMin: document.getElementById("hud-elev-min"),
  hudElevMax: document.getElementById("hud-elev-max"),
  probeBadge: document.getElementById("probe-badge"),
  profilePanel: document.getElementById("profile-panel"),
  zMode: document.getElementById("z-mode"),
  compassNeedle: document.getElementById("compass-needle"),
  controlsPanel: document.getElementById("controls-panel"),
  profXmin: document.getElementById("prof-xmin"),
  profXmax: document.getElementById("prof-xmax"),
  profZmin: document.getElementById("prof-zmin"),
  profZmax: document.getElementById("prof-zmax"),
  tsYmin: document.getElementById("ts-ymin"),
  tsYmax: document.getElementById("ts-ymax"),
  colormapSelect: document.getElementById("colormap-select"),
  colorVmin: document.getElementById("color-vmin"),
  colorVmax: document.getElementById("color-vmax"),
  contourInterval: document.getElementById("contour-interval"),
  contourIntervalHint: document.getElementById("contour-interval-hint"),
  btnApplyContours: document.getElementById("btn-apply-contours"),
  colorFromMap: document.getElementById("color-from-map"),
  pollCursor: document.getElementById("poll-cursor"),
  pollHeight: document.getElementById("poll-height"),
  pollHeightReadout: document.getElementById("poll-height-readout"),
  hudPoll: document.getElementById("hud-poll"),
  hudPollXy: document.getElementById("hud-poll-xy"),
  hudPollZv: document.getElementById("hud-poll-zv"),
  exportMenu: document.getElementById("export-menu"),
  btnExportProfile: document.getElementById("btn-export-profile"),
  btnExportTs: document.getElementById("btn-export-ts"),
  btnExportSection: document.getElementById("btn-export-section"),
};

const app = {
  meta: null,
  engine: null,
  soundingCache: new Map(),
  playing: false,
  playTimer: null,
  layerIso: [8, 10, 12],
  layerColors: LAYER_COLORS.slice(),
  layerOpacity: [0.72, 0.72, 0.72, 0.72, 0.72],
  seriesPalette: { ...DEFAULT_SERIES_PALETTE },
  rebuildTimer: null,
  probe: {
    mode: "site",
    siteId: null,
    xKm: 0,
    yKm: 0,
  },
  refreshGen: 0,
  sectionView: "spatial",
  sectionRefreshGen: 0,
};

function parseOptionalNumber(el) {
  if (!el) return null;
  const raw = String(el.value || "").trim();
  if (raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function profileAxisRanges() {
  const xmin = parseOptionalNumber(els.profXmin);
  const xmax = parseOptionalNumber(els.profXmax);
  const zmin = parseOptionalNumber(els.profZmin);
  const zmax = parseOptionalNumber(els.profZmax);
  const out = {};
  if (xmin != null && xmax != null && xmin < xmax) out.xRange = [xmin, xmax];
  if (zmin != null && zmax != null && zmin < zmax) out.zRange = [zmin, zmax];
  else if (zmin != null || zmax != null) {
    out.zRange = [zmin != null ? zmin : 0, zmax != null ? zmax : 1500];
  }
  return out;
}

function tsAxisRange() {
  const ymin = parseOptionalNumber(els.tsYmin);
  const ymax = parseOptionalNumber(els.tsYmax);
  if (ymin != null && ymax != null && ymin < ymax) return [ymin, ymax];
  return null;
}

function currentSeriesPalette() {
  const p = { ...DEFAULT_SERIES_PALETTE, ...app.seriesPalette };
  document.querySelectorAll(".series-color").forEach((inp) => {
    const key = inp.dataset.src;
    if (key && inp.value) p[key] = inp.value;
  });
  app.seriesPalette = p;
  return p;
}

function enabledSources() {
  return [...document.querySelectorAll(".series-src:checked")].map((el) => el.value);
}

function exportBasename(kind) {
  const times = (app.meta && app.meta.times) || [];
  const ti = Number(els.timeSlider.value) || 0;
  const tag = (times[ti] && times[ti].tag) || "time";
  const model = (els.model && els.model.value) || "model";
  return sanitizeFilename(`scales_${kind}_${model}_${tag}`);
}

function planSliceIndex() {
  // Plan-map height always follows Poll / plan-map height AGL (not the 3D slice slider).
  if (!app.engine) return 0;
  const zWant =
    els.pollHeight && Number.isFinite(Number(els.pollHeight.value))
      ? Number(els.pollHeight.value)
      : 100;
  const nz = app.engine.getNz();
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < nz; k += 1) {
    const d = Math.abs(app.engine.getZm(k) - zWant);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return best;
}

async function runExport(kind) {
  try {
    if (kind === "profile") {
      const mode =
        els.profileViewMode && els.profileViewMode.value === "hodograph"
          ? "hodograph"
          : "profile";
      await exportPlotlyPanel("plotly-sounding", `${exportBasename(mode)}.png`, {
        width: 900,
        height: 750,
      });
      return;
    }
    if (kind === "timeseries") {
      await exportPlotlyPanel("plotly-ts", `${exportBasename("timeseries")}.png`, {
        width: 1100,
        height: 420,
      });
      return;
    }
    if (kind === "section") {
      const mode = currentSectionMode() === "timeheight" ? "timeheight" : "xsection";
      await exportPlotlyPanel("plotly-section", `${exportBasename(mode)}.png`, {
        width: 1100,
        height: 520,
      });
      return;
    }
    if (kind === "plan") {
      if (!app.engine) throw new Error("Viewer not ready");
      const snap = app.engine.getPlanSliceSnapshot(planSliceIndex(), {
        probe: { xKm: app.probe.xKm, yKm: app.probe.yKm },
      });
      if (!snap) throw new Error("No volume loaded for plan map");
      const mode = els.mode3d ? els.mode3d.value : "isosurface";
      const overlay =
        mode === "profiles" || mode === "hodographs"
          ? app.engine.getMapOverlayExportPayload
            ? app.engine.getMapOverlayExportPayload()
            : null
          : null;
      await exportPlanMap(snap, {
        filename: `${exportBasename(`plan_${Math.round(snap.z_m)}m`)}.png`,
        overlay,
        heatmapOpacity: overlay ? 0.55 : 1,
      });
      return;
    }
    if (kind === "view3d" || kind === "view3d_light") {
      if (!app.engine) throw new Error("Viewer not ready");
      const light = kind === "view3d_light";
      const url = app.engine.captureViewportPng({ lightBg: light });
      const mode = els.mode3d ? els.mode3d.value : "isosurface";
      downloadDataUrl(url, `${exportBasename(light ? `3d_${mode}_light` : `3d_${mode}`)}.png`);
      return;
    }
    throw new Error(`Unknown export: ${kind}`);
  } catch (err) {
    console.error(err);
    const msg = err && err.message ? err.message : String(err);
    if (els.viewStatus) els.viewStatus.textContent = `Export failed: ${msg}`;
    window.alert(`Export failed: ${msg}`);
  }
}

function wireExportUi() {
  document.querySelectorAll("[data-export]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-export");
      if (kind) runExport(kind);
    });
  });
}

function syncSrcChipStyles() {
  document.querySelectorAll(".src-chip").forEach((chip) => {
    const cb = chip.querySelector(".series-src");
    chip.classList.toggle("is-on", !!(cb && cb.checked));
  });
}

/**
 * Default A/B/C series chips to the current Fusion state (exclusive among A/B/C).
 * UAS/HRRR are left alone except HRRR is forced on when fusion is HRRR.
 * After this, the user may freely toggle A/B/C for overlays.
 */
function syncSeriesChipsToFusion() {
  const key = highlightSourceKey();
  document.querySelectorAll(".series-src").forEach((cb) => {
    const v = cb.value;
    if (v === "UAS") return;
    if (v === "A" || v === "B" || v === "C") {
      cb.checked = key === v;
      return;
    }
    if (v === "HRRR" && key === "HRRR") cb.checked = true;
  });
  syncSrcChipStyles();
}

function updateColorbarHud() {
  if (!app.engine) return;
  const toggle = document.getElementById("toggle-colorbar");
  const colorbarsOn = toggle ? toggle.checked : true;
  const terrainOn = document.getElementById("toggle-terrain")
    ? document.getElementById("toggle-terrain").checked
    : true;

  if (els.hudColorbar) {
    els.hudColorbar.classList.toggle("is-hidden", !colorbarsOn);
  }
  const elevEl = document.getElementById("hud-elev");
  if (elevEl) {
    elevEl.classList.toggle("is-hidden", !colorbarsOn || !terrainOn);
  }

  if (!colorbarsOn) return;

  if (elevEl && terrainOn && app.engine.state.terrainFloat) {
    const elev = app.engine.state.terrainFloat;
    const lo = elev.cmin != null ? elev.cmin : elev.emin || elev.ref || 150;
    const hi = elev.cmax != null ? elev.cmax : elev.emax || elev.ref + 350;
    if (els.hudElevMin) els.hudElevMin.textContent = Math.round(lo).toString();
    if (els.hudElevMax) els.hudElevMax.textContent = Math.round(hi).toString();
  }

  if (!els.hudColorbar || els.hudColorbar.classList.contains("is-hidden")) return;

  const r = app.engine.getFieldRange();
  const unit = r.unit ? ` (${r.unit})` : "";
  const mode = els.mode3d ? els.mode3d.value : "isosurface";
  const mapName = (els.colormapSelect && els.colormapSelect.value) || r.mapName || "viridis";
  const bar = els.hudColorbar.querySelector(".hud-cb-bar");
  const fmt = (v) =>
    Math.abs(v) >= 100 || Math.abs(v) < 0.01 ? Number(v).toFixed(0) : Number(v).toFixed(1);

  if (mode === "isosurface") {
    const levels = app.engine.getIsoLevels();
    const fromMap = els.colorFromMap ? els.colorFromMap.checked : true;
    if (fromMap && bar) {
      bar.style.background = colormapCssGradient(mapName, 16);
      els.hudCbMin.textContent = fmt(r.min);
      els.hudCbMax.textContent = fmt(r.max);
    } else {
      const colors = app.layerColors;
      const stops = levels
        .map((_, i) => {
          const p = levels.length <= 1 ? 50 : (i / (levels.length - 1)) * 100;
          return `${colors[i % colors.length]} ${p}%`;
        })
        .join(", ");
      if (bar) {
        bar.style.background =
          levels.length > 0
            ? `linear-gradient(90deg, ${stops})`
            : colormapCssGradient(mapName, 12);
      }
      els.hudCbMin.textContent = levels.length ? fmt(levels[0]) : "—";
      els.hudCbMax.textContent = levels.length
        ? fmt(levels[levels.length - 1])
        : "—";
    }
    els.hudCbTitle.textContent = `${r.label || "field"} isosurfaces${unit}`;
  } else {
    if (bar) bar.style.background = colormapCssGradient(mapName, 16);
    els.hudCbTitle.textContent = `${r.label || "field"}${unit}`;
    els.hudCbMin.textContent = fmt(r.min);
    els.hudCbMax.textContent = fmt(r.max);
  }
}

function syncColorScaleToEngine(rebuild) {
  if (!app.engine) return;
  const vmin = parseOptionalNumber(els.colorVmin);
  const vmax = parseOptionalNumber(els.colorVmax);
  const interval = parseOptionalNumber(els.contourInterval);
  app.engine.setColorScale({
    mapName: (els.colormapSelect && els.colormapSelect.value) || "viridis",
    vmin,
    vmax,
    interval,
    colorLayersFromMap: els.colorFromMap ? els.colorFromMap.checked : true,
  });
  if (rebuild === false) {
    /* setColorScale already rebuilds */
  }
  updateColorbarHud();
}

function applyContourInterval() {
  if (!app.engine) return;
  const r = app.engine.getFieldRange();
  const vmin = parseOptionalNumber(els.colorVmin);
  const vmax = parseOptionalNumber(els.colorVmax);
  const lo = vmin != null ? vmin : r.dataMin != null ? r.dataMin : r.min;
  const hi = vmax != null ? vmax : r.dataMax != null ? r.dataMax : r.max;
  let d = parseOptionalNumber(els.contourInterval);
  if (d == null || d <= 0) {
    d = (hi - lo) / 4;
    if (els.contourInterval) els.contourInterval.value = String(Number(d.toFixed(2)));
  }
  const levels = contourLevels(lo, hi, d, 5);
  if (!levels.length) return;
  if (els.nLayers) {
    els.nLayers.value = String(levels.length);
    els.nLayersReadout.textContent = String(levels.length);
  }
  app.layerIso = levels.slice();
  if (els.colorFromMap && els.colorFromMap.checked) {
    const mapName = (els.colormapSelect && els.colormapSelect.value) || "viridis";
    app.layerColors = levels.map((lv) => colorHexForValue(lv, lo, hi, mapName));
  }
  if (els.contourIntervalHint) {
    els.contourIntervalHint.textContent = `${levels.length} levels · Δ ${d}`;
  }
  rebuildLayerInputs({ applyDefaults: false });
  syncColorScaleToEngine();
  scheduleIsoApply();
}

function updatePollHud(sample) {
  if (!els.hudPoll) return;
  const on = els.pollCursor ? els.pollCursor.checked : true;
  if (!on || !sample || sample.value == null) {
    els.hudPoll.hidden = true;
    return;
  }
  els.hudPoll.hidden = false;
  const unit = sample.unit ? ` ${sample.unit}` : "";
  if (els.hudPollXy) {
    els.hudPollXy.textContent = `x ${sample.xKm.toFixed(1)} · y ${sample.yKm.toFixed(1)} km`;
  }
  if (els.hudPollZv) {
    const v =
      Math.abs(sample.value) >= 100
        ? sample.value.toFixed(1)
        : sample.value.toFixed(2);
    els.hudPollZv.textContent = `z ${sample.zAglM.toFixed(0)} m · ${v}${unit}`;
  }
}

function fillColorLimitPlaceholders() {
  if (!app.engine) return;
  const r = app.engine.getFieldRange();
  const dmin = r.dataMin != null ? r.dataMin : r.min;
  const dmax = r.dataMax != null ? r.dataMax : r.max;
  if (els.colorVmin && !els.colorVmin.value) {
    els.colorVmin.placeholder = Number(dmin).toFixed(1);
  }
  if (els.colorVmax && !els.colorVmax.value) {
    els.colorVmax.placeholder = Number(dmax).toFixed(1);
  }
}

function plotlyColorscaleName() {
  const map = (els.colormapSelect && els.colormapSelect.value) || "viridis";
  if (map === "plasma") return "Plasma";
  if (map === "magma") return "Magma";
  if (map === "turbo") return "Portland"; // wide Plotly support
  if (map === "grayscale") return "Greys";
  if (map === "coolwarm") return "RdBu";
  return "Viridis";
}

function currentSectionMode() {
  if (els.sectionMode && els.sectionMode.value) return els.sectionMode.value;
  return app.sectionView || "spatial";
}

function syncSectionModeUi() {
  const mode = currentSectionMode();
  app.sectionView = mode;
  if (els.sectionPanel) {
    els.sectionPanel.classList.toggle("is-timeheight", mode === "timeheight");
  }
  if (mode === "timeheight") {
    if (app.engine && app.engine.state.drawMode === "section") {
      app.engine.setDrawMode(null);
    }
    if (els.sectionSubtitle) {
      els.sectionSubtitle.textContent =
        "Time–height at the active probe (fusion field)";
    }
  } else if (els.sectionSubtitle) {
    els.sectionSubtitle.textContent =
      app.engine && app.engine.hasSection()
        ? "Spatial transect in the 3D view"
        : "Draw a transect in the 3D view";
  }
}

/**
 * Build time–height section: fusion-state volume at probe (x,y) for all times.
 * grid[k][t] = value at height k, time t.
 */
async function buildTimeHeightSection(gen) {
  if (!app.engine || !app.meta) return null;
  const p = app.probe;
  if (!p || p.xKm == null || p.yKm == null) return null;
  if (!probeInDomain()) return null;

  const modelId = els.model && els.model.value;
  const variable = els.var3d && els.var3d.value;
  if (!modelId || !variable) return null;

  const times = app.meta.times || [];
  if (!times.length) return null;

  const xLabels = [];
  const columns = [];
  let zAxis = null;
  let nOk = 0;

  for (const tt of times) {
    if (gen != null && gen !== app.sectionRefreshGen) return null;
    xLabels.push(tt.label.replace(" UTC", "").replace(/^20/, "").trim());
    let col = null;
    try {
      col = await app.engine.sampleColumn(
        modelId,
        tt.tag,
        variable,
        p.xKm,
        p.yKm
      );
    } catch (err) {
      console.warn("time–height sample failed", tt.tag, err);
      col = null;
    }
    if (!col || !col.z || !col[variable]) {
      columns.push(null);
      continue;
    }
    if (!zAxis) zAxis = col.z.slice();
    columns.push(col[variable].map((v) => (Number.isFinite(v) ? v : null)));
    nOk += 1;
  }

  if (!zAxis || nOk === 0) return null;
  const nz = zAxis.length;
  const nt = columns.length;
  const grid = [];
  for (let k = 0; k < nz; k += 1) {
    const row = [];
    for (let t = 0; t < nt; t += 1) {
      const c = columns[t];
      row.push(c ? c[k] : null);
    }
    grid.push(row);
  }

  const r = app.engine.getFieldRange();
  const loc =
    p.mode === "site" && p.siteId
      ? p.siteId
      : `grid (${Number(p.xKm).toFixed(1)}, ${Number(p.yKm).toFixed(1)}) km`;
  const modelLabel =
    ((app.meta.models || []).find((m) => m.id === modelId) || {}).label ||
    modelId;

  return {
    kind: "timeheight",
    grid,
    xAxis: xLabels,
    zAxis,
    variable,
    unit: r.unit || "",
    title: `${loc} · ${variable} · ${modelLabel}`,
    zmin: r.min,
    zmax: r.max,
  };
}

async function refreshSectionPanel() {
  const gen = ++app.sectionRefreshGen;
  syncSectionModeUi();
  const mode = currentSectionMode();

  if (mode === "timeheight") {
    if (els.sectionSubtitle) {
      els.sectionSubtitle.textContent = "Loading time–height…";
    }
    SoundingPlotter.renderCrossSection("plotly-section", null, {
      kind: "timeheight",
      emptyText: "Loading time–height…",
    });
    let section = null;
    try {
      section = await buildTimeHeightSection(gen);
    } catch (err) {
      console.error("time–height build error", err);
      if (gen !== app.sectionRefreshGen) return;
      SoundingPlotter.renderCrossSection("plotly-section", null, {
        kind: "timeheight",
        emptyText: `Time–height error: ${err.message || err}`,
      });
      if (els.sectionSubtitle) {
        els.sectionSubtitle.textContent = "Time–height failed — see console";
      }
      return;
    }
    if (gen !== app.sectionRefreshGen) return;
    if (!section) {
      SoundingPlotter.renderCrossSection("plotly-section", null, {
        kind: "timeheight",
        emptyText: probeInDomain()
          ? "No volume column at this probe — try another site"
          : "Probe outside domain — no time–height",
      });
      if (els.sectionSubtitle) {
        els.sectionSubtitle.textContent = probeInDomain()
          ? "Time–height — no data"
          : "Time–height — probe outside domain";
      }
      return;
    }
    try {
      SoundingPlotter.renderCrossSection("plotly-section", section, {
        kind: "timeheight",
        unit: section.unit,
        colorscale: plotlyColorscaleName(),
        zmin: section.zmin,
        zmax: section.zmax,
      });
      const el = document.getElementById("plotly-section");
      if (el && window.Plotly && Plotly.Plots) {
        try {
          Plotly.Plots.resize(el);
        } catch (_) {
          /* ignore */
        }
      }
    } catch (err) {
      console.error("time–height plot error", err);
      SoundingPlotter.renderCrossSection("plotly-section", null, {
        kind: "timeheight",
        emptyText: `Plot error: ${err.message || err}`,
      });
    }
    if (els.sectionSubtitle) {
      els.sectionSubtitle.textContent = section.title;
    }
    return;
  }

  // Spatial: keep existing curtain if drawn; otherwise empty placeholder
  if (app.engine && app.engine.hasSection()) {
    app.engine.refreshSection();
    if (els.sectionSubtitle) {
      els.sectionSubtitle.textContent = "Spatial transect in the 3D view";
    }
  } else {
    SoundingPlotter.renderCrossSection("plotly-section", null, {
      kind: "spatial",
    });
  }
}

function setSectionButtonActive(on) {
  if (!els.btnSection) return;
  els.btnSection.classList.toggle("is-active", !!on);
  els.btnSection.textContent = on
    ? "Drawing… click two points"
    : "Click to draw xsection line";
}

function setClearSectionEnabled(on) {
  if (!els.btnClearSection) return;
  els.btnClearSection.disabled = !on;
}

function syncTimeSliders(val) {
  const s = String(val);
  if (els.timeSlider) els.timeSlider.value = s;
  if (els.timeSliderMain) els.timeSliderMain.value = s;
  if (els.timeSliderViewer) els.timeSliderViewer.value = s;
}

function probeInDomain() {
  const p = app.probe;
  if (!p || p.xKm == null || p.yKm == null) return false;
  if (app.engine && typeof app.engine.isInDomain === "function") {
    return app.engine.isInDomain(p.xKm, p.yKm);
  }
  const proj = (app.meta && app.meta.projection) || {};
  const xMin = proj.x_min != null ? proj.x_min : -Infinity;
  const xMax = proj.x_max != null ? proj.x_max : Infinity;
  const yMin = proj.y_min != null ? proj.y_min : -Infinity;
  const yMax = proj.y_max != null ? proj.y_max : Infinity;
  return p.xKm >= xMin && p.xKm <= xMax && p.yKm >= yMin && p.yKm <= yMax;
}

function updateProbeChrome() {
  const p = app.probe;
  const mode = p.mode || "site";
  const inside = probeInDomain();
  if (els.profilePanel) els.profilePanel.dataset.mode = mode;
  if (els.probeBadge) {
    els.probeBadge.dataset.mode = mode;
    if (!inside) {
      els.probeBadge.textContent = `OUTSIDE · x ${Number(p.xKm).toFixed(1)} · y ${Number(p.yKm).toFixed(1)} km`;
    } else if (mode === "site") {
      els.probeBadge.textContent = `OBS SITE · ${p.siteId || "—"}`;
    } else {
      els.probeBadge.textContent = `GRID · x ${p.xKm.toFixed(1)} · y ${p.yKm.toFixed(1)} km`;
    }
  }
}

async function loadMetadata() {
  const res = await fetch("data/metadata.json");
  if (!res.ok) throw new Error("Missing data/metadata.json — run export_ghpages_portal.py");
  return res.json();
}

async function loadSounding(tag) {
  if (app.soundingCache.has(tag)) return app.soundingCache.get(tag);
  const res = await fetch(`data/soundings/${tag}.json`);
  if (!res.ok) return {};
  const js = await res.json();
  app.soundingCache.set(tag, js);
  return js;
}

function currentTime() {
  const times = app.meta.times || [];
  return times[Number(els.timeSlider.value) || 0] || null;
}

function updateTimeLabels() {
  const t = currentTime();
  const lab = t ? t.label : "—";
  if (els.timeLabel) els.timeLabel.textContent = lab;
  if (els.timeBarLabel) els.timeBarLabel.textContent = lab;
  if (els.timeLabelViewer) els.timeLabelViewer.textContent = lab;
}

function setPlayButtons(playing) {
  const icon = playing ? "❚❚" : "▶";
  if (els.btnPlay) els.btnPlay.textContent = icon;
  if (els.btnPlayViewer) els.btnPlayViewer.textContent = icon;
  if (els.btnPlayMain) els.btnPlayMain.textContent = icon;
}

/** Re-apply user iso levels after volume load (do not rebuild controls). */
function reassertIsoLevels() {
  if (!app.engine) return;
  app.engine.setIsoLevels(getLayerLevels());
  if (typeof app.engine.setLayerOpacities === "function") {
    app.engine.setLayerOpacities(getLayerOpacities());
  }
  if (els.focusSlider) app.engine.setFocusLayer(Number(els.focusSlider.value));
  updateColorbarHud();
}

function getLayerLevels() {
  const n = Number(els.nLayers.value) || 1;
  return app.layerIso.slice(0, n);
}

function getLayerOpacities() {
  const n = Number(els.nLayers.value) || 1;
  const ops = app.layerOpacity.slice(0, n);
  while (ops.length < n) ops.push(0.72);
  return ops;
}

function rebuildLayerInputs(opts) {
  const options = opts || {};
  const n = Number(els.nLayers.value) || 1;
  els.nLayersReadout.textContent = String(n);
  const range = app.engine ? app.engine.getFieldRange() : { min: 0, max: 20, unit: "" };
  const lo = range.min;
  const hi = range.max;
  while (app.layerIso.length < n) {
    const t = app.layerIso.length / Math.max(n - 1, 1);
    app.layerIso.push(lo + t * (hi - lo));
  }
  while (app.layerColors.length < n) {
    app.layerColors.push(LAYER_COLORS[app.layerColors.length % LAYER_COLORS.length]);
  }
  while (app.layerOpacity.length < n) {
    app.layerOpacity.push(0.72);
  }
  if (options.applyDefaults) {
    const defs =
      app.meta &&
      app.meta.volume &&
      app.meta.volume.default_iso_levels &&
      app.meta.volume.default_iso_levels[els.var3d.value];
    if (defs) {
      for (let i = 0; i < Math.min(n, defs.length); i += 1) app.layerIso[i] = defs[i];
    }
  }

  els.layerValues.innerHTML = "";
  for (let i = 0; i < n; i += 1) {
    const row = document.createElement("div");
    row.className = "layer-row";
    const color = document.createElement("input");
    color.type = "color";
    color.className = "layer-color";
    color.value = app.layerColors[i] || LAYER_COLORS[i % LAYER_COLORS.length];
    color.title = `Layer ${i + 1} color`;

    const num = document.createElement("input");
    num.type = "number";
    num.className = "form-control form-control-sm layer-value-num";
    num.step = String(Math.max((hi - lo) / 200, 0.01));
    num.min = String(lo);
    num.max = String(hi);
    num.value = String(Number(app.layerIso[i]).toFixed(2));
    num.title = `Layer ${i + 1} isosurface value`;

    const opWrap = document.createElement("div");
    opWrap.className = "layer-opacity-wrap";
    const opReadout = document.createElement("span");
    opReadout.className = "layer-op-readout";
    const op = Math.max(0.02, Math.min(1, Number(app.layerOpacity[i]) || 0.72));
    app.layerOpacity[i] = op;
    opReadout.textContent = op.toFixed(2);
    const opSlider = document.createElement("input");
    opSlider.type = "range";
    opSlider.className = "form-range layer-opacity";
    opSlider.min = "0.05";
    opSlider.max = "1";
    opSlider.step = "0.01";
    opSlider.value = String(op);
    opSlider.title = `Layer ${i + 1} opacity`;

    const applyVal = (v) => {
      const x = Number(v);
      if (!Number.isFinite(x)) return;
      app.layerIso[i] = x;
      num.value = String(x);
      scheduleIsoApply();
    };
    num.addEventListener("change", () => applyVal(num.value));
    num.addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyVal(num.value);
    });

    opSlider.addEventListener("input", () => {
      const o = Math.max(0.05, Math.min(1, Number(opSlider.value) || 0.72));
      app.layerOpacity[i] = o;
      opReadout.textContent = o.toFixed(2);
      if (app.engine) app.engine.setLayerOpacities(getLayerOpacities());
    });

    color.addEventListener("input", () => {
      app.layerColors[i] = color.value;
      if (app.engine) app.engine.setLayerColors(app.layerColors);
      updateColorbarHud();
    });
    color.addEventListener("click", (e) => e.stopPropagation());

    opWrap.appendChild(opReadout);
    opWrap.appendChild(opSlider);
    row.appendChild(color);
    row.appendChild(num);
    row.appendChild(opWrap);
    els.layerValues.appendChild(row);
  }
  els.focusSlider.min = "-1";
  els.focusSlider.max = String(n - 1);
  if (Number(els.focusSlider.value) > n - 1) els.focusSlider.value = "-1";
  updateFocusReadout();
  if (app.engine) {
    app.engine.setLayerColors(app.layerColors);
    app.engine.setLayerOpacities(getLayerOpacities());
  }
  scheduleIsoApply();
}

function updateFocusReadout() {
  const v = Number(els.focusSlider.value);
  if (v < 0) els.focusReadout.textContent = "all";
  else {
    const lv = getLayerLevels()[v];
    els.focusReadout.textContent = lv != null ? lv.toFixed(1) : "—";
  }
}

function scheduleIsoApply() {
  if (app.rebuildTimer) clearTimeout(app.rebuildTimer);
  app.rebuildTimer = setTimeout(() => {
    if (!app.engine) return;
    app.engine.setIsoLevels(getLayerLevels());
    if (typeof app.engine.setLayerOpacities === "function") {
      app.engine.setLayerOpacities(getLayerOpacities());
    }
    app.engine.setFocusLayer(Number(els.focusSlider.value));
    updateColorbarHud();
  }, 50);
}

function syncModeUi() {
  const mode = els.mode3d ? els.mode3d.value : "isosurface";
  const isVol = mode === "isosurface" || mode === "slice";
  const isStation = mode === "profiles" || mode === "hodographs";
  if (els.isoGroup) els.isoGroup.style.display = mode === "isosurface" ? "" : "none";
  if (els.sliceGroup) els.sliceGroup.style.display = mode === "slice" ? "" : "none";
  // Iso-layer color-from-map only applies to isosurfaces
  const colorFromRow = els.colorFromMap && els.colorFromMap.closest(".form-check");
  if (colorFromRow) colorFromRow.style.display = mode === "isosurface" ? "" : "none";
  const volToggle = document.getElementById("toggle-volume");
  if (volToggle) {
    const wrap = volToggle.closest(".form-check");
    if (wrap) wrap.style.display = isVol ? "" : "none";
  }
  // Field still drives plan underlay; note station plots are fixed-format
  if (els.var3d) {
    els.var3d.disabled = false;
    els.var3d.title = isStation
      ? "Colors the plan-map underlay only — OBS panels are fixed T·RH | WS·WD / hodograph"
      : "";
  }
  if (!isStation) hideMapSamplePopup();
}

function hideMapSamplePopup() {
  if (els.mapSamplePopup) els.mapSamplePopup.hidden = true;
}

function showMapSamplePopup(probe) {
  if (!app.engine || !els.mapSamplePopup || !els.mapSamplePopupCanvas) return;
  const mode = els.mode3d ? els.mode3d.value : "";
  if (mode !== "profiles" && mode !== "hodographs") {
    hideMapSamplePopup();
    return;
  }
  if (!probe || !Number.isFinite(probe.xKm) || !Number.isFinite(probe.yKm)) {
    hideMapSamplePopup();
    return;
  }
  if (!app.engine.isInDomain(probe.xKm, probe.yKm)) {
    hideMapSamplePopup();
    return;
  }
  const isHodo = mode === "hodographs";
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const logicalW = isHodo ? 380 : 520;
  const logicalH = isHodo ? 380 : 390;
  const built = app.engine.buildSampleCanvasAt(probe.xKm, probe.yKm, {
    mode: isHodo ? "hodograph" : "profile",
    siteId: probe.siteId || null,
    label: probe.siteId
      ? probe.siteId
      : `x=${probe.xKm.toFixed(1)} · y=${probe.yKm.toFixed(1)} km`,
    kind: probe.siteId ? "site" : "popup",
    width: logicalW,
    height: logicalH,
    pixelRatio: dpr,
  });
  if (!built || !built.canvas) {
    hideMapSamplePopup();
    return;
  }
  const dst = els.mapSamplePopupCanvas;
  dst.width = built.canvas.width;
  dst.height = built.canvas.height;
  dst.style.width = `${logicalW}px`;
  dst.style.height = "auto";
  const ctx = dst.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, dst.width, dst.height);
  ctx.drawImage(built.canvas, 0, 0);
  if (els.mapSamplePopupTitle) {
    const cubeId = els.model ? els.model.value : "";
    const cube = cubeId ? `fusion cube ${cubeId}` : "fusion cube";
    els.mapSamplePopupTitle.textContent =
      (isHodo ? "Hodograph · " : "Profile · ") + cube + " · " + built.title;
  }
  els.mapSamplePopup.hidden = false;
}

function currentViewDim() {
  return els.viewDim && els.viewDim.value === "2d" ? "2d" : "3d";
}

function syncViewDimUi() {
  const dim = currentViewDim();
  if (els.viewport3d) els.viewport3d.classList.toggle("is-2d", dim === "2d");
  if (els.viewport2d) els.viewport2d.hidden = dim !== "2d";
  if (dim === "3d" && app.engine) app.engine.resize();
}

async function refresh2dMap() {
  if (currentViewDim() !== "2d" || !app.engine) return;
  const mode = els.mode3d ? els.mode3d.value : "isosurface";
  const snap = app.engine.getPlanSliceSnapshot(planSliceIndex(), {
    probe: { xKm: app.probe.xKm, yKm: app.probe.yKm },
  });
  if (!snap) {
    await renderPlanMap("plotly-plan", null, {});
    return;
  }
  let overlay = null;
  if (mode === "profiles" || mode === "hodographs") {
    overlay = app.engine.getMapOverlayExportPayload
      ? app.engine.getMapOverlayExportPayload()
      : null;
  }
  const cubeTag = snap.model ? `fusion cube ${snap.model}` : "fusion cube";
  const title =
    mode === "profiles"
      ? `${snap.modelLabel} · ${cubeTag} profiles (T·RH | WS·WD)`
      : mode === "hodographs"
        ? `${snap.modelLabel} · ${cubeTag} hodographs`
        : snap.title;
  await renderPlanMap("plotly-plan", snap, {
    overlay,
    title,
    heatmapOpacity: mode === "profiles" || mode === "hodographs" ? 0.5 : 0.85,
  });
  wirePlanMapClick();
}

function wirePlanMapClick() {
  const el = document.getElementById("plotly-plan");
  if (!el || !window.Plotly || el._scalesPlanClick) return;
  el._scalesPlanClick = true;
  el.on("plotly_click", (ev) => {
    const mode = els.mode3d ? els.mode3d.value : "";
    if (mode !== "profiles" && mode !== "hodographs") return;
    const pt = ev && ev.points && ev.points[0];
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return;
    if (!app.engine || !app.engine.lonLatToKm) return;
    const { xKm, yKm } = app.engine.lonLatToKm(pt.x, pt.y);
    if (!app.engine.isInDomain(xKm, yKm)) return;
    const near = app.engine.nearestSite(xKm, yKm, 4.5);
    if (near && near.site) {
      setProbe(
        {
          mode: "site",
          siteId: near.site.id,
          xKm: near.site.x_km,
          yKm: near.site.y_km,
        },
        { showSamplePopup: true }
      );
    } else {
      setProbe({ mode: "grid", siteId: null, xKm, yKm }, { showSamplePopup: true });
    }
  });
}

async function sampleMergedColumn(modelId, tag, vars, xKm, yKm) {
  const out = {};
  for (const variable of vars) {
    const col = await app.engine.sampleColumn(modelId, tag, variable, xKm, yKm);
    if (!col) continue;
    if (!out.z) out.z = col.z;
    out[variable] = col[variable];
  }
  return out.z ? out : null;
}

async function gatherProfileSources(variableOrList, gen) {
  const t = currentTime();
  if (!t || !app.engine) return { sources: {}, mode: "site" };
  const vars = Array.isArray(variableOrList) ? variableOrList : [variableOrList];
  const enabled = enabledSources();
  const sources = {};
  const p = app.probe;

  function hasAll(src) {
    if (!src || !src.z || !Array.isArray(src.z)) return false;
    return vars.every((v) => Array.isArray(src[v]) && src[v].length > 0);
  }

  // UAS only from site soundings
  if (p.mode === "site" && p.siteId && enabled.includes("UAS")) {
    const pack = await loadSounding(t.tag);
    if (gen !== app.refreshGen) return null;
    const raw =
      pack[p.siteId] && pack[p.siteId].sources && pack[p.siteId].sources.UAS;
    if (raw && hasAll(raw)) sources.UAS = raw;
  }

  // A / B / C / HRRR always from the matching volume at the probe column
  // so series chips reliably toggle the cube fields (same as 3D fusion cubes)
  for (const key of enabled) {
    if (key === "UAS") continue;
    const mid = MODEL_SRC[key];
    if (!mid) continue;
    const col = await sampleMergedColumn(mid, t.tag, vars, p.xKm, p.yKm);
    if (gen !== app.refreshGen) return null;
    if (col && hasAll(col)) sources[key] = col;
  }

  return { sources, mode: p.mode };
}

function highlightSourceKey() {
  const mid = (els.model && els.model.value) || "";
  if (mid === "hrrr" || mid === "HRRR") return "HRRR";
  if (mid === "A" || mid === "B" || mid === "C") return mid;
  return mid;
}

function clearSeriesOutsideDomain(variable, height, viewMode) {
  const p = app.probe;
  const mode = (p && p.mode) || "grid";
  const coord =
    p && p.xKm != null && p.yKm != null
      ? `x=${Number(p.xKm).toFixed(1)} y=${Number(p.yKm).toFixed(1)} km`
      : "—";
  if (els.profileSubtitle) {
    els.profileSubtitle.textContent = `Outside domain · ${coord}`;
  }
  if (els.tsSubtitle) {
    els.tsSubtitle.textContent = `Outside domain · ${variable} @ ${height} m`;
  }
  const emptyMsg = "Probe outside domain";
  const legendId = "profile-legend";
  if (viewMode === "hodograph") {
    SoundingPlotter.renderHodograph("plotly-sounding", {
      sources: {},
      enabled: [],
      mode,
      emptyText: emptyMsg,
      legendId,
      maxR: 20,
    });
  } else {
    SoundingPlotter.renderSounding("plotly-sounding", {
      sources: {},
      enabled: [],
      variable,
      mode,
      emptyText: emptyMsg,
      legendId,
    });
  }
  SoundingPlotter.renderTimeSeries("plotly-ts", [], {
    ylabel: variable,
    mode,
    emptyText: emptyMsg,
  });
}

async function refreshSeries() {
  const gen = ++app.refreshGen;
  updateProbeChrome();
  const t = currentTime();
  const variable = els.seriesVar.value;
  const height = Number(els.tsHeight.value);
  els.tsHeightReadout.textContent = `${height} m`;
  const enabled = enabledSources();
  const palette = currentSeriesPalette();
  const p = app.probe;
  const axisOpts = profileAxisRanges();
  const viewMode =
    (els.profileViewMode && els.profileViewMode.value) || "profile";

  if (!probeInDomain()) {
    clearSeriesOutsideDomain(variable, height, viewMode);
    return;
  }

  const need = viewMode === "hodograph" ? ["u_wind", "v_wind"] : [variable];
  const packed = await gatherProfileSources(need, gen);
  if (!packed || gen !== app.refreshGen) return;
  const { sources, mode } = packed;

  const title =
    mode === "site"
      ? `${p.siteId || "site"}${t ? " · " + t.label : ""}`
      : `Grid x=${p.xKm.toFixed(1)} y=${p.yKm.toFixed(1)} km${t ? " · " + t.label : ""}`;

  if (els.profileSubtitle) {
    els.profileSubtitle.textContent =
      viewMode === "hodograph" ? `Hodo · ${title}` : title;
  }

  const highlight = highlightSourceKey();
  if (viewMode === "hodograph") {
    if (typeof SoundingPlotter.renderHodograph !== "function") {
      console.error("SoundingPlotter.renderHodograph missing — hard-refresh the page");
      return;
    }
    SoundingPlotter.renderHodograph("plotly-sounding", {
      sources,
      enabled,
      mode,
      highlight,
      palette,
      legendId: "profile-legend",
      maxR: 20,
    });
  } else {
    SoundingPlotter.renderSounding("plotly-sounding", {
      sources,
      enabled,
      variable,
      mode,
      highlight,
      palette,
      legendId: "profile-legend",
      ...axisOpts,
    });
  }
  // Time series at height for same location / sources
  if (els.tsSubtitle) {
    els.tsSubtitle.textContent =
      mode === "site"
        ? `${p.siteId || "site"} · ${variable} @ ${height} m`
        : `grid · ${variable} @ ${height} m · (${p.xKm.toFixed(1)}, ${p.yKm.toFixed(1)})`;
  }

  const series = [];
  for (const key of enabled) {
    if (mode === "grid" && key === "UAS") continue;
    const times = [];
    const values = [];
    for (const tt of app.meta.times || []) {
      times.push(tt.label.replace(" UTC", "").slice(5));
      let v = null;
      if (key === "UAS" && mode === "site" && p.siteId) {
        const pack = await loadSounding(tt.tag);
        if (gen !== app.refreshGen) return;
        const col =
          pack[p.siteId] && pack[p.siteId].sources && pack[p.siteId].sources.UAS;
        if (col) v = SoundingPlotter.valueAtHeight(col, variable, height);
      } else if (key !== "UAS") {
        const mid = MODEL_SRC[key];
        if (mid) {
          const col = await app.engine.sampleColumn(
            mid,
            tt.tag,
            variable,
            p.xKm,
            p.yKm
          );
          if (gen !== app.refreshGen) return;
          v = SoundingPlotter.valueAtHeight(col, variable, height);
        }
      }
      values.push(v);
    }
    series.push({
      name: key,
      color: palette[key] || "#94a3b8",
      times,
      values,
      dash: key === "HRRR" ? "dash" : "solid",
      width: key === "UAS" ? 2.6 : 2,
      markerSize: key === "UAS" ? 6 : 4,
    });
  }

  if (gen !== app.refreshGen) return;
  const tsOpts = {
    ylabel: variable,
    mode,
  };
  const yRange = tsAxisRange();
  if (yRange) tsOpts.yRange = yRange;
  SoundingPlotter.renderTimeSeries("plotly-ts", series, tsOpts);
}

async function updateSiteObsAvailability() {
  if (!app.engine || !app.meta) return;
  const t = currentTime();
  if (!t) return;
  const pack = await loadSounding(t.tag);
  const map = {};
  const uasBySite = {};
  (app.meta.sites || []).forEach((s) => {
    const uas =
      pack[s.id] && pack[s.id].sources && pack[s.id].sources.UAS
        ? pack[s.id].sources.UAS
        : null;
    const hasZ = !!(uas && Array.isArray(uas.z) && uas.z.length > 0);
    let hasVal = false;
    if (hasZ && uas) {
      for (const key of [
        "temperature",
        "wind_speed",
        "u_wind",
        "v_wind",
        "relative_humidity",
      ]) {
        const arr = uas[key];
        if (!Array.isArray(arr)) continue;
        if (arr.some((v) => v != null && Number.isFinite(Number(v)))) {
          hasVal = true;
          break;
        }
      }
    }
    map[s.id] = hasZ && hasVal;
    if (hasZ && hasVal) uasBySite[s.id] = uas;
  });
  app.engine.setSiteObsAvailability(map);
  if (typeof app.engine.setObsSoundings === "function") {
    app.engine.setObsSoundings(uasBySite);
  }
  // Refresh open popup only — never auto-open on data refresh
  const mode = els.mode3d ? els.mode3d.value : "";
  if (
    (mode === "profiles" || mode === "hodographs") &&
    els.mapSamplePopup &&
    !els.mapSamplePopup.hidden
  ) {
    showMapSamplePopup(app.probe);
  }
}

async function onTimeOrModelChange() {
  updateTimeLabels();
  if (app.engine) {
    await app.engine.setModelAndTime(
      els.model.value,
      Number(els.timeSlider.value) || 0
    );
    // Keep user-chosen iso thresholds/colors; only reassert after new volume decode
    reassertIsoLevels();
    fillColorLimitPlaceholders();
    const nz = app.engine.getNz();
    els.sliceSlider.max = String(Math.max(nz - 1, 0));
    els.sliceReadout.textContent = `${app.engine.getZm(Number(els.sliceSlider.value)).toFixed(0)} m`;
    // Update drawn transect / time–height against the new valid time / model / field
    if (currentSectionMode() === "timeheight") {
      refreshSectionPanel();
    } else if (app.engine.hasSection()) {
      app.engine.refreshSection();
    }
  }
  await Promise.all([refreshSeries(), updateSiteObsAvailability()]);
  updateColorbarHud();
  await refresh2dMap();
}

function setProbe(probe, opts) {
  const o = opts || {};
  app.probe = {
    mode: probe.mode,
    siteId: probe.siteId || null,
    xKm: probe.xKm,
    yKm: probe.yKm,
  };
  if (probe.mode === "site" && probe.siteId && els.site) {
    els.site.value = probe.siteId;
  }
  updateProbeChrome();
  if (app.engine) {
    app.engine.setProbeMarker(probe.xKm, probe.yKm, probe.mode);
  }
  refreshSeries();
  if (currentSectionMode() === "timeheight") refreshSectionPanel();
  if (currentViewDim() === "2d") refresh2dMap();
  // Popup only on explicit map click (opts.showSamplePopup)
  if (o.showSamplePopup) showMapSamplePopup(app.probe);
  else if (els.mapSamplePopup && !els.mapSamplePopup.hidden) {
    // Keep an already-open popup in sync with the new probe
    showMapSamplePopup(app.probe);
  }
}

function populateModels(models) {
  els.model.innerHTML = "";
  const list = (models || []).slice().sort((a, b) => {
    const la = String(a.label || a.id || "").toLowerCase();
    const lb = String(b.label || b.id || "").toLowerCase();
    return la.localeCompare(lb, undefined, { sensitivity: "base" });
  });
  list.forEach((m) => {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.label || m.id;
    if (m.id === "A") o.selected = true;
    els.model.appendChild(o);
  });
}

function populateSites(sites) {
  els.site.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "Jump to site…";
  els.site.appendChild(opt0);
  (sites || []).forEach((s) => {
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.name || s.id;
    els.site.appendChild(o);
  });
}

function populateVariables(variables) {
  els.var3d.innerHTML = "";
  (variables || []).forEach((v) => {
    const o = document.createElement("option");
    o.value = v.id;
    o.textContent = `${v.label}`;
    if (v.id === "wind_speed") o.selected = true;
    els.var3d.appendChild(o);
  });
}

function startPlay() {
  if (app.playing) return;
  app.playing = true;
  setPlayButtons(true);
  app.playTimer = setInterval(() => {
    const max = Number(els.timeSlider.max) || 0;
    let next = (Number(els.timeSlider.value) || 0) + 1;
    if (next > max) next = 0;
    syncTimeSliders(next);
    onTimeOrModelChange();
  }, 1400);
}

function stopPlay() {
  app.playing = false;
  setPlayButtons(false);
  if (app.playTimer) clearInterval(app.playTimer);
  app.playTimer = null;
}

function currentViewerMode() {
  return document.body.dataset.viewer === "classic" ? "classic" : "network";
}

async function setViewerMode(mode) {
  const classic = mode === "classic";
  document.body.dataset.viewer = classic ? "classic" : "network";
  const networkBtn = document.getElementById("btn-viewer-network");
  const classicBtn = document.getElementById("btn-viewer-classic");
  if (networkBtn) networkBtn.classList.toggle("active", !classic);
  if (classicBtn) classicBtn.classList.toggle("active", classic);
  const layout = document.querySelector(".layout");
  const classicRoot = document.getElementById("classic-root");
  const brand = document.getElementById("app-brand");
  if (layout) layout.hidden = classic;
  if (classicRoot) classicRoot.hidden = !classic;
  if (brand) brand.textContent = classic ? "2D Site Viewer" : "3D Network Viewer";
  if (classic) {
    stopPlay();
    if (app.meta) {
      await initClassicViewer(app.meta);
      requestAnimationFrame(() => resizeClassicViewer());
    }
  } else if (app.engine) {
    app.engine.resize();
  }
}

/** Step valid time by ±1 index. Clamps at ends. */
function stepTime(delta) {
  const times = (app.meta && app.meta.times) || [];
  if (!times.length) return;
  const max = times.length - 1;
  const cur = Number(
    (els.timeSlider && els.timeSlider.value) ||
      (els.timeSliderViewer && els.timeSliderViewer.value) ||
      0
  );
  const next = Math.max(0, Math.min(max, cur + delta));
  if (next === cur) return;
  if (app.playing) stopPlay();
  syncTimeSliders(next);
  onTimeOrModelChange();
}

/** True only when keys would edit text — not range/checkbox/color/etc. */
function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "select") return true;
  if (tag !== "input") return false;
  const type = String(el.type || "text").toLowerCase();
  return (
    type === "text" ||
    type === "number" ||
    type === "search" ||
    type === "email" ||
    type === "password" ||
    type === "url" ||
    type === "tel" ||
    type === ""
  );
}

function onTimeHotkey(e) {
  if (e.defaultPrevented) return;
  if (document.body.dataset.viewer === "classic") return;
  if (els.helpModal && !els.helpModal.hidden) {
    if (e.key === "Escape") els.helpModal.hidden = true;
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;

  const k = e.key;
  const code = e.code;
  // Accept < > , . and left/right arrows
  const earlier =
    k === "<" ||
    k === "," ||
    k === "ArrowLeft" ||
    code === "Comma" ||
    code === "LessThan" ||
    code === "ArrowLeft";
  const later =
    k === ">" ||
    k === "." ||
    k === "ArrowRight" ||
    code === "Period" ||
    code === "GreaterThan" ||
    code === "ArrowRight";
  if (!earlier && !later) return;
  e.preventDefault();
  stepTime(earlier ? -1 : 1);
}

// Bind immediately so shortcuts work even if later init work is slow/cached oddly
window.addEventListener("keydown", onTimeHotkey, true);

async function init() {
  app.engine = createEngine(document.getElementById("viewport3d"));
  app.engine.onStatus = (msg) => {
    els.viewStatus.textContent = msg;
  };
  app.engine.onSection = (section) => {
    if (currentSectionMode() !== "spatial") return;
    SoundingPlotter.renderCrossSection("plotly-section", section, {
      kind: "spatial",
      colorscale: plotlyColorscaleName(),
      unit: (app.engine.getFieldRange() || {}).unit || "",
    });
    setSectionButtonActive(false);
    setClearSectionEnabled(true);
    if (els.sectionSubtitle) {
      els.sectionSubtitle.textContent = section
        ? `Spatial · ${section.dist.toFixed(1)} km · ${section.variable}`
        : "Spatial transect in the 3D view";
    }
  };
  app.engine.onSectionCleared = () => {
    if (currentSectionMode() === "spatial") {
      SoundingPlotter.renderCrossSection("plotly-section", null, {
        kind: "spatial",
      });
      if (els.sectionSubtitle) {
        els.sectionSubtitle.textContent = "Draw a transect in the 3D view";
      }
    }
    setClearSectionEnabled(false);
  };
  app.engine.onDrawModeChange = (mode) => {
    setSectionButtonActive(mode === "section");
  };
  app.engine.onProbe = (probe) => {
    setProbe(probe, { showSamplePopup: true });
    const label =
      probe.mode === "site"
        ? `Probe: site ${probe.siteId}`
        : `Probe: grid (${probe.xKm.toFixed(1)}, ${probe.yKm.toFixed(1)}) km`;
    els.viewStatus.textContent = label;
  };
  app.engine.onPoll = (sample) => {
    updatePollHud(sample);
  };

  try {
    app.meta = await loadMetadata();
  } catch (err) {
    if (els.headerMeta) els.headerMeta.textContent = "NO DATA — run export";
    if (els.viewStatus) els.viewStatus.textContent = String(err.message || err);
    if (els.btnHelp) els.btnHelp.title = String(err.message || err);
    return;
  }

  const nSites = (app.meta.sites || []).length;
  els.headerMeta.textContent = `${app.meta.network} · ${app.meta.region} · ${nSites} profilers`;

  populateModels(app.meta.models);
  syncSeriesChipsToFusion();
  populateSites(app.meta.sites);
  populateVariables(app.meta.variables);

  const times = app.meta.times || [];
  const maxT = Math.max(times.length - 1, 0);
  els.timeSlider.min = "0";
  els.timeSlider.max = String(maxT);
  if (els.timeSliderViewer) {
    els.timeSliderViewer.min = "0";
    els.timeSliderViewer.max = String(maxT);
  }
  let mid = Math.floor(times.length / 2);
  times.forEach((t, i) => {
    if (t.tag && t.tag.includes("0400")) mid = i;
  });
  syncTimeSliders(mid);

  if (app.meta.volume && app.meta.volume.default_iso_levels) {
    const d = app.meta.volume.default_iso_levels.wind_speed;
    if (d) app.layerIso = d.slice();
  }

  // default vert exag slightly higher for DEM readability
  if (els.vertScale) {
    els.vertScale.value = "25";
    els.vertReadout.textContent = "25×";
  }

  // default probe: first preferred site if present
  const prefer = ["OKEM", "STILL", "WASH"];
  let startSite = (app.meta.sites || [])[0];
  for (const id of prefer) {
    const s = (app.meta.sites || []).find((x) => x.id === id);
    if (s) {
      startSite = s;
      break;
    }
  }
  if (startSite) {
    app.probe = {
      mode: "site",
      siteId: startSite.id,
      xKm: startSite.x_km,
      yKm: startSite.y_km,
    };
    els.site.value = startSite.id;
  }

  await app.engine.setMeta(app.meta);
  if (els.vertScale) app.engine.setVertExag(Number(els.vertScale.value));
  if (startSite) app.engine.setProbeMarker(startSite.x_km, startSite.y_km, "site");
  updateProbeChrome();
  updateColorbarHud();

  els.timeSlider.addEventListener("input", () => {
    syncTimeSliders(els.timeSlider.value);
    onTimeOrModelChange();
  });
  if (els.timeSliderViewer) {
    els.timeSliderViewer.addEventListener("input", () => {
      syncTimeSliders(els.timeSliderViewer.value);
      onTimeOrModelChange();
    });
  }
  els.model.addEventListener("change", () => {
    syncSeriesChipsToFusion();
    onTimeOrModelChange();
  });
  els.var3d.addEventListener("change", () => {
    app.engine.setVariable(els.var3d.value);
    if (app.engine.setMapOverlayVariable) {
      app.engine.setMapOverlayVariable(els.var3d.value);
    }
    // Reset color limits to new field data range (clear overrides)
    if (els.colorVmin) els.colorVmin.value = "";
    if (els.colorVmax) els.colorVmax.value = "";
    syncColorScaleToEngine();
    rebuildLayerInputs({ applyDefaults: true });
    fillColorLimitPlaceholders();
    updateColorbarHud();
    refreshSectionPanel();
    refresh2dMap();
  });
  els.mode3d.addEventListener("change", () => {
    syncModeUi();
    app.engine.setMode(els.mode3d.value);
    updateColorbarHud();
    refresh2dMap();
    // Never auto-open popup when switching into profile/hodo — wait for a click
    hideMapSamplePopup();
  });
  if (els.mapSamplePopupClose) {
    els.mapSamplePopupClose.addEventListener("click", hideMapSamplePopup);
  }
  if (els.viewDim) {
    els.viewDim.addEventListener("change", () => {
      syncViewDimUi();
      refresh2dMap();
    });
  }
  if (els.colormapSelect) {
    els.colormapSelect.addEventListener("change", () => {
      syncColorScaleToEngine();
      if (els.colorFromMap && els.colorFromMap.checked) {
        const r = app.engine.getFieldRange();
        const levels = getLayerLevels();
        app.layerColors = levels.map((lv) =>
          colorHexForValue(lv, r.min, r.max, els.colormapSelect.value)
        );
        rebuildLayerInputs({ applyDefaults: false });
      }
      if (currentSectionMode() === "timeheight") refreshSectionPanel();
      else if (app.engine && app.engine.hasSection()) app.engine.refreshSection();
    });
  }
  ["change"].forEach((evName) => {
    if (els.colorVmin) els.colorVmin.addEventListener(evName, () => syncColorScaleToEngine());
    if (els.colorVmax) els.colorVmax.addEventListener(evName, () => syncColorScaleToEngine());
  });
  if (els.btnApplyContours) {
    els.btnApplyContours.addEventListener("click", applyContourInterval);
  }
  if (els.contourInterval) {
    els.contourInterval.addEventListener("keydown", (e) => {
      if (e.key === "Enter") applyContourInterval();
    });
  }
  if (els.colorFromMap) {
    els.colorFromMap.addEventListener("change", () => {
      syncColorScaleToEngine();
      if (els.colorFromMap.checked) {
        const r = app.engine.getFieldRange();
        const levels = getLayerLevels();
        const mapName = els.colormapSelect.value;
        app.layerColors = levels.map((lv) =>
          colorHexForValue(lv, r.min, r.max, mapName)
        );
        rebuildLayerInputs({ applyDefaults: false });
      }
      updateColorbarHud();
    });
  }
  if (els.pollCursor) {
    els.pollCursor.addEventListener("change", () => {
      app.engine.setPollEnabled(els.pollCursor.checked);
      if (!els.pollCursor.checked) updatePollHud(null);
    });
  }
  if (els.pollHeight) {
    els.pollHeight.addEventListener("input", () => {
      const h = Number(els.pollHeight.value);
      if (els.pollHeightReadout) els.pollHeightReadout.textContent = `${h} m`;
      app.engine.setPollHeightM(h);
      if (currentViewDim() === "2d") refresh2dMap();
    });
  }
  els.nLayers.addEventListener("input", () => rebuildLayerInputs());
  els.focusSlider.addEventListener("input", () => {
    updateFocusReadout();
    app.engine.setFocusLayer(Number(els.focusSlider.value));
    // Focus remeshes; reassert layer opacities already on engine state
  });
  els.sliceSlider.addEventListener("input", () => {
    const k = Number(els.sliceSlider.value);
    els.sliceReadout.textContent = `${app.engine.getZm(k).toFixed(0)} m`;
    app.engine.setSliceK(k);
  });
  if (els.opacitySlider) {
    els.opacitySlider.addEventListener("input", () => {
      const o = Number(els.opacitySlider.value);
      if (els.opacityReadout) els.opacityReadout.textContent = o.toFixed(2);
      app.engine.setOpacity(o);
    });
  }
  function applyTerrainOpacity(v) {
    const o = Math.max(0.05, Math.min(1, Number(v)));
    if (!Number.isFinite(o)) return;
    if (els.terrainOpacity) els.terrainOpacity.value = String(o);
    if (els.terrainOpacityNum) els.terrainOpacityNum.value = String(o);
    if (els.terrainOpacityReadout) els.terrainOpacityReadout.textContent = o.toFixed(2);
    app.engine.setTerrainOpacity(o);
  }
  if (els.terrainOpacity) {
    els.terrainOpacity.addEventListener("input", () => applyTerrainOpacity(els.terrainOpacity.value));
  }
  if (els.terrainOpacityNum) {
    els.terrainOpacityNum.addEventListener("change", () =>
      applyTerrainOpacity(els.terrainOpacityNum.value)
    );
  }
  els.vertScale.addEventListener("input", () => {
    const v = Number(els.vertScale.value);
    els.vertReadout.textContent = `${v}×`;
    app.engine.setVertExag(v);
    if (app.probe) {
      app.engine.setProbeMarker(app.probe.xKm, app.probe.yKm, app.probe.mode);
    }
  });
  if (els.zMode) {
    els.zMode.addEventListener("change", () => {
      app.engine.setZMode(els.zMode.value);
      if (app.probe) {
        app.engine.setProbeMarker(app.probe.xKm, app.probe.yKm, app.probe.mode);
      }
    });
  }

  document.getElementById("toggle-volume").addEventListener("change", (e) =>
    app.engine.setLayer("volume", e.target.checked)
  );
  document.getElementById("toggle-terrain").addEventListener("change", (e) => {
    app.engine.setLayer("terrain", e.target.checked);
    updateColorbarHud();
  });
  document.getElementById("toggle-geo").addEventListener("change", (e) =>
    app.engine.setLayer("geo", e.target.checked)
  );
  document.getElementById("toggle-sites").addEventListener("change", (e) =>
    app.engine.setLayer("sites", e.target.checked)
  );
  document.getElementById("toggle-axes").addEventListener("change", (e) =>
    app.engine.setLayer("axes", e.target.checked)
  );
  document.getElementById("toggle-colorbar").addEventListener("change", () =>
    updateColorbarHud()
  );

  els.btnSection.addEventListener("click", () => {
    if (currentSectionMode() !== "spatial") return;
    if (app.engine.state.drawMode === "section") {
      app.engine.setDrawMode(null);
      els.viewStatus.textContent = "Section drawing cancelled";
      return;
    }
    app.engine.setDrawMode("section");
    els.viewStatus.textContent = "Click two ground points for a cross-section";
  });
  if (els.btnClearSection) {
    els.btnClearSection.addEventListener("click", () => {
      app.engine.clearSection();
      setClearSectionEnabled(false);
    });
  }
  if (els.sectionMode) {
    els.sectionMode.addEventListener("change", () => {
      syncSectionModeUi();
      refreshSectionPanel().catch((err) => {
        console.error(err);
        if (els.sectionSubtitle) {
          els.sectionSubtitle.textContent = `Time–height error: ${err.message || err}`;
        }
      });
    });
  }

  els.site.addEventListener("change", () => {
    const id = els.site.value;
    if (!id) return;
    const s = (app.meta.sites || []).find((x) => x.id === id);
    if (s) setProbe({ mode: "site", siteId: s.id, xKm: s.x_km, yKm: s.y_km });
  });
  els.seriesVar.addEventListener("change", refreshSeries);
  if (els.profileViewMode) {
    els.profileViewMode.addEventListener("change", refreshSeries);
  }
  function applyTsHeight(v) {
    const h = Math.max(0, Math.min(1500, Number(v)));
    if (!Number.isFinite(h)) return;
    els.tsHeight.value = String(h);
    if (els.tsHeightNum) els.tsHeightNum.value = String(h);
    els.tsHeightReadout.textContent = `${h} m`;
    refreshSeries();
  }
  els.tsHeight.addEventListener("input", () => applyTsHeight(els.tsHeight.value));
  if (els.tsHeightNum) {
    els.tsHeightNum.addEventListener("change", () => applyTsHeight(els.tsHeightNum.value));
  }
  document.querySelectorAll(".series-src").forEach((el) => {
    el.addEventListener("change", () => {
      syncSrcChipStyles();
      refreshSeries();
    });
  });
  syncSrcChipStyles();
  // Color pickers: only refresh plots when selection commits (not continuous OS drag/input)
  document.querySelectorAll(".series-color").forEach((el) => {
    el.addEventListener("click", (e) => e.stopPropagation());
    el.addEventListener("change", () => refreshSeries());
  });
  ["prof-xmin", "prof-xmax", "prof-zmin", "prof-zmax", "ts-ymin", "ts-ymax"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", refreshSeries);
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") refreshSeries();
      });
    }
  });

  function togglePlay() {
    if (app.playing) stopPlay();
    else startPlay();
  }
  els.btnPlay.addEventListener("click", togglePlay);
  if (els.btnPlayViewer) els.btnPlayViewer.addEventListener("click", togglePlay);
  const bindTimeStep = (el, delta) => {
    if (!el) return;
    el.addEventListener("click", () => stepTime(delta));
  };
  bindTimeStep(els.btnTimePrev, -1);
  bindTimeStep(els.btnTimeNext, 1);
  bindTimeStep(els.btnTimePrevSettings, -1);
  bindTimeStep(els.btnTimeNextSettings, 1);
  els.camReset.addEventListener("click", () => app.engine.setCameraPreset("reset"));
  els.camTop.addEventListener("click", () => app.engine.setCameraPreset("top"));
  els.camSide.addEventListener("click", () => app.engine.setCameraPreset("side"));

  function updateCompass() {
    if (!els.compassNeedle || !app.engine) return;
    const deg = app.engine.getCompassRotationDeg();
    els.compassNeedle.style.transform = `rotate(${deg}deg)`;
    requestAnimationFrame(updateCompass);
  }
  updateCompass();

  function updateControlsScrollHint() {
    const panel = els.controlsPanel;
    if (!panel) return;
    const shell = panel.closest(".controls-shell") || panel;
    const atEnd = panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 8;
    const noScroll = panel.scrollHeight <= panel.clientHeight + 4;
    shell.classList.toggle("is-scrolled-end", atEnd || noScroll);
  }
  if (els.controlsPanel) {
    els.controlsPanel.addEventListener("scroll", updateControlsScrollHint, { passive: true });
    window.addEventListener("resize", updateControlsScrollHint);
    setTimeout(updateControlsScrollHint, 100);
  }

  window.addEventListener("resize", () => {
    if (currentViewerMode() === "classic") {
      resizeClassicViewer();
      return;
    }
    if (app.engine) app.engine.resize();
    ["plotly-sounding", "plotly-ts", "plotly-section", "plotly-plan"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && window.Plotly) Plotly.Plots.resize(el);
    });
  });

  document.querySelectorAll("[data-viewer-mode]").forEach((btn) => {
    btn.addEventListener("click", () => setViewerMode(btn.getAttribute("data-viewer-mode")));
  });

  if (els.btnHelp && els.helpModal) {
    const openHelp = () => {
      els.helpModal.hidden = false;
    };
    const closeHelp = () => {
      els.helpModal.hidden = true;
    };
    els.btnHelp.addEventListener("click", openHelp);
    els.helpModal.querySelectorAll("[data-help-close]").forEach((el) => {
      el.addEventListener("click", closeHelp);
    });
  }

  wireExportUi();

  // keydown bound at module load (onTimeHotkey)

  if (els.terrainOpacity) applyTerrainOpacity(els.terrainOpacity.value);
  syncModeUi();
  syncViewDimUi();
  syncColorScaleToEngine();
  rebuildLayerInputs({ applyDefaults: true });
  updateColorbarHud();
  SoundingPlotter.renderCrossSection("plotly-section", null, {});
  await onTimeOrModelChange();
  fillColorLimitPlaceholders();
  syncSectionModeUi();
  if (currentSectionMode() === "timeheight") refreshSectionPanel();
}

init();
