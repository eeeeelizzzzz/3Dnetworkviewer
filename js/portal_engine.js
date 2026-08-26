/**
 * Interactive 3D volume engine: multi-layer isosurfaces, features, terrain/geo,
 * section drawing.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  decodeU8Field,
  smoothVolume,
  isosurfaceMesh,
  horizontalSliceMesh,
  heightSurfaceMesh,
  makeColorMap,
  LAYER_PALETTE,
  colorHexForValue,
} from "./marching_cubes.js?v=20260822n";
import {
  buildOverlaySamplePoints,
  prominenceForKind,
  drawStationProfileCanvas,
  drawHodographCanvas,
  windDirSeries,
  normalizeObsColumns,
  fusionCubeTitle,
} from "./map_overlays.js?v=20260822n";

export function createEngine(container) {
  const state = {
    meta: null,
    model: "B",
    timeIndex: 0,
    variable: "wind_speed",
    mode: "isosurface", // isosurface | slice
    isoLevels: [8, 10, 12],
    focusLayer: -1, // -1 = all equal; else highlight index
    smoothPasses: 2, // fixed soft smooth (no user control)
    sliceK: 25,
    opacity: 0.72,
    terrainOpacity: 0.25,
    layerColors: [0x38bdf8, 0xa78bfa, 0x34d399, 0xfbbf24, 0xf472b6],
    layerOpacities: [0.72, 0.72, 0.72, 0.72, 0.72],
    // Quantitative color scale (slice + HUD + optional iso coloring)
    colorMapName: "viridis",
    colorVmin: null, // null → use field meta
    colorVmax: null,
    contourInterval: null,
    colorLayersFromMap: true,
    pollEnabled: true,
    pollHeightM: 100,
    vertExag: 25,
    showSites: true,
    siteObsActive: null, // null = unknown/all lit; else {siteId: bool}
    showTerrain: true,
    showVolume: true,
    showGeo: true,
    zMode: "flat", // 'flat' | 'terrain'
    showAxes: true,
    okFlatGroup: null,
    featuresOn: { nllj_height: false, inversion_height: false, pbl_height: false },
    volumeCache: new Map(),
    featureCache: new Map(),
    currentVolume: null,
    currentValues: null,
    currentFieldMeta: null,
    terrainFloat: null, // Float32Array ny*nx + .ref + dims
    geo: null,
    selectedSite: null,
    onSiteClick: null,
    onStatus: null,
    onSection: null,
    onSectionCleared: null,
    drawMode: null, // null | 'section'
    drawPoints: [],
    terrainMesh: null,
    volumeGroup: null,
    featureGroup: null,
    geoGroup: null,
    siteGroup: null,
    mapOverlayGroup: null,
    // off | profile | hodograph — site + interstitial cube samples on the map
    mapOverlayMode: "off",
    mapOverlayVariable: "wind_speed",
    obsBySite: null, // { siteId: UAS column dict } for current valid time
    sectionLine: null,
    domainBox: null,
    probeMarker: null,
    onProbe: null,
    onPoll: null,
    lastProbe: null,
    lastPoll: null,
  };

  const scene = new THREE.Scene();
  // Mild distance falloff only — never crush side/angled views
  scene.fog = new THREE.Fog(0x0b1220, 380, 1100);
  const camera = new THREE.PerspectiveCamera(
    40,
    container.clientWidth / Math.max(container.clientHeight, 1),
    0.1,
    4000
  );
  camera.position.set(-180, 90, 40);

  // preserveDrawingBuffer so viewport PNG export can read pixels reliably
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.setClearColor(0x0b1220, 1);
  if (renderer.outputColorSpace !== undefined) {
    renderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  if (renderer.toneMappingExposure !== undefined) {
    renderer.toneMappingExposure = 1.15;
  }
  container.appendChild(renderer.domElement);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 18, 0);
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 40;
  controls.maxDistance = 800;

  // Bright, even lighting so orbiting doesn't black out the volume
  scene.add(new THREE.AmbientLight(0xe8eef8, 1.05));
  const hemi = new THREE.HemisphereLight(0xd8e8ff, 0x4a4035, 0.7);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffffff, 1.15);
  key.position.set(120, 180, 90);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc8d4ff, 0.72);
  fill.position.set(-100, 80, -70);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffe8c8, 0.55);
  rim.position.set(40, 60, -140);
  scene.add(rim);
  const under = new THREE.DirectionalLight(0xa0b8e0, 0.35);
  under.position.set(0, -40, 20);
  scene.add(under);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  // Domain / section groups
  state.axisGroup = null;
  state.sectionGroup = null;
  state.onDrawModeChange = null;
  state.triadGroup = null;
  state.triadDragging = false;

  function emitStatus(msg) {
    if (typeof state.onStatus === "function") state.onStatus(msg);
  }

  function resize() {
    const w = container.clientWidth;
    const h = Math.max(container.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  }

  function domainExtents() {
    const proj = (state.meta && state.meta.projection) || {};
    const xMin = proj.x_min != null ? proj.x_min : -100;
    const xMax = proj.x_max != null ? proj.x_max : 100;
    const yMin = proj.y_min != null ? proj.y_min : -100;
    const yMax = proj.y_max != null ? proj.y_max : 100;
    // Flat AGL frame tops at analysis height (1500 m). Terrain-following
    // volumes sit on MSL + AGL and need a higher domain box (~2000 m).
    const flatZ =
      proj.z_max_m != null && Number.isFinite(proj.z_max_m) ? proj.z_max_m : 1500;
    const zMaxM = state.zMode === "terrain" ? Math.max(flatZ, 2000) : flatZ;
    const zTop = (zMaxM / 1000) * state.vertExag;
    return {
      xMin,
      xMax,
      yMin,
      yMax,
      zMaxM,
      zTop,
      cx: 0.5 * (xMin + xMax),
      cy: 0.5 * (yMin + yMax),
      spanX: xMax - xMin,
      spanY: yMax - yMin,
    };
  }

  /** True if map km coords lie inside (or on) the analysis cube domain. */
  function isInDomain(xKm, yKm, padKm = 0) {
    if (xKm == null || yKm == null || !Number.isFinite(xKm) || !Number.isFinite(yKm)) {
      return false;
    }
    const d = domainExtents();
    const pad = Math.max(0, Number(padKm) || 0);
    return (
      xKm >= d.xMin - pad &&
      xKm <= d.xMax + pad &&
      yKm >= d.yMin - pad &&
      yKm <= d.yMax + pad
    );
  }

  function effectiveColorRange() {
    const meta = state.currentFieldMeta || {};
    const lo =
      state.colorVmin != null && Number.isFinite(state.colorVmin)
        ? state.colorVmin
        : meta.vmin != null
          ? meta.vmin
          : 0;
    const hi =
      state.colorVmax != null && Number.isFinite(state.colorVmax)
        ? state.colorVmax
        : meta.vmax != null
          ? meta.vmax
          : lo + 1;
    return {
      min: lo,
      max: hi <= lo ? lo + 1e-6 : hi,
      unit: meta.unit || "",
      label: meta.label || state.variable,
      mapName: state.colorMapName || "viridis",
    };
  }

  function layerColorForIso(iso, li) {
    if (state.colorLayersFromMap) {
      const r = effectiveColorRange();
      const hex = colorHexForValue(iso, r.min, r.max, r.mapName);
      return parseInt(hex.slice(1), 16);
    }
    if (state.layerColors && state.layerColors[li] != null) return state.layerColors[li];
    return LAYER_PALETTE[li % LAYER_PALETTE.length];
  }

  function setCameraPreset(kind) {
    const d = domainExtents();
    let midY = 0.42 * d.zTop;
    if (state.zMode === "terrain" && state.terrainFloat) {
      const meanM =
        0.5 *
        ((state.terrainFloat.emin || 200) + (state.terrainFloat.emax || 450));
      midY = (meanM / 1000) * state.vertExag + 0.35 * d.zTop;
    }
    const targetY = midY * 0.35;
    controls.target.set(d.cx, targetY, -d.cy);
    const spanNS = Math.max(d.spanY, 80);
    const spanEW = Math.max(d.spanX, 60);
    // Slightly wider framing so scale-box edges stay visible in aspect
    const distNS = spanNS * 1.05;
    const distEW = spanEW * 1.2;
    const viewElevRad = (15 * Math.PI) / 180; // 15° above horizontal
    if (kind === "top") {
      camera.position.set(d.cx, Math.max(distNS, distEW) * 1.35, -d.cy + distNS * 0.05);
    } else if (kind === "side" || kind === "west") {
      const R = distEW * 1.35;
      camera.position.set(
        d.cx - R * Math.cos(viewElevRad),
        targetY + R * Math.sin(viewElevRad),
        -d.cy
      );
    } else if (kind === "north") {
      const R = distNS * 1.35;
      camera.position.set(
        d.cx,
        targetY + R * Math.sin(viewElevRad),
        -d.cy - R * Math.cos(viewElevRad)
      );
    } else {
      // Default / reset: from south looking north, 15° elevation
      const R = Math.max(distNS, distEW * 0.9) * 1.35;
      camera.position.set(
        d.cx,
        targetY + R * Math.sin(viewElevRad),
        -d.cy + R * Math.cos(viewElevRad)
      );
    }
    controls.update();
  }

  function getCompassRotationDeg() {
    const dx = controls.target.x - camera.position.x;
    const dz = controls.target.z - camera.position.z;
    const viewAngle = Math.atan2(dx, -dz); // 0 = looking north
    return (-viewAngle * 180) / Math.PI;
  }

  function buildAxisHelpers(visible) {
    state.showAxes = !!visible;
    disposeObject(state.triadGroup);
    state.triadGroup = null;
    disposeObject(state.axisGroup);
    state.axisGroup = null;
    if (visible) rebuildScaleBox();
  }

  function boxLabelSprite(text, color = "#e2e8f0") {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 40;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "rgba(8,12,22,0.55)";
    ctx.fillRect(0, 0, 160, 40);
    ctx.fillStyle = color;
    ctx.font = "bold 18px IBM Plex Sans, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 80, 22);
    const spr = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        depthTest: false,
      })
    );
    spr.scale.set(18, 4.5, 1);
    spr.renderOrder = 35;
    return spr;
  }

  /** Domain scale box with W–E / N–S distance and height ticks (m AGL). */
  function rebuildScaleBox() {
    disposeObject(state.axisGroup);
    state.axisGroup = null;
    if (!state.showAxes || !state.meta) return;
    const d = domainExtents();
    const g = new THREE.Group();
    g.name = "scaleBox";
    const y0 = 0.05;
    const zTop = d.zTop;
    const col = 0x94a3b8;
    const bright = 0xe2e8f0;

    function addLine(a, b, color = col, op = 0.75) {
      const ln = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([a, b]),
        new THREE.LineBasicMaterial({
          color,
          transparent: true,
          opacity: op,
          depthTest: false,
        })
      );
      ln.renderOrder = 30;
      g.add(ln);
    }

    const sw = new THREE.Vector3(d.xMin, y0, -d.yMin);
    const se = new THREE.Vector3(d.xMax, y0, -d.yMin);
    const ne = new THREE.Vector3(d.xMax, y0, -d.yMax);
    const nw = new THREE.Vector3(d.xMin, y0, -d.yMax);
    addLine(sw, se, bright, 0.9);
    addLine(se, ne, bright, 0.9);
    addLine(ne, nw, bright, 0.9);
    addLine(nw, sw, bright, 0.9);
    [sw, se, ne, nw].forEach((c) => {
      addLine(c, new THREE.Vector3(c.x, zTop, c.z), col, 0.4);
    });
    addLine(new THREE.Vector3(d.xMin, zTop, -d.yMin), new THREE.Vector3(d.xMax, zTop, -d.yMin), col, 0.35);
    addLine(new THREE.Vector3(d.xMax, zTop, -d.yMin), new THREE.Vector3(d.xMax, zTop, -d.yMax), col, 0.35);
    addLine(new THREE.Vector3(d.xMax, zTop, -d.yMax), new THREE.Vector3(d.xMin, zTop, -d.yMax), col, 0.35);
    addLine(new THREE.Vector3(d.xMin, zTop, -d.yMax), new THREE.Vector3(d.xMin, zTop, -d.yMin), col, 0.35);

    for (let dx = 0; dx <= d.spanX + 0.01; dx += 50) {
      const xx = d.xMin + dx;
      if (xx > d.xMax + 0.01) break;
      addLine(new THREE.Vector3(xx, y0, -d.yMin), new THREE.Vector3(xx, y0, -d.yMin - 5), 0xcbd5e1, 0.85);
      if (dx > 0) {
        const lab = boxLabelSprite(`${Math.round(dx)} km`, "#fca5a5");
        lab.position.set(xx, y0 + 2, -d.yMin - 12);
        g.add(lab);
      }
    }
    for (let dy = 0; dy <= d.spanY + 0.01; dy += 50) {
      const yy = d.yMin + dy;
      if (yy > d.yMax + 0.01) break;
      addLine(new THREE.Vector3(d.xMin, y0, -yy), new THREE.Vector3(d.xMin - 5, y0, -yy), 0xcbd5e1, 0.85);
      if (dy > 0) {
        const lab = boxLabelSprite(`${Math.round(dy)} km`, "#86efac");
        lab.position.set(d.xMin - 14, y0 + 2, -yy);
        g.add(lab);
      }
    }
    for (let zm = 0; zm <= d.zMaxM + 0.01; zm += 250) {
      const yy = (zm / 1000) * state.vertExag;
      const tlen = zm % 500 === 0 ? 6 : 3.5;
      addLine(
        new THREE.Vector3(d.xMin, yy, -d.yMin),
        new THREE.Vector3(d.xMin + tlen, yy, -d.yMin),
        0x7dd3fc,
        0.9
      );
      if (zm % 500 === 0) {
        const lab = boxLabelSprite(`${Math.round(zm)} m`, "#7dd3fc");
        lab.position.set(d.xMin - 10, yy, -d.yMin + 2);
        g.add(lab);
      }
    }
    const nLab = boxLabelSprite("N", "#86efac");
    nLab.position.set(d.cx, y0 + 3, -d.yMax - 10);
    const sLab = boxLabelSprite("S", "#86efac");
    sLab.position.set(d.cx, y0 + 3, -d.yMin + 10);
    const eLab = boxLabelSprite("E", "#fca5a5");
    eLab.position.set(d.xMax + 10, y0 + 3, -d.cy);
    const wLab = boxLabelSprite("W", "#fca5a5");
    wLab.position.set(d.xMin - 10, y0 + 3, -d.cy);
    g.add(nLab, sLab, eLab, wLab);
    scene.add(g);
    state.axisGroup = g;
  }

  function rebuildAxisMarker() {
    rebuildScaleBox();
  }

  /** Ground surface scene-Y: flat = 0; terrain-following = elev_MSL exaggerated. */
  function groundSceneY(xKm, yKmGeo) {
    if (state.zMode !== "terrain") return 0;
    return (terrainElevM(xKm, yKmGeo) / 1000) * state.vertExag;
  }

  function terrainElevM(xKm, yKmGeo) {
    const elev = state.terrainFloat;
    if (!elev || !elev.xKm || !elev.yKm) return elev && elev.ref != null ? elev.ref : 250;
    const xs = elev.xKm;
    const ys = elev.yKm;
    // Critical: clamp to DEM domain — unclamped bilinear blows up for state lines far off-grid
    const xC = Math.max(xs[0], Math.min(xs[xs.length - 1], xKm));
    const yC = Math.max(ys[0], Math.min(ys[ys.length - 1], yKmGeo));
    let j = 0;
    while (j < xs.length - 1 && xs[j + 1] < xC) j += 1;
    let i = 0;
    while (i < ys.length - 1 && ys[i + 1] < yC) i += 1;
    const j1 = Math.min(xs.length - 1, j + 1);
    const i1 = Math.min(ys.length - 1, i + 1);
    const tx = Math.max(0, Math.min(1, (xC - xs[j]) / (xs[j1] - xs[j] || 1)));
    const ty = Math.max(0, Math.min(1, (yC - ys[i]) / (ys[i1] - ys[i] || 1)));
    const e00 = elev[i * elev.nx + j];
    const e10 = elev[i * elev.nx + j1];
    const e01 = elev[i1 * elev.nx + j];
    const e11 = elev[i1 * elev.nx + j1];
    const a = e00 * (1 - tx) + e10 * tx;
    const b = e01 * (1 - tx) + e11 * tx;
    const e = a * (1 - ty) + b * ty;
    return Number.isFinite(e) ? e : elev.ref || 250;
  }

  function volumeBaseY(xKm, yKmGeo) {
    return groundSceneY(xKm, yKmGeo);
  }

  function elevFnForVolume() {
    if (state.zMode !== "terrain") return null;
    return (xKm, yKm) => (terrainElevM(xKm, yKm) / 1000) * state.vertExag;
  }

  function sceneYAgl(xKm, yKmGeo, zAglM) {
    return volumeBaseY(xKm, yKmGeo) + (zAglM / 1000) * state.vertExag;
  }

  /** Map lines sit just above active ground (flat plane or DEM). */
  function mapSurfaceY(xKm, yKmGeo) {
    return groundSceneY(xKm, yKmGeo) + 0.45;
  }

  function terrainHeightAt(xKm, yKmGeo) {
    return mapSurfaceY(xKm, yKmGeo);
  }

  /**
   * Elevation → grayscale [0,1] RGB, black (low) → white (high).
   * Optional hillshade multiplies luminance for relief on a flat plane.
   */
  function elevColorRGB(eM, emin, emax, shade = 1) {
    let t = (eM - emin) / (emax - emin || 1);
    t = Math.max(0, Math.min(1, t));
    // Mild perceptual easing so mid-elevations still separate
    t = Math.pow(t, 0.9);
    // Hillshade: keep 55–100% of base so gray ramp still reads
    const s = 0.55 + 0.45 * Math.max(0, Math.min(1, shade));
    const g = t * s;
    return [g, g, g];
  }

  /** Simple NW light hillshade from DEM (unitless). */
  function hillshadeAt(elev, i, j, nx, ny, dxKm, dyKm) {
    const clampI = (ii) => Math.max(0, Math.min(ny - 1, ii));
    const clampJ = (jj) => Math.max(0, Math.min(nx - 1, jj));
    const e = (ii, jj) => {
      const v = elev[clampI(ii) * nx + clampJ(jj)];
      return Number.isFinite(v) ? v : elev.ref || 0;
    };
    // m per km slope factors (exaggerate a bit for flat-floor readability)
    const zx = ((e(i, j + 1) - e(i, j - 1)) / (2 * Math.max(dxKm, 0.5))) * 0.004;
    const zy = ((e(i + 1, j) - e(i - 1, j)) / (2 * Math.max(dyKm, 0.5))) * 0.004;
    // Surface normal ( -zx, 1, -zy ) · light from NW-up
    const nxn = -zx;
    const nyn = 1;
    const nzn = -zy;
    const inv = 1 / Math.hypot(nxn, nyn, nzn);
    const lx = -0.55;
    const ly = 0.75;
    const lz = 0.35;
    const linv = 1 / Math.hypot(lx, ly, lz);
    const dot =
      (nxn * inv) * (lx * linv) +
      (nyn * inv) * (ly * linv) +
      (nzn * inv) * (lz * linv);
    return Math.max(0.05, Math.min(1, 0.15 + 0.85 * Math.max(0, dot)));
  }

  function disposeObject(obj) {
    if (!obj) return;
    scene.remove(obj);
    obj.traverse((child) => {
      if (child.geometry) child.geometry.dispose();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      }
    });
  }

  async function fetchJson(rel) {
    const res = await fetch(`data/${rel}`);
    if (!res.ok) throw new Error(`Failed to load ${rel}`);
    return res.json();
  }

  async function fetchVolume(model, tag) {
    const key = `${model}/${tag}`;
    if (state.volumeCache.has(key)) return state.volumeCache.get(key);
    const path = state.meta.assets[model][tag];
    const js = await fetchJson(path);
    state.volumeCache.set(key, js);
    return js;
  }

  async function fetchFeatures(model, tag) {
    const key = `${model}/${tag}`;
    if (state.featureCache.has(key)) return state.featureCache.get(key);
    const path =
      state.meta.feature_assets &&
      state.meta.feature_assets[model] &&
      state.meta.feature_assets[model][tag];
    if (!path) return null;
    const js = await fetchJson(path);
    state.featureCache.set(key, js);
    return js;
  }

  async function loadGeo() {
    if (!state.meta || !state.meta.geo) return;
    try {
      if (state.meta.geo.context) {
        state.geo = await fetchJson(state.meta.geo.context);
      }
      if (state.meta.geo.terrain) {
        const t = await fetchJson(state.meta.geo.terrain);
        const n = t.elev_m.ny * t.elev_m.nx;
        const elev = decodeU8Field(t.elev_m, n);
        elev.ref = t.ref_m || t.elev_m.vmin;
        elev.nx = t.elev_m.nx;
        elev.ny = t.elev_m.ny;
        elev.xKm = t.x_km;
        elev.yKm = t.y_km;
        elev.emin = t.elev_m.vmin;
        elev.emax = t.elev_m.vmax;
        state.terrainFloat = elev;
        buildTerrainMesh(elev);
      }
      buildGeoLines();
    } catch (e) {
      console.warn("geo load", e);
    }
  }

  function buildTerrainMesh(elev) {
    disposeObject(state.terrainMesh);
    disposeObject(state.terrainContours);
    state.terrainContours = null;
    if (!elev || !state.showTerrain) return;
    const { nx, ny, xKm, yKm } = elev;
    // Robust color stretch: percentiles keep basin/ridge contrast full black→white
    const sample = [];
    for (let k = 0; k < elev.length; k += Math.max(1, Math.floor(elev.length / 2000))) {
      const v = elev[k];
      if (Number.isFinite(v)) sample.push(v);
    }
    sample.sort((a, b) => a - b);
    const pAt = (q) =>
      sample[Math.max(0, Math.min(sample.length - 1, Math.floor(q * (sample.length - 1))))];
    const eminRaw = elev.emin != null ? elev.emin : elev.ref;
    const emaxRaw = elev.emax != null ? elev.emax : elev.ref + 350;
    let cmin = eminRaw;
    let cmax = emaxRaw;
    if (sample.length > 8) {
      const p02 = pAt(0.02);
      const p98 = pAt(0.98);
      if (p98 - p02 > 40) {
        cmin = p02;
        cmax = p98;
      }
    }
    elev.cmin = cmin;
    elev.cmax = cmax;

    const following = state.zMode === "terrain";
    const dxKm =
      nx > 1 ? Math.abs(xKm[Math.min(1, nx - 1)] - xKm[0]) || 3 : 3;
    const dyKm =
      ny > 1 ? Math.abs(yKm[Math.min(1, ny - 1)] - yKm[0]) || 3 : 3;
    const positions = new Float32Array(ny * nx * 3);
    const colors = new Float32Array(ny * nx * 3);
    let pIdx = 0;
    let cIdx = 0;
    for (let i = 0; i < ny; i += 1) {
      for (let j = 0; j < nx; j += 1) {
        const e = elev[i * nx + j];
        const eUse = Number.isFinite(e) ? e : cmin;
        // Flat mode: planar floor with elev colors (+hillshade).
        // Terrain-following: full MSL relief.
        const h = following ? (eUse / 1000) * state.vertExag : 0;
        positions[pIdx++] = xKm[j];
        positions[pIdx++] = h;
        positions[pIdx++] = -yKm[i];
        const shade = hillshadeAt(elev, i, j, nx, ny, dxKm, dyKm);
        const rgb = elevColorRGB(eUse, cmin, cmax, shade);
        colors[cIdx++] = rgb[0];
        colors[cIdx++] = rgb[1];
        colors[cIdx++] = rgb[2];
      }
    }
    const indices = [];
    for (let i = 0; i < ny - 1; i += 1) {
      for (let j = 0; j < nx - 1; j += 1) {
        const a = i * nx + j;
        const b = a + 1;
        const d = (i + 1) * nx + j;
        const ee = d + 1;
        indices.push(a, b, ee, a, ee, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    // Flat floor: avoid light-speckle on planar mesh. Relief mesh uses soft lighting.
    const top = Math.max(0.05, Math.min(1, state.terrainOpacity));
    const mat = following
      ? new THREE.MeshLambertMaterial({
          vertexColors: true,
          transparent: true,
          opacity: top,
          depthWrite: top > 0.75,
          side: THREE.DoubleSide,
        })
      : new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: top,
          depthWrite: top > 0.75,
          side: THREE.DoubleSide,
        });
    if (following) geo.computeVertexNormals();
    state.terrainMesh = new THREE.Mesh(geo, mat);
    state.terrainMesh.renderOrder = 1;
    scene.add(state.terrainMesh);
  }

  /**
   * Path in km; elevationMode: 'surface' drapes on DEM/ground, 'flat' stays at yScene.
   */
  function lineFromKm(path2d, color, opacity = 0.9, elevMode = "surface", flatY = 0.08) {
    if (!path2d || path2d.length < 2) return null;
    // Clip to display domain so state outlines don't fire off-grid elevation / long spikes
    const d = domainExtents();
    const pad = 8;
    const x0 = d.xMin - pad;
    const x1 = d.xMax + pad;
    const y0 = d.yMin - pad;
    const y1 = d.yMax + pad;
    const densifyStep = 3.5; // km

    const segs = [];
    let cur = [];
    function flush() {
      if (cur.length >= 2) segs.push(cur);
      cur = [];
    }
    function addPt(x, yGeo) {
      if (x < x0 || x > x1 || yGeo < y0 || yGeo > y1) {
        flush();
        return;
      }
      const yy =
        elevMode === "flat" ? flatY : mapSurfaceY(x, yGeo);
      cur.push(new THREE.Vector3(x, yy, -yGeo));
    }

    for (let i = 0; i < path2d.length - 1; i += 1) {
      const a = path2d[i];
      const b = path2d[i + 1];
      if (!a || !b || a.length < 2 || b.length < 2) {
        flush();
        continue;
      }
      const ax = a[0];
      const ay = a[1];
      const bx = b[0];
      const by = b[1];
      const segLen = Math.hypot(bx - ax, by - ay);
      if (segLen > 180) {
        flush();
        continue;
      }
      const n = Math.max(1, Math.ceil(segLen / densifyStep));
      for (let k = 0; k <= n; k += 1) {
        if (k === 0 && cur.length) continue;
        const t = k / n;
        addPt(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }
    flush();
    if (!segs.length) return null;

    const mat = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthTest: false,
      depthWrite: false,
    });
    if (segs.length === 1) {
      const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(segs[0]), mat);
      ln.renderOrder = 12;
      return ln;
    }
    const grp = new THREE.Group();
    segs.forEach((pts) => {
      const ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat);
      ln.renderOrder = 12;
      grp.add(ln);
    });
    return grp;
  }

  /** Flat Oklahoma outline always at y≈0 — reference when terrain-following tilts the surface. */
  function buildFlatOkOutline() {
    disposeObject(state.okFlatGroup);
    state.okFlatGroup = null;
    if (!state.geo || !state.showGeo) return;
    const g = new THREE.Group();
    g.name = "okFlat";
    (state.geo.state || []).forEach((p) => {
      const ln = lineFromKm(p, 0xffffff, 1.0, "flat", 0.12);
      if (ln) g.add(ln);
    });
    if (!g.children.length) return;
    g.renderOrder = 14;
    scene.add(g);
    state.okFlatGroup = g;
  }

  function buildGeoLines() {
    disposeObject(state.geoGroup);
    // State outline is always flat (buildFlatOkOutline); counties/roads drape.
    if (!state.geo || !state.showGeo) {
      buildFlatOkOutline();
      return;
    }
    state.geoGroup = new THREE.Group();
    state.geoGroup.renderOrder = 10;
    (state.geo.counties || []).forEach((p) => {
      const ln = lineFromKm(p, 0xcbd5e1, 0.72, "surface");
      if (ln) state.geoGroup.add(ln);
    });
    (state.geo.highways || []).forEach((p) => {
      const ln = lineFromKm(p, 0xfdb863, 1.0, "surface");
      if (ln) state.geoGroup.add(ln);
    });
    (state.geo.cities || []).forEach((c) => {
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 32;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "rgba(15,23,42,0.7)";
      ctx.fillRect(0, 0, 128, 32);
      ctx.fillStyle = "#e2e8f0";
      ctx.font = "12px IBM Plex Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(c.name, 64, 20);
      const spr = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: new THREE.CanvasTexture(canvas),
          transparent: true,
          depthTest: false,
        })
      );
      spr.scale.set(16, 4, 1);
      const yh = mapSurfaceY(c.x_km, c.y_km) + 2;
      spr.position.set(c.x_km, yh, -c.y_km);
      spr.renderOrder = 12;
      state.geoGroup.add(spr);
    });
    scene.add(state.geoGroup);
    buildFlatOkOutline();
  }

  function buildSites() {
    disposeObject(state.siteGroup);
    state.siteGroup = new THREE.Group();
    if (!state.meta || !state.meta.sites) return;
    state.meta.sites.forEach((s) => {
      const base = volumeBaseY(s.x_km, s.y_km);
      const top = sceneYAgl(s.x_km, s.y_km, 1500);
      const h = Math.max(top - base, 1);
      const active = !state.siteObsActive ? true : !!state.siteObsActive[s.id];
      const col = active ? 0xb900c7 : 0x6b7280;
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(1.7, 14, 12),
        new THREE.MeshPhongMaterial({
          color: col,
          emissive: col,
          emissiveIntensity: active ? 0.35 : 0.04,
        })
      );
      mesh.position.set(s.x_km, base + 2.5, -s.y_km);
      mesh.userData.siteId = s.id;
      mesh.userData.role = "marker";
      state.siteGroup.add(mesh);
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.15, 0.15, h, 6),
        new THREE.MeshBasicMaterial({
          color: col,
          transparent: true,
          opacity: active ? 0.22 : 0.08,
        })
      );
      stem.position.set(s.x_km, base + h / 2, -s.y_km);
      stem.userData.siteId = s.id;
      stem.userData.role = "stem";
      state.siteGroup.add(stem);
      const canvas = document.createElement("canvas");
      canvas.width = 96;
      canvas.height = 28;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = active ? "rgba(11,15,25,0.8)" : "rgba(11,15,25,0.45)";
      ctx.fillRect(0, 0, 96, 28);
      ctx.fillStyle = active ? "#e2e8f0" : "#94a3b8";
      ctx.font = "bold 13px IBM Plex Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(s.id, 48, 18);
      const spr = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: new THREE.CanvasTexture(canvas),
          transparent: true,
          opacity: active ? 1 : 0.4,
          depthTest: false,
        })
      );
      spr.scale.set(12, 3.5, 1);
      spr.position.set(s.x_km, top + 2, -s.y_km);
      spr.userData.siteId = s.id;
      spr.userData.role = "label";
      state.siteGroup.add(spr);
    });
    state.siteGroup.visible = state.showSites;
    scene.add(state.siteGroup);
  }

  /** Apply purple (obs) vs gray (no UAS) styling to one site child. */
  function applySiteObsStyle(obj, active) {
    if (!obj || !obj.material) return;
    const col = active ? 0xb900c7 : 0x6b7280;
    const role = obj.userData.role;
    if (role === "marker") {
      if (obj.material.color) obj.material.color.setHex(col);
      if (obj.material.emissive) {
        obj.material.emissive.setHex(col);
        obj.material.emissiveIntensity = active ? 0.35 : 0.04;
      }
      obj.material.needsUpdate = true;
    } else if (role === "stem") {
      if (obj.material.color) obj.material.color.setHex(col);
      obj.material.opacity = active ? 0.22 : 0.08;
      obj.material.needsUpdate = true;
    } else if (role === "label") {
      obj.material.opacity = active ? 1 : 0.4;
      obj.material.needsUpdate = true;
    }
  }

  /**
   * Light up sites with UAS obs at the current valid time; gray otherwise.
   * @param {Record<string, boolean>} map siteId → hasObs
   */
  function setSiteObsAvailability(map) {
    state.siteObsActive = map && typeof map === "object" ? { ...map } : null;
    if (!state.siteGroup) return;
    state.siteGroup.children.forEach((child) => {
      const id = child.userData.siteId;
      if (!id) return;
      const active = state.siteObsActive ? !!state.siteObsActive[id] : true;
      applySiteObsStyle(child, active);
    });
  }

  function meshOpts(vol) {
    return {
      nx: vol.nx,
      ny: vol.ny,
      nz: vol.nz,
      xKm: vol.x_km,
      yKm: vol.y_km,
      zM: vol.z_m,
      vertExag: state.vertExag,
      elevFn: elevFnForVolume(),
    };
  }

  function rebuildVolumeMesh() {
    disposeObject(state.volumeGroup);
    state.volumeGroup = new THREE.Group();
    // Profiles / hodographs are alternative modes — no isosurface or slice mesh
    if (state.mode === "profiles" || state.mode === "hodographs") {
      return;
    }
    const vol = state.currentVolume;
    if (!vol || !state.currentValues || !state.showVolume) {
      emitStatus("No volume");
      return;
    }
    const field = state.currentFieldMeta;
    const unit = field.unit || "";
    const label = field.label || state.variable;
    const times = state.meta.times || [];
    const tlab = (times[state.timeIndex] && times[state.timeIndex].label) || "";
    const modelLabel =
      (state.meta.models.find((m) => m.id === state.model) || {}).label || state.model;

    let values = state.currentValues;
    // Fixed light smooth for cleaner shells (no user control)
    const smoothN = Math.max(1, state.smoothPasses | 0);
    values = smoothVolume(values, vol.nx, vol.ny, vol.nz, smoothN);
    const base = meshOpts(vol);

    if (state.mode === "slice") {
      const cr = effectiveColorRange();
      const cmap = makeColorMap(cr.min, cr.max, cr.mapName);
      const md = horizontalSliceMesh(
        values,
        { ...base, k: state.sliceK },
        cmap
      );
      if (md) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(md.positions, 3));
        geo.setAttribute("color", new THREE.BufferAttribute(md.colors, 3));
        geo.setIndex(new THREE.BufferAttribute(md.indices, 1));
        geo.computeVertexNormals();
        state.volumeGroup.add(
          new THREE.Mesh(
            geo,
            new THREE.MeshLambertMaterial({
              vertexColors: true,
              transparent: true,
              opacity: Math.min(1, state.opacity + 0.15),
              side: THREE.DoubleSide,
            })
          )
        );
        emitStatus(
          `${modelLabel} · ${label} slice @ ${md.z_m.toFixed(0)} m · ${tlab}`
        );
      }
      scene.add(state.volumeGroup);
      return;
    }

    // multi-layer isosurfaces
    const levels = state.isoLevels.filter((v) => Number.isFinite(v));
    let built = 0;
    levels.forEach((iso, li) => {
      const md = isosurfaceMesh(values, { ...base, iso, upsample: 2 });
      if (!md) return;
      built += 1;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(md.positions, 3));
      if (md.normals) geo.setAttribute("normal", new THREE.BufferAttribute(md.normals, 3));
      else geo.computeVertexNormals();
      geo.setIndex(new THREE.BufferAttribute(md.indices, 1));
      const dim = state.focusLayer >= 0 && state.focusLayer !== li;
      const col = layerColorForIso(iso, li);
      const baseOp =
        state.layerOpacities && state.layerOpacities[li] != null
          ? Math.max(0.02, Math.min(1, Number(state.layerOpacities[li])))
          : state.opacity;
      const op = dim ? baseOp * 0.18 : baseOp;
      const mat = new THREE.MeshStandardMaterial({
        color: col,
        emissive: col,
        emissiveIntensity: dim ? 0.08 : 0.28,
        transparent: true,
        opacity: op,
        side: THREE.DoubleSide,
        flatShading: false,
        metalness: 0.02,
        roughness: 0.55,
        depthWrite: !dim && op > 0.92,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.userData.layerIndex = li;
      mesh.userData.iso = iso;
      mesh.userData.baseOpacity = baseOp;
      state.volumeGroup.add(mesh);
    });
    scene.add(state.volumeGroup);
    const lvlStr = levels.map((v) => v.toFixed(1)).join(", ");
    const focusNote =
      state.focusLayer >= 0 && levels[state.focusLayer] != null
        ? ` · focus ${levels[state.focusLayer].toFixed(1)} ${unit}`
        : "";
    emitStatus(
      `${modelLabel} · ${label} isosurfaces [${lvlStr}] ${unit}${focusNote} · ${tlab}` +
        (built ? "" : " · (no surface at these levels)")
    );
  }

  async function rebuildFeatures() {
    disposeObject(state.featureGroup);
    state.featureGroup = null;
    // Precomputed feature surfaces removed from the portal UI.
  }

  function clearSection() {
    disposeObject(state.sectionGroup);
    state.sectionGroup = null;
    state.drawPoints = [];
    if (state.drawMode === "section") {
      state.drawMode = null;
      controls.enabled = true;
      notifyDrawMode();
    }
    if (typeof state.onSectionCleared === "function") state.onSectionCleared();
    emitStatus("Cross-section cleared");
  }

  /** Re-sample existing transect from the active volume (time/model/field change). */
  function refreshSection() {
    if (!state.drawPoints || state.drawPoints.length < 2) return null;
    const p0 = state.drawPoints[0];
    const p1 = state.drawPoints[1];
    updateSectionCurtain();
    const section = sampleSection(p0, p1);
    if (section && typeof state.onSection === "function") state.onSection(section);
    return section;
  }

  async function loadCurrentVolume() {
    if (!state.meta) return;
    const times = state.meta.times || [];
    if (!times.length) return;
    const tag = times[state.timeIndex].tag;
    emitStatus(`Loading ${state.model} @ ${tag}…`);
    try {
      const vol = await fetchVolume(state.model, tag);
      state.currentVolume = vol;
      const field = vol.fields[state.variable];
      state.currentFieldMeta = field;
      state.currentValues = decodeU8Field(field, vol.nz * vol.ny * vol.nx);
      applyVolumeModeVisuals();
      await rebuildFeatures();
    } catch (e) {
      console.error(e);
      emitStatus(String(e.message || e));
    }
  }

  function decodeFieldCached(vol, variable) {
    const field = vol.fields[variable];
    if (!field) return null;
    const key = `${vol.model || ""}|${vol.tag || ""}|${variable}|decoded`;
    if (!state._fieldDecodeCache) state._fieldDecodeCache = new Map();
    if (state._fieldDecodeCache.has(key)) return state._fieldDecodeCache.get(key);
    const values = decodeU8Field(field, vol.nz * vol.ny * vol.nx);
    state._fieldDecodeCache.set(key, values);
    // Bound cache size
    if (state._fieldDecodeCache.size > 24) {
      const first = state._fieldDecodeCache.keys().next().value;
      state._fieldDecodeCache.delete(first);
    }
    return values;
  }

  function columnFromValues(vol, values, xKm, yKm, variable) {
    if (!vol || !values || !isInDomain(xKm, yKm)) return null;
    const j = invIndex(vol.x_km, xKm);
    const i = invIndex(vol.y_km, yKm);
    const z = [];
    const v = [];
    for (let k = 0; k < vol.nz; k += 1) {
      z.push(vol.z_m[k]);
      v.push(trilinear(values, vol.nx, vol.ny, vol.nz, j, i, k));
    }
    const out = { z };
    out[variable] = v;
    return out;
  }

  /**
   * Sample many columns from one decoded field (sites + interstitial).
   */
  function sampleColumnsBatch(vol, variable, points) {
    const values = decodeFieldCached(vol, variable);
    if (!values) return [];
    return (points || []).map((p) => {
      const col = columnFromValues(vol, values, p.xKm, p.yKm, variable);
      return col ? { point: p, column: col } : null;
    }).filter(Boolean);
  }

  function disposeMapOverlays() {
    disposeObject(state.mapOverlayGroup);
    state.mapOverlayGroup = null;
  }

  function syncStationVizModeFromVolumeMode() {
    if (state.mode === "profiles") state.mapOverlayMode = "profile";
    else if (state.mode === "hodographs") state.mapOverlayMode = "hodograph";
    else state.mapOverlayMode = "off";
  }

  function applyVolumeModeVisuals() {
    syncStationVizModeFromVolumeMode();
    if (state.mode === "profiles" || state.mode === "hodographs") {
      disposeObject(state.volumeGroup);
      state.volumeGroup = null;
      rebuildMapOverlays();
    } else {
      disposeMapOverlays();
      rebuildVolumeMesh();
    }
  }

  /**
   * OBS-site billboards only: fixed T/RH|WS/WD profiles or hodographs.
   * Click-anywhere popups are handled in the app (not permanent cube markers).
   */
  function rebuildMapOverlays() {
    disposeMapOverlays();
    const mode = state.mapOverlayMode;
    if (mode === "off" || !state.meta || !state.currentVolume) return;

    const vol = state.currentVolume;
    const points = buildOverlaySamplePoints(state.meta.sites || [], vol, {
      includeCubeSamples: false,
    });
    const group = new THREE.Group();
    group.name = "mapOverlays";

    function addBillboard(p, canvas, aspectW, aspectH) {
      const prom = prominenceForKind(p.kind);
      const tex = new THREE.CanvasTexture(canvas);
      tex.needsUpdate = true;
      if (THREE.SRGBColorSpace) tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: prom.opacity,
        depthTest: false,
      });
      const spr = new THREE.Sprite(mat);
      const baseH = 48;
      const scH = baseH * prom.spriteScale;
      const scW = scH * (aspectW / aspectH);
      spr.scale.set(scW, scH, 1);
      const yBase = volumeBaseY(p.xKm, p.yKm);
      const y = sceneYAgl(p.xKm, p.yKm, 900);
      spr.position.set(p.xKm, y, -p.yKm);
      spr.renderOrder = 16;
      spr.userData.overlayKind = p.kind;
      spr.userData.siteId = p.id;
      group.add(spr);

      const stemGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(p.xKm, yBase + 0.4, -p.yKm),
        new THREE.Vector3(p.xKm, y - scH * 0.42, -p.yKm),
      ]);
      group.add(
        new THREE.Line(
          stemGeo,
          new THREE.LineBasicMaterial({
            color: 0xb900c7,
            transparent: true,
            opacity: 0.85,
            depthWrite: false,
          })
        )
      );
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.6, 2.4, 24),
        new THREE.MeshBasicMaterial({
          color: 0xb900c7,
          transparent: true,
          opacity: 0.9,
          side: THREE.DoubleSide,
          depthWrite: false,
        })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(p.xKm, yBase + 0.6, -p.yKm);
      ring.renderOrder = 12;
      group.add(ring);
    }

    if (mode === "profile") {
      const tVals = decodeFieldCached(vol, "temperature");
      const rhVals = decodeFieldCached(vol, "relative_humidity");
      const wsVals = decodeFieldCached(vol, "wind_speed");
      const uVals = decodeFieldCached(vol, "u_wind");
      const vVals = decodeFieldCached(vol, "v_wind");
      if (!tVals || !rhVals || !wsVals || !uVals || !vVals) {
        emitStatus("Profiles need T, RH, WS, u, v fields");
        return;
      }
      points.forEach((p) => {
        if (!isInDomain(p.xKm, p.yKm)) return;
        const cols = sampleStationColumns(vol, p.xKm, p.yKm, {
          tVals,
          rhVals,
          wsVals,
          uVals,
          vVals,
        });
        if (!cols) return;
        const obs = obsColumnsForSite(p.id);
        const cw = 360;
        const ch = 280;
        const canvas = drawStationProfileCanvas(cols, {
          kind: "site",
          label: p.label,
          siteId: p.id,
          width: cw,
          height: ch,
          obs,
          cubeLabel: state.model,
        });
        addBillboard(p, canvas, cw, ch);
      });
    } else if (mode === "hodograph") {
      const uVals = decodeFieldCached(vol, "u_wind");
      const vVals = decodeFieldCached(vol, "v_wind");
      if (!uVals || !vVals) return;
      points.forEach((p) => {
        if (!isInDomain(p.xKm, p.yKm)) return;
        const uCol = columnFromValues(vol, uVals, p.xKm, p.yKm, "u_wind");
        const vCol = columnFromValues(vol, vVals, p.xKm, p.yKm, "v_wind");
        if (!uCol || !vCol) return;
        const obs = obsColumnsForSite(p.id);
        const cw = 220;
        const ch = 220;
        const canvas = drawHodographCanvas(uCol.z, uCol.u_wind, vCol.v_wind, {
          kind: "site",
          label: p.label,
          accent: "#B900C7",
          stroke: "#B900C7",
          width: cw,
          height: ch,
          obsZ: obs && obs.z,
          obsU: obs && obs.u_wind,
          obsV: obs && obs.v_wind,
          cubeLabel: state.model,
        });
        addBillboard(p, canvas, cw, ch);
      });
    }

    state.mapOverlayGroup = group;
    scene.add(group);
    emitStatus(
      mode === "profile"
        ? `${fusionCubeTitle(state.model)} profiles (T·RH | WS·WD) at ${points.length} sites — click map for popup`
        : `${fusionCubeTitle(state.model)} hodographs at ${points.length} sites — click map for popup`
    );
  }

  function sampleStationColumns(vol, xKm, yKm, decoded) {
    if (!vol || !isInDomain(xKm, yKm)) return null;
    const tCol = columnFromValues(vol, decoded.tVals, xKm, yKm, "temperature");
    const rhCol = columnFromValues(vol, decoded.rhVals, xKm, yKm, "relative_humidity");
    const wsCol = columnFromValues(vol, decoded.wsVals, xKm, yKm, "wind_speed");
    const uCol = columnFromValues(vol, decoded.uVals, xKm, yKm, "u_wind");
    const vCol = columnFromValues(vol, decoded.vVals, xKm, yKm, "v_wind");
    if (!tCol || !rhCol || !wsCol || !uCol || !vCol) return null;
    return {
      z: tCol.z,
      temperature: tCol.temperature,
      relative_humidity: rhCol.relative_humidity,
      wind_speed: wsCol.wind_speed,
      u_wind: uCol.u_wind,
      v_wind: vCol.v_wind,
      wind_dir: windDirSeries(uCol.u_wind, vCol.v_wind),
    };
  }

  function obsColumnsForSite(siteId) {
    if (!siteId || !state.obsBySite) return null;
    return normalizeObsColumns(state.obsBySite[siteId]);
  }

  /**
   * Canvas for click popup / export at an arbitrary map point.
   * @returns {{ canvas: HTMLCanvasElement, title: string, mode: string } | null}
   */
  function buildSampleCanvasAt(xKm, yKm, opts) {
    const o = opts || {};
    const vol = state.currentVolume;
    if (!vol || !isInDomain(xKm, yKm)) return null;
    const mode = o.mode || state.mapOverlayMode;
    const label =
      o.label ||
      (o.siteId ? String(o.siteId) : `x=${xKm.toFixed(1)} y=${yKm.toFixed(1)} km`);
    const kind = o.kind || (o.siteId ? "site" : "popup");

    if (mode === "profile" || mode === "profiles") {
      const decoded = {
        tVals: decodeFieldCached(vol, "temperature"),
        rhVals: decodeFieldCached(vol, "relative_humidity"),
        wsVals: decodeFieldCached(vol, "wind_speed"),
        uVals: decodeFieldCached(vol, "u_wind"),
        vVals: decodeFieldCached(vol, "v_wind"),
      };
      if (!decoded.tVals || !decoded.rhVals || !decoded.wsVals || !decoded.uVals || !decoded.vVals) {
        return null;
      }
      const cols = sampleStationColumns(vol, xKm, yKm, decoded);
      if (!cols) return null;
      const obs = obsColumnsForSite(o.siteId);
      const cw = o.width || 360;
      const ch = o.height || 270;
      const pixelRatio = o.pixelRatio != null ? o.pixelRatio : 1;
      const canvas = drawStationProfileCanvas(cols, {
        kind: kind === "site" ? "site" : "popup",
        label,
        siteId: o.siteId || null,
        width: cw,
        height: ch,
        obs,
        cubeLabel: state.model,
        pixelRatio,
      });
      return {
        canvas,
        title: label,
        mode: "profile",
        width: cw,
        height: ch,
        pixelRatio,
      };
    }

    if (mode === "hodograph" || mode === "hodographs") {
      const uVals = decodeFieldCached(vol, "u_wind");
      const vVals = decodeFieldCached(vol, "v_wind");
      if (!uVals || !vVals) return null;
      const uCol = columnFromValues(vol, uVals, xKm, yKm, "u_wind");
      const vCol = columnFromValues(vol, vVals, xKm, yKm, "v_wind");
      if (!uCol || !vCol) return null;
      const obs = obsColumnsForSite(o.siteId);
      const cw = o.width || 260;
      const ch = o.height || 260;
      const pixelRatio = o.pixelRatio != null ? o.pixelRatio : 1;
      const canvas = drawHodographCanvas(uCol.z, uCol.u_wind, vCol.v_wind, {
        kind: kind === "site" ? "site" : "popup",
        label,
        accent: "#B900C7",
        stroke: "#B900C7",
        width: cw,
        height: ch,
        obsZ: obs && obs.z,
        obsU: obs && obs.u_wind,
        obsV: obs && obs.v_wind,
        cubeLabel: state.model,
        pixelRatio,
      });
      return {
        canvas,
        title: label,
        mode: "hodograph",
        width: cw,
        height: ch,
        pixelRatio,
      };
    }
    return null;
  }

  /**
   * Data for plan-map export with OBS-site mini profiles / hodographs.
   */
  function getMapOverlayExportPayload() {
    const mode = state.mapOverlayMode;
    if (mode === "off" || !state.meta || !state.currentVolume) return null;
    const vol = state.currentVolume;
    const points = buildOverlaySamplePoints(state.meta.sites || [], vol, {
      includeCubeSamples: false,
    });
    const insets = [];

    if (mode === "profile") {
      points.forEach((p) => {
        if (!isInDomain(p.xKm, p.yKm)) return;
        const built = buildSampleCanvasAt(p.xKm, p.yKm, {
          mode: "profile",
          siteId: p.id,
          label: p.label,
          kind: "site",
          width: 300,
          height: 220,
        });
        if (!built) return;
        const ll = kmToLonLat(p.xKm, p.yKm);
        insets.push({
          kind: "site",
          id: p.id,
          lon: ll.lon,
          lat: ll.lat,
          dataUrl: built.canvas.toDataURL("image/png"),
          sizex: 0.55,
          sizey: 0.42,
          opacity: 1,
        });
      });
    } else if (mode === "hodograph") {
      points.forEach((p) => {
        if (!isInDomain(p.xKm, p.yKm)) return;
        const built = buildSampleCanvasAt(p.xKm, p.yKm, {
          mode: "hodograph",
          siteId: p.id,
          label: p.label,
          kind: "site",
          width: 180,
          height: 180,
        });
        if (!built) return;
        const ll = kmToLonLat(p.xKm, p.yKm);
        insets.push({
          kind: "site",
          id: p.id,
          lon: ll.lon,
          lat: ll.lat,
          dataUrl: built.canvas.toDataURL("image/png"),
          sizex: 0.5,
          sizey: 0.5,
          opacity: 1,
        });
      });
    }

    return {
      mode,
      variable: "fixed",
      insets,
      titleNote:
        mode === "profile"
          ? `${fusionCubeTitle(state.model)} T·RH | WS·WD profiles`
          : `${fusionCubeTitle(state.model)} hodographs`,
    };
  }

  function sampleSection(p0, p1, nSamp = 80) {
    // p0,p1: {x,z} in km three coords (x, -y of geo)
    const vol = state.currentVolume;
    if (!vol || !state.currentValues) return null;
    const values = state.currentValues;
    const { nx, ny, nz, x_km: xKm, y_km: yKm, z_m: zM } = vol;
    const dist = Math.hypot(p1.x - p0.x, p1.z - p0.z) || 1;
    const xAxis = [];
    const zAxis = zM.slice();
    const grid = [];
    for (let k = 0; k < nz; k += 1) {
      const row = [];
      for (let s = 0; s < nSamp; s += 1) {
        const t = s / (nSamp - 1);
        const x = p0.x + t * (p1.x - p0.x);
        const zc = p0.z + t * (p1.z - p0.z);
        const yGeo = -zc;
        // bilinar sample lat/lon grid
        // find j,i
        const j = invIndex(xKm, x);
        const i = invIndex(yKm, yGeo);
        row.push(trilinear(values, nx, ny, nz, j, i, k));
        if (k === 0) xAxis.push(t * dist);
      }
      grid.push(row);
    }
    return { xAxis, zAxis, grid, dist, variable: state.variable };
  }

  function invIndex(arr, v) {
    if (v <= arr[0]) return 0;
    if (v >= arr[arr.length - 1]) return arr.length - 1;
    let i = 0;
    while (i < arr.length - 1 && arr[i + 1] < v) i += 1;
    const t = (v - arr[i]) / (arr[i + 1] - arr[i] || 1);
    return i + t;
  }

  function trilinear(values, nx, ny, nz, j, i, k) {
    const j0 = Math.floor(j);
    const i0 = Math.floor(i);
    const j1 = Math.min(nx - 1, j0 + 1);
    const i1 = Math.min(ny - 1, i0 + 1);
    const fj = j - j0;
    const fi = i - i0;
    const kk = Math.max(0, Math.min(nz - 1, Math.round(k)));
    const v00 = values[(kk * ny + i0) * nx + j0];
    const v10 = values[(kk * ny + i0) * nx + j1];
    const v01 = values[(kk * ny + i1) * nx + j0];
    const v11 = values[(kk * ny + i1) * nx + j1];
    const a = v00 * (1 - fj) + v10 * fj;
    const b = v01 * (1 - fj) + v11 * fj;
    return a * (1 - fi) + b * fi;
  }

  /** Vertical column from a volume at map km coords. */
  async function sampleColumn(modelId, tag, variable, xKm, yKm) {
    if (!state.meta || !state.meta.assets[modelId] || !state.meta.assets[modelId][tag]) {
      return null;
    }
    // Edge-clamped sampling would invent edge-column profiles outside the box
    if (!isInDomain(xKm, yKm)) return null;
    const vol = await fetchVolume(modelId, tag);
    const field = vol.fields[variable];
    if (!field) return null;
    const values = decodeU8Field(field, vol.nz * vol.ny * vol.nx);
    const j = invIndex(vol.x_km, xKm);
    const i = invIndex(vol.y_km, yKm);
    const z = [];
    const v = [];
    for (let k = 0; k < vol.nz; k += 1) {
      z.push(vol.z_m[k]);
      v.push(trilinear(values, vol.nx, vol.ny, vol.nz, j, i, k));
    }
    const out = { z };
    out[variable] = v;
    return out;
  }

  /** Scalar at height AGL from a pre-sampled column or fresh volume sample. */
  function valueAtHeightFromColumn(col, variable, heightM) {
    if (!col || !col.z || !col[variable]) return null;
    const z = col.z;
    const arr = col[variable];
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < z.length; i += 1) {
      if (!Number.isFinite(z[i]) || !Number.isFinite(arr[i])) continue;
      const d = Math.abs(z[i] - heightM);
      if (d < bestD) {
        bestD = d;
        best = arr[i];
      }
    }
    return best;
  }

  function setProbeMarker(xKm, yKm, mode) {
    disposeObject(state.probeMarker);
    state.probeMarker = null;
    if (xKm == null || yKm == null) return;
    state.lastProbe = { xKm, yKm, mode };
    const color = mode === "site" ? 0xb900c7 : 0x38bdf8;
    const yGround = groundSceneY(xKm, yKm) + 0.3;
    const zTop = sceneYAgl(xKm, yKm, 1500);
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.2, 0.35, 8, 28),
      new THREE.MeshBasicMaterial({ color, depthTest: false })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.set(xKm, yGround + 0.6, -yKm);
    ring.renderOrder = 30;
    g.add(ring);
    const stemH = Math.max(zTop - yGround, 1);
    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.22, 0.22, stemH, 8),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      })
    );
    stem.position.set(xKm, yGround + stemH / 2, -yKm);
    stem.renderOrder = 29;
    g.add(stem);
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 12, 12),
      new THREE.MeshBasicMaterial({ color })
    );
    cap.position.set(xKm, zTop, -yKm);
    cap.renderOrder = 30;
    g.add(cap);
    scene.add(g);
    state.probeMarker = g;
  }

  function nearestSite(xKm, yKm, maxKm = 4.5) {
    const sites = (state.meta && state.meta.sites) || [];
    let best = null;
    let bestD = maxKm;
    for (const s of sites) {
      const d = Math.hypot(s.x_km - xKm, s.y_km - yKm);
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best ? { site: best, distKm: bestD } : null;
  }

  function notifyDrawMode() {
    if (typeof state.onDrawModeChange === "function") {
      state.onDrawModeChange(state.drawMode);
    }
  }

  function setDrawMode(mode) {
    state.drawMode = mode;
    state.drawPoints = [];
    disposeObject(state.sectionGroup);
    state.sectionGroup = null;
    disposeObject(state.sectionLine);
    state.sectionLine = null;
    controls.enabled = mode !== "section";
    emitStatus(mode === "section" ? "Click two points to draw a cross-section" : "");
    notifyDrawMode();
  }

  function updateSectionCurtain() {
    disposeObject(state.sectionGroup);
    state.sectionGroup = null;
    if (state.drawPoints.length < 1) return;

    const group = new THREE.Group();
    group.renderOrder = 18;

    if (state.drawPoints.length === 1) {
      const p = state.drawPoints[0];
      const yKm = -p.z;
      const yg = groundSceneY(p.x, yKm) + 0.4;
      const yt = sceneYAgl(p.x, yKm, 1500);
      const marker = new THREE.Mesh(
        new THREE.SphereGeometry(1.6, 14, 12),
        new THREE.MeshBasicMaterial({ color: 0xfbbf24 })
      );
      marker.position.set(p.x, yg + 1.5, p.z);
      marker.renderOrder = 20;
      group.add(marker);
      const stem = new THREE.Mesh(
        new THREE.CylinderGeometry(0.35, 0.35, Math.max(yt - yg, 1), 8),
        new THREE.MeshBasicMaterial({
          color: 0xfbbf24,
          transparent: true,
          opacity: 0.55,
        })
      );
      stem.position.set(p.x, (yg + yt) / 2, p.z);
      stem.renderOrder = 19;
      group.add(stem);
      scene.add(group);
      state.sectionGroup = group;
      return;
    }

    const p0 = state.drawPoints[0];
    const p1 = state.drawPoints[1];
    const segs = 40;
    const positions = [];
    const indices = [];
    const topPts = [];
    const botPts = [];
    for (let i = 0; i <= segs; i += 1) {
      const t = i / segs;
      const x = p0.x + (p1.x - p0.x) * t;
      const z = p0.z + (p1.z - p0.z) * t;
      const yKm = -z;
      const yg = groundSceneY(x, yKm);
      const yt = sceneYAgl(x, yKm, 1500);
      positions.push(x, yg, z, x, yt, z);
      botPts.push(new THREE.Vector3(x, yg + 0.2, z));
      topPts.push(new THREE.Vector3(x, yt, z));
    }
    for (let i = 0; i < segs; i += 1) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    const curtain = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.38,
        side: THREE.DoubleSide,
        depthWrite: false,
      })
    );
    curtain.renderOrder = 18;
    group.add(curtain);

    const edgeMat = new THREE.LineBasicMaterial({
      color: 0xfff7ed,
      transparent: true,
      opacity: 0.98,
      depthTest: false,
    });
    const topLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(topPts),
      edgeMat
    );
    topLine.renderOrder = 22;
    group.add(topLine);
    const botLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(botPts),
      new THREE.LineBasicMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 1,
        depthTest: false,
      })
    );
    botLine.renderOrder = 22;
    group.add(botLine);
    // end posts
    [p0, p1].forEach((p) => {
      const yKm = -p.z;
      const yg = groundSceneY(p.x, yKm);
      const yt = sceneYAgl(p.x, yKm, 1500);
      const post = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(p.x, yg, p.z),
          new THREE.Vector3(p.x, yt, p.z),
        ]),
        edgeMat
      );
      post.renderOrder = 22;
      group.add(post);
    });

    scene.add(group);
    state.sectionGroup = group;
  }

  let pointerDown = null;

  function setPointerFromEvent(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
  }

  function onPointer(ev) {
    setPointerFromEvent(ev);

    if (state.drawMode === "section") {
      const hit = new THREE.Vector3();
      if (raycaster.ray.intersectPlane(groundPlane, hit)) {
        state.drawPoints.push({ x: hit.x, z: hit.z });
        updateSectionCurtain();
        if (state.drawPoints.length >= 2) {
          const p0 = state.drawPoints[0];
          const p1 = state.drawPoints[1];
          state.drawPoints = [p0, p1];
          updateSectionCurtain();
          const section = sampleSection(p0, p1);
          if (section && typeof state.onSection === "function") state.onSection(section);
          state.drawMode = null;
          controls.enabled = true;
          notifyDrawMode();
          emitStatus(`Cross-section ${section.dist.toFixed(1)} km — see panel`);
        }
      }
      return;
    }

    // Prefer site markers
    if (state.siteGroup && state.showSites) {
      const hits = raycaster.intersectObjects(state.siteGroup.children, false);
      if (hits.length && hits[0].object.userData.siteId) {
        const sid = hits[0].object.userData.siteId;
        state.selectedSite = sid;
        const s = (state.meta.sites || []).find((x) => x.id === sid);
        if (s) {
          setProbeMarker(s.x_km, s.y_km, "site");
          if (typeof state.onProbe === "function") {
            state.onProbe({
              mode: "site",
              siteId: sid,
              xKm: s.x_km,
              yKm: s.y_km,
            });
          }
        }
        return;
      }
    }

    // Anywhere on domain floor → grid (or snap to nearby site)
    const hit = new THREE.Vector3();
    if (raycaster.ray.intersectPlane(groundPlane, hit)) {
      const xKm = hit.x;
      const yKm = -hit.z;
      const near = nearestSite(xKm, yKm, 4.5);
      if (near) {
        const s = near.site;
        setProbeMarker(s.x_km, s.y_km, "site");
        if (typeof state.onProbe === "function") {
          state.onProbe({
            mode: "site",
            siteId: s.id,
            xKm: s.x_km,
            yKm: s.y_km,
            snappedFromKm: near.distKm,
          });
        }
      } else {
        setProbeMarker(xKm, yKm, "grid");
        if (typeof state.onProbe === "function") {
          state.onProbe({ mode: "grid", siteId: null, xKm, yKm });
        }
      }
    }
  }

  function onPointerDown(ev) {
    pointerDown = { x: ev.clientX, y: ev.clientY, t: Date.now() };
  }
  function onPointerUp(ev) {
    if (!pointerDown) return;
    const dx = ev.clientX - pointerDown.x;
    const dy = ev.clientY - pointerDown.y;
    const moved = Math.hypot(dx, dy) > 5;
    const dt = Date.now() - pointerDown.t;
    pointerDown = null;
    if (moved || dt > 800) return;
    onPointer(ev);
  }
  renderer.domElement.addEventListener("pointerdown", onPointerDown);
  renderer.domElement.addEventListener("pointerup", onPointerUp);
  let pollRaf = 0;
  let pendingPollEv = null;
  renderer.domElement.addEventListener("pointermove", (ev) => {
    if (!state.pollEnabled || state.drawMode === "section") return;
    pendingPollEv = ev;
    if (pollRaf) return;
    pollRaf = requestAnimationFrame(() => {
      pollRaf = 0;
      if (pendingPollEv) pollAtEvent(pendingPollEv);
      pendingPollEv = null;
    });
  });
  renderer.domElement.addEventListener("pointerleave", () => {
    state.lastPoll = null;
    if (typeof state.onPoll === "function") state.onPoll(null, null);
  });

  async function setMeta(meta) {
    state.meta = meta;
    if (meta.projection && meta.projection.vert_exag_default != null) {
      state.vertExag = meta.projection.vert_exag_default;
    }
    if (meta.volume) {
      state.variable = meta.volume.default_variable || state.variable;
      state.mode = meta.volume.default_mode || state.mode;
      const defs = meta.volume.default_iso_levels || {};
      if (defs[state.variable]) state.isoLevels = defs[state.variable].slice();
    }
    buildSites();
    await loadGeo();
    await loadCurrentVolume();
    buildAxisHelpers(true);
    setCameraPreset("reset");
  }

  function setIsoLevels(levels) {
    state.isoLevels = levels.map(Number).filter((v) => Number.isFinite(v));
    if (state.mode === "isosurface") rebuildVolumeMesh();
  }

  function setFocusLayer(i) {
    state.focusLayer = i;
    if (state.mode === "isosurface") rebuildVolumeMesh();
  }

  function setVariable(v) {
    state.variable = v;
    if (!state.currentVolume) return;
    const field = state.currentVolume.fields[v];
    state.currentFieldMeta = field;
    state.currentValues = decodeU8Field(
      field,
      state.currentVolume.nz * state.currentVolume.ny * state.currentVolume.nx
    );
    const defs =
      (state.meta.volume && state.meta.volume.default_iso_levels && state.meta.volume.default_iso_levels[v]) ||
      null;
    if (defs) state.isoLevels = defs.slice();
    applyVolumeModeVisuals();
  }

  function getFieldRange() {
    const cr = effectiveColorRange();
    return {
      min: cr.min,
      max: cr.max,
      unit: cr.unit,
      label: cr.label,
      mapName: cr.mapName,
      dataMin: state.currentFieldMeta ? state.currentFieldMeta.vmin : cr.min,
      dataMax: state.currentFieldMeta ? state.currentFieldMeta.vmax : cr.max,
    };
  }

  /** Equirectangular km → lon/lat using volume / projection origin. */
  function kmToLonLat(xKm, yKm) {
    const lat0 =
      (state.currentVolume && state.currentVolume.lat0) ||
      (state.meta && state.meta.projection && state.meta.projection.lat0) ||
      35.75;
    const lon0 =
      (state.currentVolume && state.currentVolume.lon0) ||
      (state.meta && state.meta.projection && state.meta.projection.lon0) ||
      -96.75;
    const lat = lat0 + yKm / 110.574;
    const lon = lon0 + xKm / (111.32 * Math.cos((lat0 * Math.PI) / 180));
    return { lon, lat, lat0, lon0 };
  }

  function lonLatToKm(lon, lat) {
    const lat0 =
      (state.currentVolume && state.currentVolume.lat0) ||
      (state.meta && state.meta.projection && state.meta.projection.lat0) ||
      35.75;
    const lon0 =
      (state.currentVolume && state.currentVolume.lon0) ||
      (state.meta && state.meta.projection && state.meta.projection.lon0) ||
      -96.75;
    const yKm = (lat - lat0) * 110.574;
    const xKm = (lon - lon0) * (111.32 * Math.cos((lat0 * Math.PI) / 180));
    return { xKm, yKm, lat0, lon0 };
  }

  function pathKmToLonLat(path2d) {
    const lon = [];
    const lat = [];
    if (!path2d) return { lon, lat };
    for (let i = 0; i < path2d.length; i += 1) {
      const p = path2d[i];
      if (!p || p.length < 2) continue;
      const ll = kmToLonLat(p[0], p[1]);
      lon.push(ll.lon);
      lat.push(ll.lat);
    }
    return { lon, lat };
  }

  /**
   * Horizontal plane for publication plan-map export (independent of 3D camera).
   * @param {number} [kOpt] level index; defaults to current sliceK
   * @param {{ probe?: {xKm:number,yKm:number} }} [opts]
   */
  function getPlanSliceSnapshot(kOpt, opts) {
    const o = opts || {};
    const vol = state.currentVolume;
    if (!vol || !state.currentValues) return null;
    const { nx, ny, nz, x_km: xKm, y_km: yKm, z_m: zM } = vol;
    const k = Math.max(0, Math.min(nz - 1, kOpt != null ? kOpt | 0 : state.sliceK | 0));
    const values = state.currentValues;
    const grid = [];
    for (let i = 0; i < ny; i += 1) {
      const row = new Array(nx);
      for (let j = 0; j < nx; j += 1) {
        row[j] = values[(k * ny + i) * nx + j];
      }
      grid.push(row);
    }
    const lon = xKm.map((x) => kmToLonLat(x, 0).lon);
    const lat = yKm.map((y) => kmToLonLat(0, y).lat);
    const origin = kmToLonLat(0, 0);
    const cr = effectiveColorRange();
    const field = state.currentFieldMeta || {};
    const times = (state.meta && state.meta.times) || [];
    const t = times[state.timeIndex] || {};
    const modelEntry = ((state.meta && state.meta.models) || []).find((m) => m.id === state.model);
    const modelLabel = (modelEntry && modelEntry.label) || state.model;
    const zAgl = zM[k];
    const geoPaths = [];
    if (state.geo) {
      (state.geo.state || []).forEach((p) => {
        const ll = pathKmToLonLat(p);
        geoPaths.push({ kind: "state", ...ll });
      });
      (state.geo.counties || []).forEach((p) => {
        const ll = pathKmToLonLat(p);
        geoPaths.push({ kind: "county", ...ll });
      });
      (state.geo.highways || []).forEach((p) => {
        const ll = pathKmToLonLat(p);
        geoPaths.push({ kind: "highway", ...ll });
      });
    }
    const cities = ((state.geo && state.geo.cities) || []).map((c) => ({
      name: c.name,
      lon: c.lon,
      lat: c.lat,
      x_km: c.x_km,
      y_km: c.y_km,
    }));
    const sites = ((state.meta && state.meta.sites) || []).map((s) => ({
      id: s.id,
      name: s.name,
      lon: s.lon,
      lat: s.lat,
      x_km: s.x_km,
      y_km: s.y_km,
    }));
    let probe = null;
    if (o.probe && Number.isFinite(o.probe.xKm) && Number.isFinite(o.probe.yKm)) {
      const ll = kmToLonLat(o.probe.xKm, o.probe.yKm);
      probe = { ...ll, xKm: o.probe.xKm, yKm: o.probe.yKm };
    }
    const varLabel = field.label || cr.label || state.variable;
    const unit = field.unit || cr.unit || "";
    const lonMin = Math.min(...lon);
    const lonMax = Math.max(...lon);
    const latMin = Math.min(...lat);
    const latMax = Math.max(...lat);
    return {
      grid,
      lon,
      lat,
      x_km: xKm,
      y_km: yKm,
      z_m: zAgl,
      k,
      variable: state.variable,
      unit,
      vmin: cr.min,
      vmax: cr.max,
      mapName: cr.mapName,
      contourInterval: state.contourInterval,
      model: state.model,
      modelLabel,
      timeTag: t.tag || "",
      timeLabel: t.label || "",
      lat0: origin.lat0,
      lon0: origin.lon0,
      geoPaths,
      cities,
      sites,
      probe,
      // Analysis grid extent (plan map zooms here — matches SCALES domain box)
      lonRange: [lonMin, lonMax],
      latRange: [latMin, latMax],
      title: `${modelLabel} · ${varLabel} @ ${zAgl.toFixed(0)} m AGL`,
      subtitle: `${t.label || ""} · SCALES domain`.trim(),
      mode: state.mode,
      isoLevels: state.isoLevels.slice(),
    };
  }

  /**
   * Capture the live WebGL viewport as a PNG data URL.
   * @param {{ lightBg?: boolean, hideHudOverlay?: boolean }} [opts]
   *   lightBg — soft paper clear color (better for slides); geometry stays as shown.
   */
  function captureViewportPng(opts) {
    const o = opts || {};
    const prevColor = new THREE.Color();
    renderer.getClearColor(prevColor);
    const prevAlpha = renderer.getClearAlpha();
    if (o.lightBg) {
      renderer.setClearColor(0xf4f6f8, 1);
    }
    controls.update();
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL("image/png");
    renderer.setClearColor(prevColor, prevAlpha);
    renderer.render(scene, camera);
    return url;
  }

  /**
   * Sample current loaded volume at map km + height AGL (m).
   * Returns null outside domain / without volume.
   */
  function samplePointAt(xKm, yKm, zAglM) {
    const vol = state.currentVolume;
    if (!vol || !state.currentValues) return null;
    if (!isInDomain(xKm, yKm)) return null;
    const j = invIndex(vol.x_km, xKm);
    const i = invIndex(vol.y_km, yKm);
    const k = invIndex(vol.z_m, zAglM);
    const value = trilinear(
      state.currentValues,
      vol.nx,
      vol.ny,
      vol.nz,
      j,
      i,
      k
    );
    return {
      xKm,
      yKm,
      zAglM,
      value: Number.isFinite(value) ? value : null,
      variable: state.variable,
      unit: (state.currentFieldMeta && state.currentFieldMeta.unit) || "",
    };
  }

  /** Poll field under cursor at map (x,y) and AGL height from the poll slider. */
  function pollAtEvent(ev) {
    if (!state.pollEnabled) return null;
    setPointerFromEvent(ev);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return null;
    const xKm = hit.x;
    const yKm = -hit.z;
    if (!isInDomain(xKm, yKm)) return null;
    const zAglM =
      state.pollHeightM != null && Number.isFinite(state.pollHeightM)
        ? state.pollHeightM
        : 100;
    const sample = samplePointAt(xKm, yKm, zAglM);
    state.lastPoll = sample;
    if (sample && typeof state.onPoll === "function") state.onPoll(sample, ev);
    return sample;
  }

  function tick() {
    requestAnimationFrame(tick);
    controls.update();
    renderer.render(scene, camera);
  }
  tick();
  window.addEventListener("resize", resize);

  return {
    state,
    setMeta,
    setModelAndTime: async (m, i) => {
      state.model = m;
      state.timeIndex = i;
      await loadCurrentVolume();
    },
    setVariable,
    setMode: (m) => {
      const allowed = ["isosurface", "slice", "profiles", "hodographs"];
      state.mode = allowed.includes(m) ? m : "isosurface";
      applyVolumeModeVisuals();
    },
    setIsoLevels,
    setFocusLayer,
    setColorScale: (opts) => {
      const o = opts || {};
      if (o.mapName != null) state.colorMapName = String(o.mapName);
      if (Object.prototype.hasOwnProperty.call(o, "vmin")) {
        state.colorVmin =
          o.vmin == null || o.vmin === "" ? null : Number(o.vmin);
      }
      if (Object.prototype.hasOwnProperty.call(o, "vmax")) {
        state.colorVmax =
          o.vmax == null || o.vmax === "" ? null : Number(o.vmax);
      }
      if (Object.prototype.hasOwnProperty.call(o, "interval")) {
        state.contourInterval =
          o.interval == null || o.interval === "" ? null : Number(o.interval);
      }
      if (o.colorLayersFromMap != null) {
        state.colorLayersFromMap = !!o.colorLayersFromMap;
      }
      applyVolumeModeVisuals();
    },
    setMapOverlayMode: (mode) => {
      // Back-compat: map overlay API maps onto volume modes
      const m = String(mode || "off");
      if (m === "profile") state.mode = "profiles";
      else if (m === "hodograph") state.mode = "hodographs";
      else if (state.mode === "profiles" || state.mode === "hodographs") {
        state.mode = "isosurface";
      }
      applyVolumeModeVisuals();
    },
    setMapOverlayVariable: (v) => {
      if (v) state.mapOverlayVariable = String(v);
      if (state.mode === "profiles") rebuildMapOverlays();
    },
    setObsSoundings: (bySite) => {
      state.obsBySite = bySite && typeof bySite === "object" ? bySite : null;
      if (state.mode === "profiles" || state.mode === "hodographs") {
        rebuildMapOverlays();
      }
    },
    getMapOverlayMode: () => state.mapOverlayMode,
    setPollEnabled: (on) => {
      state.pollEnabled = !!on;
      if (!on && typeof state.onPoll === "function") state.onPoll(null, null);
    },
    setPollHeightM: (h) => {
      const n = Number(h);
      if (Number.isFinite(n)) state.pollHeightM = Math.max(0, Math.min(1500, n));
      // Refresh readout at last cursor map position when height changes
      if (state.pollEnabled && state.lastPoll && state.lastPoll.xKm != null) {
        const sample = samplePointAt(
          state.lastPoll.xKm,
          state.lastPoll.yKm,
          state.pollHeightM
        );
        state.lastPoll = sample;
        if (typeof state.onPoll === "function") state.onPoll(sample, null);
      }
    },
    samplePointAt,
    getColorScale: () => ({ ...effectiveColorRange(), interval: state.contourInterval }),
    setSliceK: (k) => {
      state.sliceK = k;
      if (state.mode === "slice") rebuildVolumeMesh();
    },
    setOpacity: (o) => {
      state.opacity = o;
      // Slice mesh only — isosurfaces use per-layer opacities
      if (state.mode === "slice" && state.volumeGroup) {
        state.volumeGroup.traverse((child) => {
          if (!child.isMesh || !child.material) return;
          if (child.material.opacity == null) return;
          child.material.opacity = Math.min(1, state.opacity + 0.15);
          child.material.needsUpdate = true;
        });
        return;
      }
      if (state.mode === "slice") rebuildVolumeMesh();
    },
    setLayerOpacities: (ops) => {
      if (!Array.isArray(ops)) return;
      state.layerOpacities = ops.map((o) =>
        Math.max(0.02, Math.min(1, Number(o) || 0.72))
      );
      if (state.mode === "isosurface" && state.volumeGroup) {
        state.volumeGroup.traverse((child) => {
          if (!child.isMesh || child.userData.layerIndex == null || !child.material) return;
          const li = child.userData.layerIndex;
          const baseOp =
            state.layerOpacities[li] != null ? state.layerOpacities[li] : state.opacity;
          const dim = state.focusLayer >= 0 && state.focusLayer !== li;
          const op = dim ? baseOp * 0.18 : baseOp;
          child.userData.baseOpacity = baseOp;
          child.material.opacity = op;
          child.material.depthWrite = !dim && op > 0.92;
          child.material.transparent = true;
          child.material.needsUpdate = true;
        });
        return;
      }
      if (state.mode === "isosurface") rebuildVolumeMesh();
    },
    setLayerColors: (colors) => {
      if (!Array.isArray(colors)) return;
      state.colorLayersFromMap = false;
      state.layerColors = colors.map((c) => {
        if (typeof c === "number" && Number.isFinite(c)) return c >>> 0;
        const s = String(c).replace("#", "").trim();
        const n = parseInt(s.length === 3 ? s.split("").map((ch) => ch + ch).join("") : s, 16);
        return Number.isFinite(n) ? n : 0x888888;
      });
      // Update existing isosurface materials in place (no MC rebuild)
      if (state.mode === "isosurface" && state.volumeGroup) {
        state.volumeGroup.traverse((child) => {
          if (!child.isMesh || child.userData.layerIndex == null) return;
          const col = state.layerColors[child.userData.layerIndex];
          if (col == null || !child.material) return;
          if (child.material.color) child.material.color.setHex(col);
          if (child.material.emissive) child.material.emissive.setHex(col);
          child.material.needsUpdate = true;
        });
        return;
      }
      if (state.mode === "isosurface") rebuildVolumeMesh();
    },
    setTerrainOpacity: (o) => {
      state.terrainOpacity = Math.max(0.05, Math.min(1, Number(o) || 0.25));
      if (state.terrainFloat && state.showTerrain) buildTerrainMesh(state.terrainFloat);
    },
    setVertExag: (v) => {
      state.vertExag = v;
      buildSites();
      if (state.terrainFloat) buildTerrainMesh(state.terrainFloat);
      if (state.showGeo) buildGeoLines();
      else buildFlatOkOutline();
      applyVolumeModeVisuals();
      if (state.showAxes) buildAxisHelpers(true);
      if (state.drawPoints && state.drawPoints.length) updateSectionCurtain();
      if (state.lastProbe) {
        setProbeMarker(state.lastProbe.xKm, state.lastProbe.yKm, state.lastProbe.mode);
      }
    },
    setZMode: (mode) => {
      state.zMode = mode === "terrain" ? "terrain" : "flat";
      buildSites();
      if (state.terrainFloat) buildTerrainMesh(state.terrainFloat);
      if (state.showGeo) buildGeoLines();
      else buildFlatOkOutline();
      applyVolumeModeVisuals();
      if (state.showAxes) buildAxisHelpers(true);
      if (state.drawPoints && state.drawPoints.length) updateSectionCurtain();
      if (state.lastProbe) {
        setProbeMarker(state.lastProbe.xKm, state.lastProbe.yKm, state.lastProbe.mode);
      }
      emitStatus(
        state.zMode === "terrain"
          ? "Z: terrain-following — volume AGL offset by surface MSL · OK outline stays flat"
          : "Z: flat AGL — level base, mono terrain colors"
      );
    },
    setLayer: (name, on) => {
      if (name === "sites") {
        state.showSites = on;
        if (state.siteGroup) state.siteGroup.visible = on;
      }
      if (name === "terrain") {
        state.showTerrain = on;
        if (!on) {
          disposeObject(state.terrainMesh);
          disposeObject(state.terrainContours);
          state.terrainMesh = null;
          state.terrainContours = null;
        } else if (state.terrainFloat) buildTerrainMesh(state.terrainFloat);
      }
      if (name === "volume") {
        state.showVolume = on;
        if (!on) disposeObject(state.volumeGroup);
        else rebuildVolumeMesh();
      }
      if (name === "geo") {
        state.showGeo = on;
        if (!on) {
          disposeObject(state.geoGroup);
          state.geoGroup = null;
          disposeObject(state.okFlatGroup);
          state.okFlatGroup = null;
        } else {
          buildGeoLines();
        }
      }
      if (name === "axes") {
        buildAxisHelpers(!!on);
      }
    },
    setFeature: () => {
      /* features removed from UI */
    },
    setDrawMode,
    clearSection,
    refreshSection,
    setCameraPreset,
    getCompassRotationDeg,
    buildAxisHelpers,
    getFieldRange,
    getPlanSliceSnapshot,
    getMapOverlayExportPayload,
    buildSampleCanvasAt,
    lonLatToKm,
    captureViewportPng,
    getNz: () => (state.currentVolume && state.currentVolume.nz) || 1,
    getZm: (k) => {
      if (!state.currentVolume) return 0;
      const z = state.currentVolume.z_m;
      return z[Math.max(0, Math.min(z.length - 1, k))];
    },
    getIsoLevels: () => state.isoLevels.slice(),
    hasSection: () => !!(state.drawPoints && state.drawPoints.length >= 2),
    isInDomain,
    sampleColumn,
    setProbeMarker,
    nearestSite,
    setSiteObsAvailability,
    valueAtHeightFromColumn,
    resize,
    set onSiteClick(fn) {
      state.onSiteClick = fn;
    },
    set onStatus(fn) {
      state.onStatus = fn;
    },
    set onSection(fn) {
      state.onSection = fn;
    },
    set onSectionCleared(fn) {
      state.onSectionCleared = fn;
    },
    set onDrawModeChange(fn) {
      state.onDrawModeChange = fn;
    },
    set onProbe(fn) {
      state.onProbe = fn;
    },
    set onPoll(fn) {
      state.onPoll = fn;
    },
  };
}
