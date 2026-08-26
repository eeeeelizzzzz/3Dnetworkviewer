/**
 * Station map viz helpers: OBS-site sample points, dual-panel T/RH+WS/WD
 * profiles, and hodograph canvases (3D billboards, 2D plan, click popups).
 */

const HODO_Z_MIN_M = 50;

/** Shared axes for every site / popup profile & hodograph panel. */
const FIXED_PROFILE_AXES = {
  zMin: 0,
  zMax: 1500,
  tLo: 5,
  tHi: 40,
  rhLo: 0,
  rhHi: 100,
  wsLo: 0,
  wsHi: 20,
  wdLo: 0,
  wdHi: 360,
};

/** Shared hodograph radial limit (m/s) so all panels match. */
const FIXED_HODO_MAX_R = 20;

const PROFILE_COLORS = {
  temperature: "#c2410c",
  relative_humidity: "#1d4ed8",
  wind_speed: "#B900C7",
  wind_dir: "#475569",
};

/**
 * Meteorological wind direction (degrees FROM which the wind blows).
 */
function windDirFromUV(u, v) {
  if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
  // atan2(u, v) then rotate to "from" convention
  let deg = (Math.atan2(u, v) * 180) / Math.PI + 180;
  deg = ((deg % 360) + 360) % 360;
  return deg;
}

function windDirSeries(uArr, vArr) {
  const n = Math.min((uArr || []).length, (vArr || []).length);
  const out = new Array(n);
  for (let i = 0; i < n; i += 1) out[i] = windDirFromUV(uArr[i], vArr[i]);
  return out;
}

/** Normalize a UAS sounding dict for overlay plotting (adds wind_dir). */
function normalizeObsColumns(raw) {
  if (!raw || !Array.isArray(raw.z) || raw.z.length < 2) return null;
  const out = {
    z: raw.z,
    temperature: raw.temperature,
    relative_humidity: raw.relative_humidity,
    wind_speed: raw.wind_speed,
    u_wind: raw.u_wind,
    v_wind: raw.v_wind,
  };
  if (raw.u_wind && raw.v_wind) {
    out.wind_dir = windDirSeries(raw.u_wind, raw.v_wind);
  }
  // Need at least one finite value somewhere
  let ok = false;
  for (const key of ["temperature", "relative_humidity", "wind_speed", "u_wind", "v_wind"]) {
    const arr = out[key];
    if (!Array.isArray(arr)) continue;
    if (arr.some((v) => v != null && Number.isFinite(Number(v)))) {
      ok = true;
      break;
    }
  }
  return ok ? out : null;
}

/**
 * Build sample points. Default: observation sites only (no mid/grid).
 * Pass opts.includeCubeSamples=true to restore interstitial points.
 */
function buildOverlaySamplePoints(sites, vol, opts) {
  const o = opts || {};
  const includeCube = !!o.includeCubeSamples;
  const points = [];
  const siteList = (sites || []).filter(
    (s) => s && Number.isFinite(s.x_km) && Number.isFinite(s.y_km)
  );

  siteList.forEach((s) => {
    points.push({
      kind: "site",
      id: s.id,
      label: s.id,
      xKm: s.x_km,
      yKm: s.y_km,
      lon: s.lon,
      lat: s.lat,
    });
  });

  if (!includeCube) return points;

  const maxPairKm = o.maxPairKm != null ? o.maxPairKm : 95;
  const minPairKm = o.minPairKm != null ? o.minPairKm : 28;
  const nearSiteKm = o.nearSiteKm != null ? o.nearSiteKm : 14;
  const gridStride = o.gridStride != null ? o.gridStride : 6;

  for (let a = 0; a < siteList.length; a += 1) {
    for (let b = a + 1; b < siteList.length; b += 1) {
      const sa = siteList[a];
      const sb = siteList[b];
      const d = Math.hypot(sa.x_km - sb.x_km, sa.y_km - sb.y_km);
      if (d < minPairKm || d > maxPairKm) continue;
      const xKm = 0.5 * (sa.x_km + sb.x_km);
      const yKm = 0.5 * (sa.y_km + sb.y_km);
      if (tooCloseToSites(xKm, yKm, siteList, nearSiteKm)) continue;
      points.push({
        kind: "mid",
        id: `${sa.id}_${sb.id}`,
        label: "",
        xKm,
        yKm,
      });
    }
  }

  if (vol && vol.x_km && vol.y_km) {
    const xs = vol.x_km;
    const ys = vol.y_km;
    for (let i = 0; i < ys.length; i += gridStride) {
      for (let j = 0; j < xs.length; j += gridStride) {
        const xKm = xs[j];
        const yKm = ys[i];
        if (tooCloseToSites(xKm, yKm, siteList, nearSiteKm * 1.15)) continue;
        let nearMid = false;
        for (let p = 0; p < points.length; p += 1) {
          if (points[p].kind === "site") continue;
          if (Math.hypot(points[p].xKm - xKm, points[p].yKm - yKm) < nearSiteKm * 0.85) {
            nearMid = true;
            break;
          }
        }
        if (nearMid) continue;
        points.push({
          kind: "grid",
          id: `g_${i}_${j}`,
          label: "",
          xKm,
          yKm,
        });
      }
    }
  }

  return points;
}

function tooCloseToSites(xKm, yKm, sites, threshKm) {
  for (let i = 0; i < sites.length; i += 1) {
    if (Math.hypot(sites[i].x_km - xKm, sites[i].y_km - yKm) < threshKm) return true;
  }
  return false;
}

function prominenceForKind(kind) {
  if (kind === "site") {
    return { opacity: 1, spriteScale: 1, isObs: true };
  }
  if (kind === "popup") {
    return { opacity: 1, spriteScale: 1, isObs: false };
  }
  return { opacity: 0.35, spriteScale: 0.45, isObs: false };
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * Logical-size canvas with HiDPI backing store (sharper popup / export text).
 * Drawing uses logical CSS pixels; setTransform scales for devicePixelRatio.
 */
function setupHiDpiCanvas(logicalW, logicalH, pixelRatio) {
  const dpr = Math.max(1, Math.min(Number(pixelRatio) || 1, 3));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(logicalW * dpr));
  canvas.height = Math.max(1, Math.round(logicalH * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { canvas, ctx, dpr };
}

function dataRange(z, values, zMin, zMax, fallbackLo, fallbackHi) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < (values || []).length; i += 1) {
    if (!Number.isFinite(values[i]) || !Number.isFinite(z[i])) continue;
    if (z[i] < zMin || z[i] > zMax) continue;
    lo = Math.min(lo, values[i]);
    hi = Math.max(hi, values[i]);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    return { lo: fallbackLo, hi: fallbackHi };
  }
  const pad = (hi - lo) * 0.06 || 0.5;
  return { lo: lo - pad, hi: hi + pad };
}

function drawSeriesInPanel(ctx, box, z, values, color, zMin, zMax, xLo, xHi, lineWidth, dash) {
  const pts = [];
  for (let i = 0; i < (z || []).length; i += 1) {
    if (!Number.isFinite(z[i]) || !Number.isFinite(values[i])) continue;
    if (z[i] < zMin || z[i] > zMax) continue;
    const x = box.x + ((values[i] - xLo) / (xHi - xLo || 1)) * box.w;
    const y = box.y + box.h - ((z[i] - zMin) / (zMax - zMin || 1)) * box.h;
    pts.push({ x, y });
  }
  if (pts.length < 2) return false;
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  if (dash && dash.length) ctx.setLineDash(dash);
  else ctx.setLineDash([]);
  ctx.stroke();
  ctx.setLineDash([]);
  return true;
}

/** Scatter markers (for WD — avoids wrap jumps at 0/360).
 * @param {number} [radius]
 * @param {{ filled?: boolean, lineWidth?: number }} [style]
 */
function drawPointsInPanel(ctx, box, z, values, color, zMin, zMax, xLo, xHi, radius, style) {
  const r = radius != null ? radius : 2.2;
  const filled = !(style && style.filled === false);
  const lw = (style && style.lineWidth) || 1.1;
  let n = 0;
  for (let i = 0; i < (z || []).length; i += 1) {
    if (!Number.isFinite(z[i]) || !Number.isFinite(values[i])) continue;
    if (z[i] < zMin || z[i] > zMax) continue;
    const x = box.x + ((values[i] - xLo) / (xHi - xLo || 1)) * box.w;
    const y = box.y + box.h - ((z[i] - zMin) / (zMax - zMin || 1)) * box.h;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    if (filled) {
      ctx.fillStyle = color;
      ctx.fill();
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
    n += 1;
  }
  return n > 0;
}

function niceTicks(lo, hi, count) {
  const n = Math.max(2, count || 3);
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push(lo + ((hi - lo) * i) / (n - 1));
  }
  return out;
}

function formatTick(v, lo, hi) {
  const span = Math.abs(hi - lo);
  if (span >= 40) return String(Math.round(v));
  if (span >= 8) return String(Math.round(v));
  return (Math.round(v * 10) / 10).toFixed(1);
}

/**
 * Bottom axis ticks (primary var) + optional top axis ticks (secondary var).
 */
function drawPanelAxisTicks(ctx, box, bottom, top) {
  ctx.font = "7px IBM Plex Sans, sans-serif";
  if (bottom) {
    const ticks = niceTicks(bottom.lo, bottom.hi, bottom.count || 3);
    ctx.fillStyle = bottom.color || "#64748b";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ticks.forEach((v) => {
      const x = box.x + ((v - bottom.lo) / (bottom.hi - bottom.lo || 1)) * box.w;
      ctx.fillStyle = "rgba(148,163,184,0.45)";
      ctx.fillRect(x, box.y + box.h, 1, 3);
      ctx.fillStyle = bottom.color || "#64748b";
      ctx.fillText(formatTick(v, bottom.lo, bottom.hi), x, box.y + box.h + 3);
    });
  }
  if (top) {
    const ticks = niceTicks(top.lo, top.hi, top.count || 3);
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ticks.forEach((v) => {
      const x = box.x + ((v - top.lo) / (top.hi - top.lo || 1)) * box.w;
      ctx.fillStyle = "rgba(148,163,184,0.45)";
      ctx.fillRect(x, box.y - 3, 1, 3);
      ctx.fillStyle = top.color || "#64748b";
      ctx.fillText(formatTick(v, top.lo, top.hi), x, box.y - 3);
    });
  }
}

/**
 * Short label for the active fusion volume (A / B / C / HRRR).
 * @param {string} [modelId]
 * @returns {string} e.g. "fusion cube A"
 */
function fusionCubeTitle(modelId) {
  const id = String(modelId || "").trim();
  if (!id) return "fusion cube";
  return `fusion cube ${id}`;
}

/**
 * Fixed two-panel station profile: left T (°C) + RH (%); right WS (m/s) + WD (°).
 * Cube/fusion = thick solid; optional UAS obs = thinner dashed (same colors).
 * All panels share FIXED_PROFILE_AXES. WD is points (no line wrap at 0/360).
 * @param {object} cols { z, temperature, relative_humidity, wind_speed, wind_dir }
 * @param {object} [opts.obs] same shape from UAS sounding when available
 * @param {string} [opts.cubeLabel] fusion state id (A/B/C/…) for the subtitle
 */
function drawStationProfileCanvas(cols, opts) {
  const o = opts || {};
  const w = o.width || 320;
  const h = o.height || 240;
  const { canvas, ctx } = setupHiDpiCanvas(w, h, o.pixelRatio);
  const bg = o.bg != null ? o.bg : "rgba(255,255,255,0.96)";
  const accent = o.accent || "#B900C7";
  const z = (cols && cols.z) || [];
  const ax = { ...FIXED_PROFILE_AXES, ...(o.axes || {}) };
  const zMin = ax.zMin;
  const zMax = ax.zMax;
  const isSite = o.kind === "site";
  const isPopup = o.kind === "popup";
  const obs = o.obs || null;
  const hasObs = !!(obs && Array.isArray(obs.z) && obs.z.length > 1);
  const cubeTitle = fusionCubeTitle(o.cubeLabel);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = bg;
  roundRect(ctx, 2, 2, w - 4, h - 4, 6);
  ctx.fill();
  if (isSite || isPopup) {
    ctx.strokeStyle = accent;
    ctx.lineWidth = isPopup ? 4 : 5;
    roundRect(ctx, 3, 3, w - 6, h - 6, 5);
    ctx.stroke();
  } else {
    ctx.strokeStyle = "rgba(100,116,139,0.7)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    roundRect(ctx, 2, 2, w - 4, h - 4, 4);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const title = o.label
    ? isPopup && !o.siteId
      ? o.label
      : String(o.label)
    : isPopup
      ? "Grid sample"
      : "Site";
  ctx.fillStyle = accent;
  ctx.font = `bold ${isPopup ? 14 : 12}px IBM Plex Sans, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(title, 10, 16);
  ctx.fillStyle = "#64748b";
  ctx.font = "8px IBM Plex Sans, sans-serif";
  ctx.fillText(
    hasObs
      ? `T·RH | WS·WD° — ${cubeTitle} · UAS thin`
      : `T·RH | WS·WD° — ${cubeTitle}`,
    10,
    28
  );

  const gap = 12;
  const top = 48;
  const bottom = 28;
  const side = 22;
  const mid = w / 2;
  const panelH = h - top - bottom;
  const leftBox = { x: side, y: top, w: mid - side - gap / 2 - 4, h: panelH };
  const rightBox = { x: mid + gap / 2, y: top, w: mid - side - gap / 2 - 4, h: panelH };

  ctx.strokeStyle = "#e2e8f0";
  ctx.lineWidth = 1;
  ctx.strokeRect(leftBox.x, leftBox.y, leftBox.w, leftBox.h);
  ctx.strokeRect(rightBox.x, rightBox.y, rightBox.w, rightBox.h);

  // Height ticks (left of left panel)
  ctx.fillStyle = "#94a3b8";
  ctx.font = "7px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const zm of [0, 500, 1000, 1500]) {
    const y = leftBox.y + leftBox.h - ((zm - zMin) / (zMax - zMin)) * leftBox.h;
    ctx.fillText(`${zm}`, leftBox.x - 3, y);
  }

  const tLo = ax.tLo;
  const tHi = ax.tHi;
  const rhLo = ax.rhLo;
  const rhHi = ax.rhHi;
  const wsLo = ax.wsLo;
  const wsHi = ax.wsHi;
  const wdLo = ax.wdLo;
  const wdHi = ax.wdHi;
  const thick = isSite || isPopup ? 2.5 : 1.6;
  const thin = 1.15;
  const ptR = isSite || isPopup ? 1.55 : 1.2;
  const ptRObs = isSite || isPopup ? 1.85 : 1.4;

  drawSeriesInPanel(
    ctx, leftBox, z, cols.temperature, PROFILE_COLORS.temperature,
    zMin, zMax, tLo, tHi, thick, null
  );
  drawSeriesInPanel(
    ctx, leftBox, z, cols.relative_humidity, PROFILE_COLORS.relative_humidity,
    zMin, zMax, rhLo, rhHi, thick, null
  );
  if (hasObs) {
    drawSeriesInPanel(
      ctx, leftBox, obs.z, obs.temperature, PROFILE_COLORS.temperature,
      zMin, zMax, tLo, tHi, thin, [3, 2.5]
    );
    drawSeriesInPanel(
      ctx, leftBox, obs.z, obs.relative_humidity, PROFILE_COLORS.relative_humidity,
      zMin, zMax, rhLo, rhHi, thin, [3, 2.5]
    );
  }

  drawSeriesInPanel(
    ctx, rightBox, z, cols.wind_speed, PROFILE_COLORS.wind_speed,
    zMin, zMax, wsLo, wsHi, thick, null
  );
  drawPointsInPanel(
    ctx, rightBox, z, cols.wind_dir, PROFILE_COLORS.wind_dir,
    zMin, zMax, wdLo, wdHi, ptR, { filled: true }
  );
  if (hasObs) {
    drawSeriesInPanel(
      ctx, rightBox, obs.z, obs.wind_speed, PROFILE_COLORS.wind_speed,
      zMin, zMax, wsLo, wsHi, thin, [3, 2.5]
    );
    if (obs.wind_dir) {
      drawPointsInPanel(
        ctx, rightBox, obs.z, obs.wind_dir, PROFILE_COLORS.wind_dir,
        zMin, zMax, wdLo, wdHi, ptRObs, { filled: false, lineWidth: 1.15 }
      );
    }
  }

  drawPanelAxisTicks(
    ctx,
    leftBox,
    { lo: tLo, hi: tHi, color: PROFILE_COLORS.temperature, count: 4 },
    { lo: rhLo, hi: rhHi, color: PROFILE_COLORS.relative_humidity, count: 3 }
  );
  drawPanelAxisTicks(
    ctx,
    rightBox,
    { lo: wsLo, hi: wsHi, color: PROFILE_COLORS.wind_speed, count: 4 },
    { lo: wdLo, hi: wdHi, color: PROFILE_COLORS.wind_dir, count: 3 }
  );

  ctx.font = "8px IBM Plex Sans, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const legY = h - 6;
  ctx.fillStyle = PROFILE_COLORS.temperature;
  ctx.fillText("T °C ↓", leftBox.x, legY);
  ctx.fillStyle = PROFILE_COLORS.relative_humidity;
  ctx.fillText("RH % ↑", leftBox.x + 42, legY);
  ctx.fillStyle = PROFILE_COLORS.wind_speed;
  ctx.fillText("WS ↓", rightBox.x, legY);
  ctx.fillStyle = PROFILE_COLORS.wind_dir;
  ctx.fillText("WD° pts ↑", rightBox.x + 36, legY);
  if (hasObs) {
    ctx.fillStyle = accent;
    ctx.fillText("UAS —", rightBox.x + 100, legY);
  }

  return canvas;
}

/** @deprecated single-var profile — prefer drawStationProfileCanvas */
function drawProfileCanvas(z, values, opts) {
  return drawStationProfileCanvas(
    {
      z,
      temperature: values,
      relative_humidity: values,
      wind_speed: values,
      wind_dir: values,
    },
    opts
  );
}

/**
 * Draw a compact hodograph (u east, v north) on a canvas.
 * Cube = thick; optional UAS obs (opts.obsZ/obsU/obsV) = thinner dashed.
 * @param {string} [opts.cubeLabel] fusion state id (A/B/C/…) for the subtitle
 */
function drawHodographCanvas(z, uArr, vArr, opts) {
  const o = opts || {};
  const w = o.width || 112;
  const h = o.height || 112;
  const { canvas, ctx } = setupHiDpiCanvas(w, h, o.pixelRatio);
  const bg = o.bg != null ? o.bg : "rgba(255,255,255,0.9)";
  const stroke = o.stroke || "#3018A9";
  const zMin = o.zMin != null ? o.zMin : HODO_Z_MIN_M;
  const accent = o.accent || "#B900C7";
  const obsZ = o.obsZ || null;
  const obsU = o.obsU || null;
  const obsV = o.obsV || null;
  const hasObs = !!(obsZ && obsU && obsV && obsZ.length > 1);
  const cubeTitle = fusionCubeTitle(o.cubeLabel);

  function collectPts(zz, uu, vv) {
    const out = [];
    let maxR = 6;
    for (let i = 0; i < (zz || []).length; i += 1) {
      if (!Number.isFinite(zz[i]) || zz[i] < zMin) continue;
      const u = uu[i];
      const v = vv[i];
      if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
      const r = Math.hypot(u, v);
      if (r > maxR) maxR = r;
      out.push({ u, v });
    }
    return { pts: out, maxR };
  }

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = bg;
  roundRect(ctx, 2, 2, w - 4, h - 4, 6);
  ctx.fill();
  if (o.kind === "site" || o.kind === "popup") {
    ctx.strokeStyle = accent;
    ctx.lineWidth = o.kind === "popup" ? 4 : 5;
    roundRect(ctx, 3, 3, w - 6, h - 6, 5);
    ctx.stroke();
    ctx.fillStyle = accent;
    ctx.font = "bold 12px IBM Plex Sans, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(o.label || (o.kind === "popup" ? "Grid sample" : "Site"), 8, 15);
    ctx.fillStyle = "#64748b";
    ctx.font = "9px IBM Plex Sans, sans-serif";
    ctx.fillText(
      hasObs ? `${cubeTitle} · UAS thin` : cubeTitle,
      8,
      28
    );
  } else {
    ctx.strokeStyle = "rgba(100,116,139,0.7)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    roundRect(ctx, 2, 2, w - 4, h - 4, 4);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const cx = w / 2;
  const cy = h / 2 + (o.kind === "site" || o.kind === "popup" ? 8 : 0);
  const main = collectPts(z, uArr, vArr);
  const obs = hasObs ? collectPts(obsZ, obsU, obsV) : { pts: [], maxR: 0 };
  const maxR =
    o.maxR != null && Number.isFinite(o.maxR)
      ? Math.max(4, o.maxR)
      : FIXED_HODO_MAX_R;
  const scale =
    (Math.min(w, h) / 2 - (o.kind === "site" || o.kind === "popup" ? 22 : 12)) / maxR;

  ctx.strokeStyle = "rgba(100,116,139,0.35)";
  ctx.lineWidth = 0.8;
  for (let r = 5; r <= maxR; r += 5) {
    ctx.beginPath();
    ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(10, cy);
  ctx.lineTo(w - 10, cy);
  ctx.moveTo(cx, (o.kind === "site" || o.kind === "popup" ? 32 : 14));
  ctx.lineTo(cx, h - 14);
  ctx.strokeStyle = "rgba(100,116,139,0.45)";
  ctx.stroke();

  // Shared u/v axis labels (m/s)
  ctx.fillStyle = "#64748b";
  ctx.font = "7px IBM Plex Sans, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(`±${maxR} m/s`, cx, h - 12);
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText("u→", w - 22, cy - 8);
  ctx.fillText("v↑", cx + 4, (o.kind === "site" || o.kind === "popup" ? 34 : 16));
  // Ring labels
  ctx.textAlign = "left";
  ctx.fillStyle = "#94a3b8";
  for (let r = 10; r <= maxR; r += 10) {
    ctx.fillText(String(r), cx + r * scale + 2, cy + 8);
  }

  function strokeHodo(pts, color, width, dash) {
    if (pts.length < 2) return;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 1) {
      const x = cx + pts[i].u * scale;
      const y = cy - pts[i].v * scale;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    if (dash) ctx.setLineDash(dash);
    else ctx.setLineDash([]);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(cx + pts[0].u * scale, cy - pts[0].v * scale, width > 2 ? 4 : 2.5, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  if (main.pts.length < 2 && obs.pts.length < 2) {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("—", cx, cy + 3);
    return canvas;
  }

  strokeHodo(
    main.pts,
    o.kind === "site" || o.kind === "popup" ? accent : stroke,
    o.kind === "site" || o.kind === "popup" ? 2.8 : 1.2,
    null
  );
  if (hasObs) strokeHodo(obs.pts, accent, 1.2, [3, 2.5]);

  return canvas;
}

function canvasToDataUrl(canvas) {
  return canvas.toDataURL("image/png");
}

export {
  buildOverlaySamplePoints,
  prominenceForKind,
  fusionCubeTitle,
  drawStationProfileCanvas,
  drawProfileCanvas,
  drawHodographCanvas,
  windDirFromUV,
  windDirSeries,
  normalizeObsColumns,
  canvasToDataUrl,
  PROFILE_COLORS,
  HODO_Z_MIN_M,
  FIXED_PROFILE_AXES,
  FIXED_HODO_MAX_R,
};
