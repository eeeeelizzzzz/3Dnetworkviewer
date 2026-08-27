/**
 * Traditional 2D site viewer: plan map + time–height, skew-T / time series, wind / hodograph.
 */
import { exportPlotlyPanel } from "./figure_export.js?v=20260826f";

const COLOR_UAS = "#B900C7";
const PALETTE = {
  UAS: "#B900C7",
  HRRR: "#777777",
  A: "#DE8A00",
  B: "#3018A9",
  C: "#88CCEE",
};

const SOURCE_IDS = ["UAS", "HRRR", "A", "B", "C"];
const CUBE_IDS = ["A", "B", "C"];

const FIELD_META = {
  wind_speed: { label: "Wind speed", unit: "m s⁻¹" },
  temperature: { label: "Temperature", unit: "°C" },
  relative_humidity: { label: "Relative humidity", unit: "%" },
  u_wind: { label: "u wind", unit: "m s⁻¹" },
  v_wind: { label: "v wind", unit: "m s⁻¹" },
};

const TH_DEFS = [
  { id: "obs", label: "OBS", kind: "field", src: "UAS" },
  { id: "hrrr", label: "HRRR", kind: "field", src: "HRRR" },
  { id: "cube", label: "Cube", kind: "field", src: "cube" },
  { id: "obs_hrrr", label: "OBS − HRRR", kind: "diff", a: "UAS", b: "HRRR" },
  { id: "obs_cube", label: "OBS − Cube", kind: "diff", a: "UAS", b: "cube" },
  { id: "hrrr_cube", label: "HRRR − Cube", kind: "diff", a: "HRRR", b: "cube" },
];

const Z_COMMON = [];
for (let z = 0; z <= 1500; z += 10) Z_COMMON.push(z);

const state = {
  ready: false,
  meta: null,
  geo: null,
  soundings: {},
  volumeCache: {},
  siteId: null,
  timeIndex: 0,
  field: "wind_speed",
  cube: "A",
  thMode: "quick",
  quickDiff: false,
  customPanels: {
    obs: true,
    hrrr: true,
    cube: false,
    obs_hrrr: false,
    obs_cube: false,
    hrrr_cube: false,
  },
  lineSources: { UAS: true, HRRR: false, A: false, B: false, C: false },
  leftMode: "skewt",
  windMode: "profile",
  tsHeight: 100,
  mapHeight: 100,
  mapSource: "hrrr",
  mapShowField: true,
  refreshGen: 0,
};

function $(id) {
  return document.getElementById(id);
}

function times() {
  return (state.meta && state.meta.times) || [];
}

function sites() {
  return (state.meta && state.meta.sites) || [];
}

function currentTime() {
  return times()[state.timeIndex] || null;
}

function siteRecord(id) {
  return sites().find((s) => s.id === id) || null;
}

function cubeKey() {
  return state.cube || "A";
}

function resolveSrc(token) {
  return token === "cube" ? cubeKey() : token;
}

function fieldLabel(id) {
  return (FIELD_META[id] && FIELD_META[id].label) || id;
}

function fieldUnit(id) {
  return (FIELD_META[id] && FIELD_META[id].unit) || "";
}

function hasFinite(arr) {
  if (!Array.isArray(arr)) return false;
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i] != null && Number.isFinite(Number(arr[i]))) return true;
  }
  return false;
}

function columnAt(tag, siteId, src) {
  const pack = state.soundings[tag];
  if (!pack || !pack[siteId] || !pack[siteId].sources) return null;
  const col = pack[siteId].sources[src];
  return col && Array.isArray(col.z) ? col : null;
}

function siteHasObs(tag, siteId) {
  const col = columnAt(tag, siteId, "UAS");
  return !!(col && hasFinite(col.temperature));
}

function sourcesAtTime(siteId, tag) {
  const pack = state.soundings[tag] && state.soundings[tag][siteId];
  return (pack && pack.sources) || {};
}

function enabledLineSources() {
  return SOURCE_IDS.filter((k) => state.lineSources[k]);
}

function selectedPanels() {
  if (state.thMode === "quick") {
    const ids = ["obs", "hrrr"];
    if (state.quickDiff) ids.push("obs_hrrr");
    return TH_DEFS.filter((d) => ids.includes(d.id));
  }
  return TH_DEFS.filter((d) => state.customPanels[d.id]);
}

function interpToZ(zSrc, vSrc, zOut) {
  const zs = [];
  const vs = [];
  if (!zSrc || !vSrc) return zOut.map(() => null);
  const n = Math.min(zSrc.length, vSrc.length);
  for (let i = 0; i < n; i += 1) {
    const z = Number(zSrc[i]);
    const v = Number(vSrc[i]);
    if (!Number.isFinite(z) || !Number.isFinite(v)) continue;
    zs.push(z);
    vs.push(v);
  }
  if (zs.length < 2) return zOut.map(() => null);
  return zOut.map((z) => {
    if (z < zs[0] || z > zs[zs.length - 1]) return null;
    let i = 0;
    while (i < zs.length - 2 && zs[i + 1] < z) i += 1;
    const t = zs[i + 1] === zs[i] ? 0 : (z - zs[i]) / (zs[i + 1] - zs[i]);
    return vs[i] + t * (vs[i + 1] - vs[i]);
  });
}

function valueAtHeight(col, field, heightM) {
  if (!col || !col.z || !col[field]) return null;
  const v = interpToZ(col.z, col[field], [heightM])[0];
  return v != null && Number.isFinite(v) ? v : null;
}

function kmToLonLat(xKm, yKm, lat0, lon0) {
  return {
    lat: lat0 + yKm / 110.574,
    lon: lon0 + xKm / (111.32 * Math.cos((lat0 * Math.PI) / 180)),
  };
}

function pathKmToLonLat(path2d, lat0, lon0) {
  const lon = [];
  const lat = [];
  (path2d || []).forEach((p) => {
    if (!p || p.length < 2) return;
    const ll = kmToLonLat(p[0], p[1], lat0, lon0);
    lon.push(ll.lon);
    lat.push(ll.lat);
  });
  return { lon, lat };
}

function buildThGrid(siteId, field, def) {
  const tt = times();
  const xLabels = tt.map((t) => t.label.replace(" UTC", "").replace(/^20/, "").trim());
  const srcA = resolveSrc(def.kind === "diff" ? def.a : def.src);
  const srcB = def.kind === "diff" ? resolveSrc(def.b) : null;
  const colsA = [];
  const colsB = [];
  let nOk = 0;
  tt.forEach((t) => {
    const colA = columnAt(t.tag, siteId, srcA);
    const va = colA ? interpToZ(colA.z, colA[field], Z_COMMON) : Z_COMMON.map(() => null);
    colsA.push(va);
    if (def.kind === "diff") {
      const colB = columnAt(t.tag, siteId, srcB);
      colsB.push(colB ? interpToZ(colB.z, colB[field], Z_COMMON) : Z_COMMON.map(() => null));
    }
    if (va.some((v) => v != null)) nOk += 1;
  });
  if (!nOk && def.kind !== "diff") {
    if (!colsA.some((c) => c.some((v) => v != null))) return null;
  }
  const grid = [];
  let vmin = Infinity;
  let vmax = -Infinity;
  for (let k = 0; k < Z_COMMON.length; k += 1) {
    const row = [];
    for (let ti = 0; ti < tt.length; ti += 1) {
      let v = colsA[ti][k];
      if (def.kind === "diff") {
        const a = colsA[ti][k];
        const b = colsB[ti][k];
        v = a != null && b != null ? a - b : null;
      }
      row.push(v);
      if (v != null && Number.isFinite(v)) {
        vmin = Math.min(vmin, v);
        vmax = Math.max(vmax, v);
      }
    }
    grid.push(row);
  }
  if (!Number.isFinite(vmin)) return null;
  let title = def.label;
  if (def.src === "cube" || def.a === "cube" || def.b === "cube") {
    title = title.replace("Cube", cubeKey());
  }
  return {
    kind: "timeheight",
    grid,
    xAxis: xLabels,
    zAxis: Z_COMMON,
    variable: field,
    unit: fieldUnit(field),
    title: `${title} · ${fieldLabel(field)}`,
    zmin: vmin,
    zmax: vmax,
    diff: def.kind === "diff",
  };
}

function sharedFieldRange(sections) {
  let vmin = Infinity;
  let vmax = -Infinity;
  sections.forEach((s) => {
    if (!s || s.diff) return;
    vmin = Math.min(vmin, s.zmin);
    vmax = Math.max(vmax, s.zmax);
  });
  return Number.isFinite(vmin) ? { vmin, vmax } : { vmin: null, vmax: null };
}

function symmetricDiffRange(sections) {
  let m = 0;
  sections.forEach((s) => {
    if (!s || !s.diff) return;
    m = Math.max(m, Math.abs(s.zmin), Math.abs(s.zmax));
  });
  return m > 0 ? m : 1;
}

async function renderTimeHeight() {
  const host = $("classic-th-grid");
  if (!host || !window.SoundingPlotter) return;
  const siteId = state.siteId;
  const defs = selectedPanels();
  host.innerHTML = "";
  const sub = $("classic-th-subtitle");
  if (!siteId) {
    if (sub) sub.textContent = "Click a site on the map";
    return;
  }
  if (!defs.length) {
    if (sub) sub.textContent = "Select at least one time–height panel";
    host.innerHTML = '<div class="classic-empty">Tick panels to add them to the figure.</div>';
    return;
  }

  const sections = defs.map((d) => buildThGrid(siteId, state.field, d));
  const fieldRange = sharedFieldRange(sections);
  const diffAbs = symmetricDiffRange(sections);
  const n = defs.length;
  const cols = n === 1 ? 1 : 2;
  host.className = `classic-th-grid cols-${cols}`;
  host.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

  defs.forEach((def, i) => {
    const wrap = document.createElement("div");
    wrap.className = "classic-th-cell";
    const plot = document.createElement("div");
    const pid = `classic-th-${def.id}`;
    plot.id = pid;
    plot.className = "classic-th-plot";
    wrap.appendChild(plot);
    host.appendChild(wrap);
    const section = sections[i];
    if (!section) {
      window.SoundingPlotter.renderCrossSection(pid, null, {
        kind: "timeheight",
        emptyText: `No ${def.label} data at ${siteId}`,
      });
      return;
    }
    const isDiff = section.diff;
    window.SoundingPlotter.renderCrossSection(pid, section, {
      kind: "timeheight",
      unit: section.unit,
      colorscale: isDiff ? "RdBu" : "Viridis",
      zmin: isDiff ? -diffAbs : fieldRange.vmin,
      zmax: isDiff ? diffAbs : fieldRange.vmax,
      reversescale: isDiff,
      fitContainer: true,
    });
  });

  requestAnimationFrame(() => {
    defs.forEach((def) => {
      const el = document.getElementById(`classic-th-${def.id}`);
      if (el && window.Plotly && Plotly.Plots) {
        try {
          Plotly.Plots.resize(el);
        } catch (_) {
          /* ignore */
        }
      }
    });
  });

  const site = siteRecord(siteId);
  if (sub) sub.textContent = `${site ? site.name : siteId} · ${fieldLabel(state.field)}`;
}

function buildTimeSeries(siteId, field, heightM) {
  const tt = times();
  const x = tt.map((t) => t.label.replace(" UTC", "").replace(/^20/, "").trim());
  const series = [];
  enabledLineSources().forEach((src) => {
    const values = tt.map((t) => valueAtHeight(columnAt(t.tag, siteId, src), field, heightM));
    if (!values.some((v) => v != null)) return;
    series.push({
      times: x,
      values,
      name: src,
      color: PALETTE[src] || "#94a3b8",
      width: src === "UAS" ? 2.6 : 1.8,
      dash: src === "HRRR" ? "dash" : "solid",
    });
  });
  return series;
}

function setSkewtHostMode(mode) {
  const stack = $("classic-skewt-stack");
  const plot = $("classic-skewt");
  const empty = $("classic-skewt-empty");
  const isTs = mode === "timeseries";
  if (stack) {
    stack.hidden = isTs;
    if (isTs) stack.innerHTML = "";
  }
  if (plot) plot.hidden = !isTs;
  if (empty) empty.hidden = true;
  if (!isTs && plot && window.Plotly && plot.data) {
    try {
      Plotly.purge(plot);
    } catch (_) {
      /* ignore */
    }
  }
}

function skewtFolder() {
  return state.leftMode === "skewt_low" ? "skewt_low" : "skewt";
}

function leftPanelTitle() {
  if (state.leftMode === "timeseries") return "Time series";
  if (state.leftMode === "skewt_low") return "Skew-T low (MetPy)";
  return "Skew-T (MetPy)";
}

function syncSkewtOverlayVisibility() {
  const stack = $("classic-skewt-stack");
  if (!stack) return;
  stack.querySelectorAll("img[data-skewt-src]").forEach((img) => {
    const key = img.getAttribute("data-skewt-src");
    img.hidden = !state.lineSources[key];
  });
  const parcel = stack.querySelector("img[data-skewt-layer='parcel']");
  if (parcel) {
    // Parcel / CAPE is UAS-based — show with UAS on low view
    parcel.hidden = !(state.leftMode === "skewt_low" && state.lineSources.UAS);
  }
}

function showMetpySkewt(siteId, tag, label) {
  const stack = $("classic-skewt-stack");
  const empty = $("classic-skewt-empty");
  const plot = $("classic-skewt");
  if (plot) plot.hidden = true;
  if (!stack) return;

  if (!siteId || !tag) {
    stack.hidden = true;
    stack.innerHTML = "";
    if (empty) {
      empty.hidden = false;
      empty.textContent = "Click a site";
    }
    return;
  }

  const folder = skewtFolder();
  const base = `data/${folder}/${tag}/${siteId}`;
  const bust = "20260826p";
  const layers = ["grid", ...SOURCE_IDS];
  if (state.leftMode === "skewt_low") layers.push("parcel");

  stack.innerHTML = "";
  stack.hidden = false;
  let pending = layers.length;
  let anyOk = false;

  const doneOne = (ok) => {
    if (ok) anyOk = true;
    pending -= 1;
    if (pending > 0) return;
    if (anyOk) {
      if (empty) empty.hidden = true;
      syncSkewtOverlayVisibility();
    } else {
      stack.hidden = true;
      if (empty) {
        empty.hidden = false;
        empty.textContent = `No MetPy ${state.leftMode === "skewt_low" ? "skew-T low" : "skew-T"} for ${siteId} @ ${label || tag}`;
      }
    }
  };

  layers.forEach((layer) => {
    const img = document.createElement("img");
    img.className = "classic-skewt-layer";
    img.alt = "";
    img.decoding = "async";
    if (layer === "grid") {
      img.dataset.skewtLayer = "grid";
      img.classList.add("is-grid");
    } else if (layer === "parcel") {
      img.dataset.skewtLayer = "parcel";
    } else {
      img.dataset.skewtSrc = layer;
      img.dataset.skewtLayer = "source";
    }
    img.onload = () => doneOne(true);
    img.onerror = () => {
      img.remove();
      doneOne(false);
    };
    img.src = `${base}/${layer}.png?v=${bust}`;
    stack.appendChild(img);
  });

  stack.setAttribute(
    "aria-label",
    `MetPy ${state.leftMode === "skewt_low" ? "Skew-T low" : "Skew-T"} · ${siteId} · ${label || tag}`
  );
}

async function exportSkewtStackPng(filename) {
  const stack = $("classic-skewt-stack");
  if (!stack || stack.hidden) return;
  const imgs = Array.from(stack.querySelectorAll("img")).filter((img) => !img.hidden && img.complete && img.naturalWidth);
  if (!imgs.length) return;
  const w = imgs[0].naturalWidth;
  const h = imgs[0].naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  imgs.forEach((img) => ctx.drawImage(img, 0, 0, w, h));
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = filename;
  a.click();
}

async function renderLinePlots() {
  const t = currentTime();
  const siteId = state.siteId;
  const leftTitle = $("classic-skewt-sub");
  const windTitle = $("classic-wind-sub");
  const leftHead = $("classic-left-title");
  const windHead = $("classic-wind-title");

  if (leftHead) leftHead.textContent = leftPanelTitle();
  if (windHead) windHead.textContent = state.windMode === "hodograph" ? "Hodograph" : "Wind profile";

  if (!t || !siteId) {
    if (state.leftMode === "timeseries") {
      setSkewtHostMode("timeseries");
      if (window.SoundingPlotter) {
        window.SoundingPlotter.renderTimeSeries("classic-skewt", [], { emptyText: "Click a site" });
      }
    } else {
      setSkewtHostMode("skewt");
      showMetpySkewt(null, null, null);
    }
    if (!window.SoundingPlotter) return;
    if (state.windMode === "hodograph") {
      window.SoundingPlotter.renderHodograph("classic-wind", { sources: {}, enabled: [], emptyText: "Click a site" });
    } else {
      window.SoundingPlotter.renderWindProfile("classic-wind", { emptyText: "Click a site" });
    }
    return;
  }

  const sources = sourcesAtTime(siteId, t.tag);
  const hasObs = siteHasObs(t.tag, siteId);
  const lab = `${siteId} · ${t.label}`;
  const enabled = enabledLineSources();
  if (leftTitle) {
    leftTitle.textContent =
      state.leftMode === "timeseries"
        ? `${siteId} · ${fieldLabel(state.field)} @ ${state.tsHeight} m`
        : state.leftMode === "skewt_low"
          ? `${lab} · low`
          : `${lab} · MetPy`;
  }
  if (windTitle) windTitle.textContent = lab;

  if (state.leftMode === "timeseries") {
    setSkewtHostMode("timeseries");
    if (window.SoundingPlotter) {
      const series = buildTimeSeries(siteId, state.field, state.tsHeight);
      window.SoundingPlotter.renderTimeSeries("classic-skewt", series, {
        ylabel: `${fieldLabel(state.field)} (${fieldUnit(state.field)})`,
        emptyText: "Enable sources below, or pick a site with data",
        mode: "site",
        margin: { l: 42, r: 8, t: 8, b: 36 },
      });
    }
  } else {
    setSkewtHostMode("skewt");
    const stack = $("classic-skewt-stack");
    const skewKey = `${state.leftMode}|${t.tag}|${siteId}`;
    if (stack && stack.dataset.skewKey === skewKey && stack.querySelector("img")) {
      syncSkewtOverlayVisibility();
    } else {
      if (stack) stack.dataset.skewKey = skewKey;
      showMetpySkewt(siteId, t.tag, t.label);
    }
  }

  if (!window.SoundingPlotter) return;
  if (state.windMode === "hodograph") {
    window.SoundingPlotter.renderHodograph("classic-wind", {
      sources,
      enabled,
      palette: PALETTE,
      mode: "site",
      zMinM: 50,
      emptyText: hasObs ? "No wind profile" : "No UAS profile at this valid time",
    });
  } else {
    window.SoundingPlotter.renderWindProfile("classic-wind", {
      sources,
      enabled,
      palette: PALETTE,
      title: hasObs ? `Wind · ${lab}` : `Wind · ${lab} (no UAS)`,
      emptyText: hasObs ? "No wind profile" : "No UAS profile at this valid time",
      zMin: 0,
      zMax: 1500,
    });
  }
}

function decodeU8Field(field, n) {
  if (!field || typeof field.data !== "string") return null;
  const bin = atob(field.data);
  if (bin.length < n) return null;
  const out = new Float32Array(n);
  const vmin = Number(field.vmin);
  const vmax = Number(field.vmax);
  const scale = (vmax - vmin) / 255;
  for (let i = 0; i < n; i += 1) out[i] = vmin + bin.charCodeAt(i) * scale;
  return out;
}

async function loadVolume(modelId, tag) {
  const key = `${modelId}|${tag}`;
  if (state.volumeCache[key]) return state.volumeCache[key];
  const assets = (state.meta && state.meta.assets && state.meta.assets[modelId]) || {};
  const rel = assets[tag];
  if (!rel) return null;
  try {
    const res = await fetch(`data/${rel}`);
    if (!res.ok) return null;
    const vol = await res.json();
    state.volumeCache[key] = vol;
    return vol;
  } catch (_) {
    return null;
  }
}

function nearestZIndex(zArr, heightM) {
  if (!zArr || !zArr.length) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < zArr.length; i += 1) {
    const d = Math.abs(Number(zArr[i]) - heightM);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

async function renderMap() {
  const el = $("classic-map");
  if (!el || !window.Plotly || !state.meta) return;
  const proj = state.meta.projection || {};
  const lat0 = proj.lat0 || 35.75;
  const lon0 = proj.lon0 || -96.75;
  const traces = [];
  const geo = state.geo || {};
  const t = currentTime();
  const tag = t ? t.tag : null;
  const mapSub = $("classic-map-field-label");
  let fieldLon = null;
  let fieldLat = null;

  if (state.mapShowField && tag) {
    const vol = await loadVolume(state.mapSource, tag);
    const fieldObj = vol && vol.fields && vol.fields[state.field];
    if (vol && fieldObj) {
      const nx = vol.nx;
      const ny = vol.ny;
      const nz = vol.nz;
      const values = decodeU8Field(fieldObj, nx * ny * nz);
      const zArr = vol.z_m || [];
      const k = nearestZIndex(zArr, state.mapHeight);
      if (values) {
        const zGrid = [];
        for (let i = 0; i < ny; i += 1) {
          const row = new Array(nx);
          for (let j = 0; j < nx; j += 1) {
            row[j] = values[(k * ny + i) * nx + j];
          }
          zGrid.push(row);
        }
        const xKm = vol.x_km || [];
        const yKm = vol.y_km || [];
        const lon = xKm.map((x) => kmToLonLat(x, 0, lat0, lon0).lon);
        const lat = yKm.map((y) => kmToLonLat(0, y, lat0, lon0).lat);
        fieldLon = lon;
        fieldLat = lat;
        const zActual = zArr[k] != null ? Number(zArr[k]) : state.mapHeight;
        traces.push({
          type: "heatmap",
          x: lon,
          y: lat,
          z: zGrid,
          colorscale: "Viridis",
          colorbar: {
            title: { text: fieldUnit(state.field), font: { size: 9 } },
            thickness: 8,
            len: 0.72,
            x: 1.01,
            tickfont: { size: 8 },
          },
          hovertemplate: `lon=%{x:.2f}<br>lat=%{y:.2f}<br>%{z:.2f}<extra>${fieldLabel(state.field)}</extra>`,
          name: "field",
          showscale: true,
        });
        if (mapSub) {
          mapSub.textContent = `${String(state.mapSource).toUpperCase()} · ${fieldLabel(state.field)} @ ${zActual.toFixed(0)} m`;
        }
      }
    } else if (mapSub) {
      mapSub.textContent = "Field unavailable";
    }
  } else if (mapSub) {
    mapSub.textContent = "Sites only";
  }

  function addPaths(paths, color, width) {
    (paths || []).forEach((p, i) => {
      const ll = pathKmToLonLat(p, lat0, lon0);
      if (ll.lon.length < 2) return;
      traces.push({
        type: "scatter",
        mode: "lines",
        x: ll.lon,
        y: ll.lat,
        line: { color, width },
        hoverinfo: "skip",
        showlegend: false,
        name: `geo-${i}`,
      });
    });
  }
  addPaths(geo.state, "#f8fafc", 1.6);
  addPaths(geo.counties, "#64748b", 0.5);
  addPaths(geo.highways, "#94a3b8", 0.8);

  (geo.cities || []).forEach((c) => {
    traces.push({
      type: "scatter",
      mode: "text",
      x: [c.lon],
      y: [c.lat],
      text: [c.name],
      textposition: "top center",
      textfont: { size: 10, color: "#cbd5e1" },
      hoverinfo: "skip",
      showlegend: false,
    });
  });

  const lon = [];
  const lat = [];
  const labels = [];
  const hover = [];
  const color = [];
  const size = [];
  const ids = [];
  sites().forEach((s) => {
    lon.push(s.lon);
    lat.push(s.lat);
    ids.push(s.id);
    labels.push(s.id);
    const obs = tag ? siteHasObs(tag, s.id) : false;
    const sel = s.id === state.siteId;
    hover.push(`${s.name}${obs ? "" : " · no UAS"}`);
    color.push(sel ? "#fbbf24" : obs ? COLOR_UAS : "#64748b");
    size.push(sel ? 14 : obs ? 11 : 8);
  });
  traces.push({
    type: "scatter",
    mode: "markers+text",
    x: lon,
    y: lat,
    text: labels,
    textposition: "bottom center",
    textfont: { size: 9, color: "#e2e8f0" },
    marker: {
      size,
      color,
      line: { width: 1.4, color: "#0b1220" },
      symbol: "circle",
    },
    customdata: hover.map((h, i) => [ids[i], h]),
    hovertemplate: "%{customdata[1]}<extra></extra>",
    name: "sites",
    showlegend: false,
  });

  const siteLons = sites().map((s) => s.lon);
  const siteLats = sites().map((s) => s.lat);
  let lonMin;
  let lonMax;
  let latMin;
  let latMax;
  if (fieldLon && fieldLon.length && fieldLat && fieldLat.length) {
    lonMin = Math.min(...fieldLon);
    lonMax = Math.max(...fieldLon);
    latMin = Math.min(...fieldLat);
    latMax = Math.max(...fieldLat);
  } else if (
    proj.x_min != null &&
    proj.x_max != null &&
    proj.y_min != null &&
    proj.y_max != null
  ) {
    const sw = kmToLonLat(proj.x_min, proj.y_min, lat0, lon0);
    const ne = kmToLonLat(proj.x_max, proj.y_max, lat0, lon0);
    lonMin = Math.min(sw.lon, ne.lon);
    lonMax = Math.max(sw.lon, ne.lon);
    latMin = Math.min(sw.lat, ne.lat);
    latMax = Math.max(sw.lat, ne.lat);
  } else {
    lonMin = Math.min(...siteLons);
    lonMax = Math.max(...siteLons);
    latMin = Math.min(...siteLats);
    latMax = Math.max(...siteLats);
  }
  const lonPad = Math.max(0.04, (lonMax - lonMin) * 0.04);
  const latPad = Math.max(0.03, (latMax - latMin) * 0.04);
  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(11,18,32,0.65)",
    margin: { l: 34, r: fieldLon ? 28 : 6, t: 4, b: 28 },
    xaxis: {
      title: { text: "Longitude", font: { size: 9 } },
      color: "#94a3b8",
      gridcolor: "#1e293b",
      tickfont: { size: 8 },
      range: [lonMin - lonPad, lonMax + lonPad],
      zeroline: false,
    },
    yaxis: {
      title: { text: "Latitude", font: { size: 9 } },
      color: "#94a3b8",
      gridcolor: "#1e293b",
      tickfont: { size: 8 },
      range: [latMin - latPad, latMax + latPad],
      zeroline: false,
      scaleanchor: "x",
      scaleratio: 1 / Math.cos((lat0 * Math.PI) / 180),
    },
    showlegend: false,
  };

  await Plotly.react(el, traces, layout, { responsive: true, displayModeBar: false });
  if (!el.dataset.clickBound) {
    el.dataset.clickBound = "1";
    el.on("plotly_click", (ev) => {
      const pt = ev.points && ev.points[0];
      if (!pt || pt.data.type === "heatmap") return;
      const id = Array.isArray(pt.customdata) ? pt.customdata[0] : null;
      if (id && sites().some((s) => s.id === id)) selectSite(id);
    });
  }
}

function updateSiteReadout() {
  const el = $("classic-site-readout");
  const s = siteRecord(state.siteId);
  if (el) el.textContent = s ? s.name : "Click a site";
}

function updateTimeLabel() {
  const t = currentTime();
  const el = $("classic-time-label");
  if (el) el.textContent = t ? t.label : "—";
  const slider = $("classic-time-slider");
  if (slider) slider.value = String(state.timeIndex);
}

function syncModeUi() {
  const quick = $("classic-th-quick-opts");
  const custom = $("classic-th-custom-opts");
  if (quick) quick.hidden = state.thMode !== "quick";
  if (custom) custom.hidden = state.thMode !== "custom";
  document.querySelectorAll("[name=classic-th-mode]").forEach((el) => {
    el.checked = el.value === state.thMode;
  });
  const tsOpts = $("classic-ts-opts");
  if (tsOpts) tsOpts.hidden = state.leftMode !== "timeseries";
  document.querySelectorAll("[name=classic-left-mode]").forEach((el) => {
    el.checked = el.value === state.leftMode;
  });
  document.querySelectorAll("[name=classic-wind-mode]").forEach((el) => {
    el.checked = el.value === state.windMode;
  });
}

async function refreshAll() {
  const gen = ++state.refreshGen;
  updateSiteReadout();
  updateTimeLabel();
  syncModeUi();
  await renderMap();
  if (gen !== state.refreshGen) return;
  await renderTimeHeight();
  if (gen !== state.refreshGen) return;
  await renderLinePlots();
}

function selectSite(id) {
  if (!id) return;
  state.siteId = id;
  refreshAll();
}

function wireControls() {
  const slider = $("classic-time-slider");
  if (slider) {
    slider.min = "0";
    slider.max = String(Math.max(0, times().length - 1));
    slider.addEventListener("input", () => {
      state.timeIndex = Number(slider.value) || 0;
      updateTimeLabel();
      renderMap();
      renderLinePlots();
    });
  }
  const bindStep = (id, delta) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("click", () => {
      state.timeIndex = Math.max(0, Math.min(times().length - 1, state.timeIndex + delta));
      refreshAll();
    });
  };
  bindStep("classic-time-prev", -1);
  bindStep("classic-time-next", 1);

  const fieldSel = $("classic-field");
  if (fieldSel) {
    fieldSel.addEventListener("change", () => {
      state.field = fieldSel.value;
      renderTimeHeight();
      renderMap();
      if (state.leftMode === "timeseries") renderLinePlots();
    });
  }
  const cubeSel = $("classic-cube");
  if (cubeSel) {
    cubeSel.addEventListener("change", () => {
      state.cube = cubeSel.value;
      renderTimeHeight();
    });
  }

  document.querySelectorAll("[name=classic-th-mode]").forEach((el) => {
    el.addEventListener("change", () => {
      if (!el.checked) return;
      state.thMode = el.value;
      syncModeUi();
      renderTimeHeight();
    });
  });
  const quickDiff = $("classic-quick-diff");
  if (quickDiff) {
    quickDiff.addEventListener("change", () => {
      state.quickDiff = quickDiff.checked;
      renderTimeHeight();
    });
  }
  document.querySelectorAll(".classic-th-panel").forEach((el) => {
    el.checked = !!state.customPanels[el.value];
    el.addEventListener("change", () => {
      state.customPanels[el.value] = el.checked;
      if (state.thMode === "custom") renderTimeHeight();
    });
  });

  document.querySelectorAll(".classic-line-src").forEach((el) => {
    el.checked = !!state.lineSources[el.value];
    el.addEventListener("change", () => {
      state.lineSources[el.value] = el.checked;
      if (state.leftMode === "skewt" || state.leftMode === "skewt_low") {
        syncSkewtOverlayVisibility();
      }
      renderLinePlots();
    });
  });

  document.querySelectorAll("[name=classic-left-mode]").forEach((el) => {
    el.addEventListener("change", () => {
      if (!el.checked) return;
      state.leftMode = el.value;
      syncModeUi();
      renderLinePlots();
    });
  });
  document.querySelectorAll("[name=classic-wind-mode]").forEach((el) => {
    el.addEventListener("change", () => {
      if (!el.checked) return;
      state.windMode = el.value;
      syncModeUi();
      renderLinePlots();
    });
  });

  const tsH = $("classic-ts-height");
  const tsHVal = $("classic-ts-height-val");
  if (tsH) {
    tsH.value = String(state.tsHeight);
    if (tsHVal) tsHVal.textContent = `${state.tsHeight} m`;
    tsH.addEventListener("input", () => {
      state.tsHeight = Number(tsH.value) || 0;
      if (tsHVal) tsHVal.textContent = `${state.tsHeight} m`;
      if (state.leftMode === "timeseries") renderLinePlots();
    });
  }

  const mapH = $("classic-map-height");
  const mapHVal = $("classic-map-height-val");
  if (mapH) {
    mapH.value = String(state.mapHeight);
    if (mapHVal) mapHVal.textContent = `${state.mapHeight} m`;
    mapH.addEventListener("input", () => {
      state.mapHeight = Number(mapH.value) || 0;
      if (mapHVal) mapHVal.textContent = `${state.mapHeight} m`;
      renderMap();
    });
  }
  const mapSrc = $("classic-map-source");
  if (mapSrc) {
    mapSrc.value = state.mapSource;
    mapSrc.addEventListener("change", () => {
      state.mapSource = mapSrc.value;
      renderMap();
    });
  }
  const mapField = $("classic-map-field");
  if (mapField) {
    mapField.checked = state.mapShowField;
    mapField.addEventListener("change", () => {
      state.mapShowField = mapField.checked;
      renderMap();
    });
  }

  document.querySelectorAll("[data-classic-export]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const which = btn.getAttribute("data-classic-export");
      const site = state.siteId || "site";
      const tag = (currentTime() && currentTime().tag) || "time";
      try {
        if (which === "th") {
          const cells = document.querySelectorAll("#classic-th-grid .classic-th-plot");
          let i = 0;
          for (const cell of cells) {
            if (!cell.id) continue;
            i += 1;
            await exportPlotlyPanel(cell.id, `th_${site}_${state.field}_${i}`, {
              title: `${site} time–height`,
            });
          }
          return;
        }
        if (which === "skewt") {
          if (state.leftMode === "skewt" || state.leftMode === "skewt_low") {
            await exportSkewtStackPng(`${state.leftMode}_${site}_${tag}.png`);
            return;
          }
          await exportPlotlyPanel("classic-skewt", `left_${site}_${tag}`, {
            title: `Time series ${site}`,
          });
          return;
        }
        if (which === "wind") {
          await exportPlotlyPanel("classic-wind", `wind_${site}_${tag}`, {
            title: state.windMode === "hodograph" ? `Hodograph ${site}` : `Wind ${site}`,
          });
        }
      } catch (err) {
        console.warn("classic export failed", err);
      }
    });
  });
}

async function loadAssets(meta) {
  const [geoRes, ...sndRes] = await Promise.all([
    fetch("data/geo/context.json"),
    ...meta.times.map((t) => fetch(`data/soundings/${t.tag}.json`)),
  ]);
  state.geo = geoRes.ok ? await geoRes.json() : {};
  state.soundings = {};
  for (let i = 0; i < meta.times.length; i += 1) {
    const res = sndRes[i];
    state.soundings[meta.times[i].tag] = res.ok ? await res.json() : {};
  }
}

function defaultSite() {
  const pref = ["WASH", "STILL", "OKEM", "WYNO", "CHAN", "NRMN"];
  for (const id of pref) {
    if (sites().some((s) => s.id === id)) return id;
  }
  return sites().length ? sites()[0].id : null;
}

function fillSelects() {
  const fieldSel = $("classic-field");
  if (fieldSel && !fieldSel.options.length) {
    Object.keys(FIELD_META).forEach((id) => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = FIELD_META[id].label;
      if (id === state.field) opt.selected = true;
      fieldSel.appendChild(opt);
    });
  }
  const cubeSel = $("classic-cube");
  if (cubeSel) {
    cubeSel.innerHTML = "";
    ((state.meta && state.meta.models) || [])
      .filter((m) => CUBE_IDS.includes(m.id))
      .forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.id;
        opt.textContent = m.label.replace(/^Version\s+/i, "");
        if (m.id === state.cube) opt.selected = true;
        cubeSel.appendChild(opt);
      });
  }
  const mapSrc = $("classic-map-source");
  if (mapSrc && !mapSrc.options.length) {
    [
      { id: "hrrr", label: "HRRR" },
      { id: "A", label: "A" },
      { id: "B", label: "B" },
      { id: "C", label: "C" },
    ].forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label;
      if (m.id === state.mapSource) opt.selected = true;
      mapSrc.appendChild(opt);
    });
  }
}

export async function initClassicViewer(meta) {
  if (!meta) return;
  state.meta = meta;
  fillSelects();
  if (!state.ready) {
    wireControls();
    await loadAssets(meta);
    state.siteId = defaultSite();
    state.ready = true;
  }
  syncModeUi();
  await refreshAll();
}

export function resizeClassicViewer() {
  [
    "classic-map",
    "classic-skewt",
    "classic-wind",
    ...Array.from(document.querySelectorAll("#classic-th-grid .classic-th-plot")).map((el) => el.id),
  ].forEach((id) => {
    const el = $(id);
    if (el && window.Plotly && Plotly.Plots) {
      try {
        Plotly.Plots.resize(el);
      } catch (_) {
        /* ignore */
      }
    }
  });
}

export function isClassicReady() {
  return state.ready;
}
