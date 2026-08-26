/**
 * Figure export helpers: Plotly panels (publication PNG), plan-view map figures,
 * and WebGL viewport captures for 3D isosurfaces / slices.
 */
import { COLORMAPS, contourLevels } from "./marching_cubes.js?v=20260822n";

function sanitizeFilename(s) {
  return String(s || "figure")
    .replace(/[^\w.\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 120);
}

function triggerDownload(dataUrlOrBlob, filename) {
  const a = document.createElement("a");
  a.download = sanitizeFilename(filename);
  if (typeof dataUrlOrBlob === "string") {
    a.href = dataUrlOrBlob;
  } else {
    a.href = URL.createObjectURL(dataUrlOrBlob);
  }
  document.body.appendChild(a);
  a.click();
  a.remove();
  if (typeof dataUrlOrBlob !== "string") {
    setTimeout(() => URL.revokeObjectURL(a.href), 2500);
  }
}

function plotlyColorscale(mapName) {
  const stops = COLORMAPS[mapName] || COLORMAPS.viridis;
  const n = stops.length;
  return stops.map((rgb, i) => {
    const t = n <= 1 ? 0 : i / (n - 1);
    const r = Math.round(rgb[0] * 255);
    const g = Math.round(rgb[1] * 255);
    const b = Math.round(rgb[2] * 255);
    return [t, `rgb(${r},${g},${b})`];
  });
}

/** Light publication chrome for exported Plotly figures. */
function publicationLayoutPatch(layout, opts) {
  const o = opts || {};
  const titleText =
    o.title ||
    (layout && layout.title && (layout.title.text || layout.title)) ||
    "";
  return Object.assign({}, layout || {}, {
    paper_bgcolor: "#ffffff",
    plot_bgcolor: "#ffffff",
    font: { family: "IBM Plex Sans, DejaVu Sans, sans-serif", color: "#1e293b", size: 12 },
    title: titleText
      ? {
          text: titleText,
          font: { size: 14, color: "#0f172a" },
          x: 0.5,
          xanchor: "center",
        }
      : undefined,
    xaxis: Object.assign({}, (layout && layout.xaxis) || {}, {
      color: "#334155",
      gridcolor: "#e2e8f0",
      zerolinecolor: "#94a3b8",
      linecolor: "#64748b",
      tickfont: { size: 11, color: "#334155" },
      title: Object.assign(
        {},
        typeof (layout && layout.xaxis && layout.xaxis.title) === "object"
          ? layout.xaxis.title
          : { text: (layout && layout.xaxis && layout.xaxis.title) || "" },
        { font: { size: 12, color: "#1e293b" } }
      ),
    }),
    yaxis: Object.assign({}, (layout && layout.yaxis) || {}, {
      color: "#334155",
      gridcolor: "#e2e8f0",
      zerolinecolor: "#94a3b8",
      linecolor: "#64748b",
      tickfont: { size: 11, color: "#334155" },
      title: Object.assign(
        {},
        typeof (layout && layout.yaxis && layout.yaxis.title) === "object"
          ? layout.yaxis.title
          : { text: (layout && layout.yaxis && layout.yaxis.title) || "" },
        { font: { size: 12, color: "#1e293b" } }
      ),
    }),
    legend: Object.assign({}, (layout && layout.legend) || {}, {
      bgcolor: "rgba(255,255,255,0.92)",
      bordercolor: "#cbd5e1",
      borderwidth: 1,
      font: { size: 11, color: "#1e293b" },
    }),
    margin: Object.assign({ l: 56, r: 28, t: 48, b: 48 }, (layout && layout.margin) || {}),
    annotations: ((layout && layout.annotations) || []).map((ann) =>
      Object.assign({}, ann, {
        font: Object.assign({}, ann.font || {}, { color: ann.font && ann.font.color === "#94a3b8" ? "#64748b" : (ann.font && ann.font.color) || "#334155" }),
      })
    ),
  });
}

/**
 * Export an on-screen Plotly div as a publication-style PNG.
 */
async function exportPlotlyPanel(elId, filename, opts) {
  const o = opts || {};
  if (!window.Plotly) throw new Error("Plotly not loaded");
  const gd = typeof elId === "string" ? document.getElementById(elId) : elId;
  if (!gd || !gd.data) throw new Error("No plot to export");
  const width = o.width || 1100;
  const height = o.height || 700;
  const scale = o.scale || 2;
  const data = gd.data.map((tr) => {
    const copy = Object.assign({}, tr);
    if (copy.colorbar) {
      copy.colorbar = Object.assign({}, copy.colorbar, {
        tickfont: { size: 11, color: "#334155" },
        title: Object.assign(
          {},
          typeof copy.colorbar.title === "object" ? copy.colorbar.title : { text: copy.colorbar.title || "" },
          { font: { size: 12, color: "#1e293b" } }
        ),
      });
    }
    return copy;
  });
  const layout = publicationLayoutPatch(gd.layout, { title: o.title });
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-10000px;top:0;width:" + width + "px;height:" + height + "px;opacity:0;pointer-events:none;";
  document.body.appendChild(host);
  try {
    await Plotly.newPlot(host, data, layout, { displayModeBar: false, staticPlot: true });
    const url = await Plotly.toImage(host, { format: "png", width, height, scale });
    triggerDownload(url, filename.endsWith(".png") ? filename : `${filename}.png`);
  } finally {
    try {
      Plotly.purge(host);
    } catch (_) {
      /* ignore */
    }
    host.remove();
  }
}

/**
 * Build a matplotlib-style plan-view map (lon–lat heatmap + geo + sites) and download PNG.
 * @param {object} snap — from engine.getPlanSliceSnapshot(k)
 */

/**
 * Build Plotly traces + layout for a plan map (heatmap + geo + optional profile/hodo insets).
 * @param {object} snap
 * @param {object} [opts] theme: 'publication' | 'viewer'; overlay, showHeatmap, title
 */
function buildPlanMapFigure(snap, opts) {
  const o = opts || {};
  if (!snap || !snap.grid) throw new Error("No plan-slice data");

  const theme = o.theme === "viewer" ? "viewer" : "publication";
  const isDark = theme === "viewer";
  const colorscale = plotlyColorscale(snap.mapName || "viridis");
  const zmin = snap.vmin;
  const zmax = snap.vmax;
  const unit = snap.unit || "";
  const title = o.title || snap.title;
  const showHeatmap = o.showHeatmap !== false;

  const ink = isDark ? "#e2e8f0" : "#0f172a";
  const muted = isDark ? "#94a3b8" : "#64748b";
  const gridCol = isDark ? "#334155" : "#e2e8f0";
  const paper = isDark ? "rgba(0,0,0,0)" : "#ffffff";
  const plotBg = isDark ? "rgba(11,18,32,0.55)" : "#ffffff";
  const stateCol = isDark ? "#f8fafc" : "#0f172a";
  const countyCol = isDark ? "#64748b" : "#94a3b8";
  const hwyCol = isDark ? "#94a3b8" : "#475569";

  const traces = [];
  if (showHeatmap) {
    traces.push({
      type: "heatmap",
      z: snap.grid,
      x: snap.lon,
      y: snap.lat,
      colorscale,
      zmin,
      zmax,
      zsmooth: false,
      opacity: o.heatmapOpacity != null ? o.heatmapOpacity : isDark ? 0.85 : 1,
      colorbar: {
        title: { text: unit, font: { size: 11, color: ink } },
        thickness: 12,
        len: 0.65,
        tickfont: { size: 10, color: muted },
        outlinewidth: 0,
        bgcolor: isDark ? "rgba(15,23,42,0.6)" : undefined,
      },
      hovertemplate: "lon=%{x:.2f}<br>lat=%{y:.2f}<br>%{z:.2f} " + unit + "<extra></extra>",
    });

    let interval = snap.contourInterval;
    if (!(interval != null && Number.isFinite(interval) && interval > 0)) {
      const span = Math.abs(zmax - zmin);
      if (span > 0) interval = Number((span / 8).toPrecision(2));
    }
    if (interval != null && Number.isFinite(interval) && interval > 0) {
      const levels = contourLevels(zmin, zmax, interval, 16);
      if (levels.length) {
        traces.push({
          type: "contour",
          z: snap.grid,
          x: snap.lon,
          y: snap.lat,
          contours: {
            start: levels[0],
            end: levels[levels.length - 1],
            size: interval,
            coloring: "lines",
            showlabels: false,
          },
          line: {
            width: 0.55,
            color: isDark ? "rgba(226,232,240,0.35)" : "rgba(30,41,59,0.45)",
          },
          showscale: false,
          hoverinfo: "skip",
        });
      }
    }
  }

  (snap.geoPaths || []).forEach((path) => {
    if (!path || path.lon.length < 2) return;
    let color = countyCol;
    let width = 0.5;
    if (path.kind === "state") {
      color = stateCol;
      width = 1.8;
    } else if (path.kind === "county") {
      color = countyCol;
      width = 0.45;
    } else if (path.kind === "highway") {
      color = hwyCol;
      width = 1.05;
    }
    traces.push({
      type: "scatter",
      mode: "lines",
      x: path.lon,
      y: path.lat,
      line: { color, width },
      hoverinfo: "skip",
      showlegend: false,
    });
  });

  const cities = snap.cities || [];
  if (cities.length) {
    traces.push({
      type: "scatter",
      mode: "markers+text",
      x: cities.map((c) => c.lon),
      y: cities.map((c) => c.lat),
      text: cities.map((c) => c.name),
      textposition: "bottom center",
      textfont: { size: 10, color: ink },
      marker: {
        size: 7,
        color: isDark ? "#e2e8f0" : "#1e293b",
        symbol: "square",
        line: { width: 1, color: isDark ? "#0f172a" : "#ffffff" },
      },
      name: "Cities",
      hovertemplate: "%{text}<extra></extra>",
    });
  }

  const sites = snap.sites || [];
  if (sites.length) {
    traces.push({
      type: "scatter",
      mode: "markers+text",
      x: sites.map((s) => s.lon),
      y: sites.map((s) => s.lat),
      text: sites.map((s) => s.id),
      textposition: "top center",
      textfont: { size: 8, color: ink },
      marker: {
        size: 7,
        color: "#B900C7",
        symbol: "triangle-up",
        line: { width: 0.8, color: "#ffffff" },
      },
      name: "Profilers",
      hovertemplate: "%{text}<br>%{y:.3f}°N, %{x:.3f}°E<extra></extra>",
    });
  }

  if (snap.probe && Number.isFinite(snap.probe.lon) && Number.isFinite(snap.probe.lat)) {
    traces.push({
      type: "scatter",
      mode: "markers",
      x: [snap.probe.lon],
      y: [snap.probe.lat],
      marker: {
        size: 11,
        color: "#ffffff",
        symbol: "circle-open",
        line: { width: 2.2, color: "#dc2626" },
      },
      name: "Probe",
      hovertemplate: "Probe<br>%{y:.3f}, %{x:.3f}<extra></extra>",
    });
  }

  const overlay = o.overlay || snap.overlay || null;
  const layoutImages = [];
  if (overlay && overlay.insets && overlay.insets.length) {
    const ordered = overlay.insets.slice().sort((a, b) => {
      const rank = (k) => (k === "site" ? 2 : k === "mid" ? 1 : 0);
      return rank(a.kind) - rank(b.kind);
    });
    ordered.forEach((ins) => {
      if (!ins.dataUrl || !Number.isFinite(ins.lon) || !Number.isFinite(ins.lat)) return;
      layoutImages.push({
        source: ins.dataUrl,
        xref: "x",
        yref: "y",
        x: ins.lon,
        y: ins.lat,
        sizex: ins.sizex || 0.25,
        sizey: ins.sizey || 0.35,
        xanchor: "center",
        yanchor: "middle",
        sizing: "contain",
        layer: "above",
        opacity: ins.opacity != null ? ins.opacity : 0.9,
      });
    });
  }

  const padLon = 0.12;
  const padLat = 0.1;
  let lon0 = snap.lonRange ? snap.lonRange[0] : Math.min(...snap.lon);
  let lon1 = snap.lonRange ? snap.lonRange[1] : Math.max(...snap.lon);
  let lat0 = snap.latRange ? snap.latRange[0] : Math.min(...snap.lat);
  let lat1 = snap.latRange ? snap.latRange[1] : Math.max(...snap.lat);
  if (o.lonRange && o.lonRange.length === 2) {
    lon0 = o.lonRange[0];
    lon1 = o.lonRange[1];
  }
  if (o.latRange && o.latRange.length === 2) {
    lat0 = o.latRange[0];
    lat1 = o.latRange[1];
  }
  const lonRange = [lon0 - padLon, lon1 + padLon];
  const latRange = [lat0 - padLat, lat1 + padLat];
  const midLat = 0.5 * (latRange[0] + latRange[1]);

  const layout = {
    title: title
      ? {
          text: title,
          font: {
            size: isDark ? 12 : 14,
            color: ink,
            family: "IBM Plex Sans, DejaVu Sans, sans-serif",
          },
          x: 0.5,
          xanchor: "center",
        }
      : undefined,
    paper_bgcolor: paper,
    plot_bgcolor: plotBg,
    font: {
      family: "IBM Plex Sans, DejaVu Sans, sans-serif",
      color: ink,
      size: isDark ? 11 : 12,
    },
    xaxis: {
      title: { text: "Longitude (°E)", font: { size: 11, color: muted } },
      range: lonRange,
      color: muted,
      gridcolor: gridCol,
      zeroline: false,
      constrain: "domain",
      scaleanchor: "y",
      scaleratio: 1 / Math.max(0.55, Math.cos((midLat * Math.PI) / 180)),
    },
    yaxis: {
      title: { text: "Latitude (°N)", font: { size: 11, color: muted } },
      range: latRange,
      color: muted,
      gridcolor: gridCol,
      zeroline: false,
      constrain: "domain",
    },
    margin: isDark ? { l: 48, r: 18, t: 36, b: 42 } : { l: 64, r: 28, t: 56, b: 56 },
    showlegend: false,
    images: layoutImages,
    annotations: [
      {
        text:
          (snap.subtitle || "") +
          (overlay && overlay.titleNote ? ` · ${overlay.titleNote}` : ""),
        xref: "paper",
        yref: "paper",
        x: 0,
        y: 1.02,
        xanchor: "left",
        yanchor: "bottom",
        showarrow: false,
        font: { size: 10, color: muted },
      },
    ],
  };

  return { traces, layout, lonRange, latRange };
}

async function exportPlanMap(snap, opts) {
  const o = opts || {};
  if (!window.Plotly) throw new Error("Plotly not loaded");
  const width = o.width || 1000;
  const height = o.height || 900;
  const { traces, layout } = buildPlanMapFigure(snap, {
    ...o,
    theme: "publication",
  });
  const host = document.createElement("div");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:" +
    width +
    "px;height:" +
    height +
    "px;opacity:0;pointer-events:none;";
  document.body.appendChild(host);
  try {
    await Plotly.newPlot(host, traces, layout, { displayModeBar: false, staticPlot: true });
    const url = await Plotly.toImage(host, {
      format: "png",
      width,
      height,
      scale: o.scale || 2,
    });
    const fname = o.filename || `plan_${snap.variable}_${snap.z_m}m_${snap.timeTag}.png`;
    triggerDownload(url, fname);
  } finally {
    try {
      Plotly.purge(host);
    } catch (_) {
      /* ignore */
    }
    host.remove();
  }
}

/** Live 2D map in a viewport element (viewer theme). */
async function renderPlanMap(elId, snap, opts) {
  if (!window.Plotly) throw new Error("Plotly not loaded");
  const el = typeof elId === "string" ? document.getElementById(elId) : elId;
  if (!el) throw new Error("Missing 2D map element");
  if (!snap || !snap.grid) {
    await Plotly.react(
      el,
      [],
      {
        paper_bgcolor: "rgba(0,0,0,0)",
        plot_bgcolor: "rgba(0,0,0,0)",
        annotations: [
          {
            text: "No map data",
            xref: "paper",
            yref: "paper",
            x: 0.5,
            y: 0.5,
            showarrow: false,
            font: { color: "#94a3b8" },
          },
        ],
        xaxis: { visible: false },
        yaxis: { visible: false },
        margin: { l: 10, r: 10, t: 10, b: 10 },
      },
      { responsive: true, displayModeBar: false }
    );
    return;
  }
  const { traces, layout } = buildPlanMapFigure(snap, {
    ...(opts || {}),
    theme: "viewer",
  });
  await Plotly.react(el, traces, layout, { responsive: true, displayModeBar: false });
  try {
    Plotly.Plots.resize(el);
  } catch (_) {
    /* ignore */
  }
}

function downloadDataUrl(dataUrl, filename) {
  triggerDownload(dataUrl, filename.endsWith(".png") ? filename : `${filename}.png`);
}

export {
  exportPlotlyPanel,
  exportPlanMap,
  renderPlanMap,
  buildPlanMapFigure,
  downloadDataUrl,
  sanitizeFilename,
  plotlyColorscale,
};
