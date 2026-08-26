/**
 * Smooth isosurfaces via classical Marching Cubes (three.js tables + layout).
 * Welded shared edges, area-weighted normals, optional upsample + smooth.
 */
import { edgeTable, triTable } from "./mc_tables.js";

export function decodeU8Field(field, n) {
  const bin = atob(field.data);
  if (bin.length < n) throw new Error(`volume field length ${bin.length} < ${n}`);
  const out = new Float32Array(n);
  const vmin = field.vmin;
  const vmax = field.vmax;
  const scale = (vmax - vmin) / 255;
  for (let i = 0; i < n; i += 1) out[i] = vmin + bin.charCodeAt(i) * scale;
  return out;
}

export function decodeU8Plane(field, n) {
  return decodeU8Field(field, n);
}

/** 3×3×3 box smooth. */
export function smoothVolume(values, nx, ny, nz, passes = 1) {
  let cur = values;
  for (let p = 0; p < passes; p += 1) {
    const next = new Float32Array(cur.length);
    for (let k = 0; k < nz; k += 1) {
      for (let i = 0; i < ny; i += 1) {
        for (let j = 0; j < nx; j += 1) {
          let s = 0;
          let c = 0;
          for (let dk = -1; dk <= 1; dk += 1) {
            const kk = k + dk;
            if (kk < 0 || kk >= nz) continue;
            for (let di = -1; di <= 1; di += 1) {
              const ii = i + di;
              if (ii < 0 || ii >= ny) continue;
              for (let dj = -1; dj <= 1; dj += 1) {
                const jj = j + dj;
                if (jj < 0 || jj >= nx) continue;
                const v = cur[(kk * ny + ii) * nx + jj];
                if (!Number.isFinite(v)) continue;
                s += v;
                c += 1;
              }
            }
          }
          next[(k * ny + i) * nx + j] = c ? s / c : cur[(k * ny + i) * nx + j];
        }
      }
    }
    cur = next;
  }
  return cur;
}

/** Trilinear upsample by integer factor so MC facets are smaller. */
export function upsampleVolume(values, nx, ny, nz, factor = 2) {
  const f = Math.max(1, factor | 0);
  if (f === 1) {
    return { values, nx, ny, nz, xOf: (j) => j, yOf: (i) => i, zOf: (k) => k };
  }
  const nx2 = (nx - 1) * f + 1;
  const ny2 = (ny - 1) * f + 1;
  const nz2 = (nz - 1) * f + 1;
  const out = new Float32Array(nx2 * ny2 * nz2);

  function sample(fk, fi, fj) {
    const k0 = Math.floor(fk);
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const k1 = Math.min(nz - 1, k0 + 1);
    const i1 = Math.min(ny - 1, i0 + 1);
    const j1 = Math.min(nx - 1, j0 + 1);
    const tk = fk - k0;
    const ti = fi - i0;
    const tj = fj - j0;
    const v = (kk, ii, jj) => values[(kk * ny + ii) * nx + jj];
    const c00 = v(k0, i0, j0) * (1 - tj) + v(k0, i0, j1) * tj;
    const c10 = v(k0, i1, j0) * (1 - tj) + v(k0, i1, j1) * tj;
    const c01 = v(k1, i0, j0) * (1 - tj) + v(k1, i0, j1) * tj;
    const c11 = v(k1, i1, j0) * (1 - tj) + v(k1, i1, j1) * tj;
    const c0 = c00 * (1 - ti) + c10 * ti;
    const c1 = c01 * (1 - ti) + c11 * ti;
    return c0 * (1 - tk) + c1 * tk;
  }

  for (let k = 0; k < nz2; k += 1) {
    const fk = k / f;
    for (let i = 0; i < ny2; i += 1) {
      const fi = i / f;
      for (let j = 0; j < nx2; j += 1) {
        out[(k * ny2 + i) * nx2 + j] = sample(fk, fi, j / f);
      }
    }
  }
  return {
    values: out,
    nx: nx2,
    ny: ny2,
    nz: nz2,
    xOf: (j) => j / f,
    yOf: (i) => i / f,
    zOf: (k) => k / f,
  };
}

function lerp1(a, b, t) {
  return a + (b - a) * t;
}

function interpCoord(arr, idxF) {
  const i0 = Math.max(0, Math.min(arr.length - 1, Math.floor(idxF)));
  const i1 = Math.min(arr.length - 1, i0 + 1);
  return lerp1(arr[i0], arr[i1], idxF - i0);
}

/**
 * Marching Cubes matching three.js corner/edge conventions.
 *
 * Grid: j = +X (lon/x_km), i = +Y (lat/y_km), k = +height index
 * Corners c0..c7 at (j,i,k) offsets:
 *   c0 (0,0,0) c1 (+j) c2 (+i) c3 (+j,+i)
 *   c4 (+k)    c5 (+j,+k) c6 (+i,+k) c7 (+j,+i,+k)
 * cubeindex bits (three.js):
 *   c0:1 c1:2 c2:8 c3:4 c4:16 c5:32 c6:128 c7:64
 */
export function isosurfaceMesh(valuesIn, opts) {
  const {
    nx: nx0,
    ny: ny0,
    nz: nz0,
    xKm,
    yKm,
    zM,
    vertExag,
    iso,
    upsample = 2,
    elevFn = null, // (xKm, yKm) → scene-Y base under AGL (terrain-following)
  } = opts;

  const up = upsampleVolume(valuesIn, nx0, ny0, nz0, upsample);
  const { values, nx, ny, nz, xOf, yOf, zOf } = up;

  function world(k, i, j) {
    const x = interpCoord(xKm, xOf(j));
    const yPlane = interpCoord(yKm, yOf(i));
    const zAgl = interpCoord(zM, zOf(k));
    let y = (zAgl / 1000) * vertExag;
    if (typeof elevFn === "function") y += elevFn(x, yPlane);
    return [x, y, -yPlane];
  }

  function val(k, i, j) {
    return values[(k * ny + i) * nx + j];
  }

  const weld = new Map();
  const positions = [];
  const indices = [];

  function getVert(id, p) {
    if (weld.has(id)) return weld.get(id);
    const vid = positions.length / 3;
    positions.push(p[0], p[1], p[2]);
    weld.set(id, vid);
    return vid;
  }

  function lerpVerts(pa, pb, va, vb) {
    let t = (iso - va) / (vb - va);
    if (!Number.isFinite(t)) t = 0.5;
    t = Math.max(0, Math.min(1, t));
    return [lerp1(pa[0], pb[0], t), lerp1(pa[1], pb[1], t), lerp1(pa[2], pb[2], t)];
  }

  for (let k = 0; k < nz - 1; k += 1) {
    for (let i = 0; i < ny - 1; i += 1) {
      for (let j = 0; j < nx - 1; j += 1) {
        // corners in three.js order
        const k0 = k;
        const k1 = k + 1;
        const i0 = i;
        const i1 = i + 1;
        const j0 = j;
        const j1 = j + 1;

        const v0 = val(k0, i0, j0);
        const v1 = val(k0, i0, j1);
        const v2 = val(k0, i1, j0);
        const v3 = val(k0, i1, j1);
        const v4 = val(k1, i0, j0);
        const v5 = val(k1, i0, j1);
        const v6 = val(k1, i1, j0);
        const v7 = val(k1, i1, j1);

        if (
          ![v0, v1, v2, v3, v4, v5, v6, v7].every((x) => Number.isFinite(x))
        ) {
          continue;
        }

        let cubeindex = 0;
        if (v0 < iso) cubeindex |= 1;
        if (v1 < iso) cubeindex |= 2;
        if (v2 < iso) cubeindex |= 8;
        if (v3 < iso) cubeindex |= 4;
        if (v4 < iso) cubeindex |= 16;
        if (v5 < iso) cubeindex |= 32;
        if (v6 < iso) cubeindex |= 128;
        if (v7 < iso) cubeindex |= 64;

        const bits = edgeTable[cubeindex];
        if (bits === 0) continue;

        const p0 = world(k0, i0, j0);
        const p1 = world(k0, i0, j1);
        const p2 = world(k0, i1, j0);
        const p3 = world(k0, i1, j1);
        const p4 = world(k1, i0, j0);
        const p5 = world(k1, i0, j1);
        const p6 = world(k1, i1, j0);
        const p7 = world(k1, i1, j1);

        // edgeVert[e] for e=0..11 matching three.js edge bits
        const edgeVert = new Array(12);

        // bit1: X between c0-c1  at (k,i,j)—(k,i,j+1)
        if (bits & 1) {
          edgeVert[0] = getVert(`x|${k0}|${i0}|${j0}`, lerpVerts(p0, p1, v0, v1));
        }
        // bit2: Y between c1-c3  (k,i,j+1)—(k,i+1,j+1)
        if (bits & 2) {
          edgeVert[1] = getVert(`y|${k0}|${i0}|${j1}`, lerpVerts(p1, p3, v1, v3));
        }
        // bit4: X between c2-c3  (k,i+1,j)—(k,i+1,j+1)
        if (bits & 4) {
          edgeVert[2] = getVert(`x|${k0}|${i1}|${j0}`, lerpVerts(p2, p3, v2, v3));
        }
        // bit8: Y between c0-c2  (k,i,j)—(k,i+1,j)
        if (bits & 8) {
          edgeVert[3] = getVert(`y|${k0}|${i0}|${j0}`, lerpVerts(p0, p2, v0, v2));
        }
        // bit16: X between c4-c5 upper
        if (bits & 16) {
          edgeVert[4] = getVert(`x|${k1}|${i0}|${j0}`, lerpVerts(p4, p5, v4, v5));
        }
        // bit32: Y between c5-c7
        if (bits & 32) {
          edgeVert[5] = getVert(`y|${k1}|${i0}|${j1}`, lerpVerts(p5, p7, v5, v7));
        }
        // bit64: X between c6-c7
        if (bits & 64) {
          edgeVert[6] = getVert(`x|${k1}|${i1}|${j0}`, lerpVerts(p6, p7, v6, v7));
        }
        // bit128: Y between c4-c6
        if (bits & 128) {
          edgeVert[7] = getVert(`y|${k1}|${i0}|${j0}`, lerpVerts(p4, p6, v4, v6));
        }
        // bit256: Z between c0-c4
        if (bits & 256) {
          edgeVert[8] = getVert(`z|${k0}|${i0}|${j0}`, lerpVerts(p0, p4, v0, v4));
        }
        // bit512: Z between c1-c5
        if (bits & 512) {
          edgeVert[9] = getVert(`z|${k0}|${i0}|${j1}`, lerpVerts(p1, p5, v1, v5));
        }
        // bit1024: Z between c3-c7  — three uses q1y = (j+1,i+1)
        if (bits & 1024) {
          edgeVert[10] = getVert(`z|${k0}|${i1}|${j1}`, lerpVerts(p3, p7, v3, v7));
        }
        // bit2048: Z between c2-c6
        if (bits & 2048) {
          edgeVert[11] = getVert(`z|${k0}|${i1}|${j0}`, lerpVerts(p2, p6, v2, v6));
        }

        // triTable indices are EDGE indices 0..11
        let off = cubeindex << 4;
        for (let t = 0; triTable[off + t] !== -1; t += 3) {
          const e0 = triTable[off + t];
          const e1 = triTable[off + t + 1];
          const e2 = triTable[off + t + 2];
          if (e0 < 0 || e1 < 0 || e2 < 0) break;
          const a = edgeVert[e0];
          const b = edgeVert[e1];
          const c = edgeVert[e2];
          if (a == null || b == null || c == null) continue;
          if (a === b || b === c || a === c) continue;
          indices.push(a, b, c);
        }
      }
    }
  }

  if (!positions.length || !indices.length) return null;

  const normals = new Float32Array(positions.length);
  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t] * 3;
    const ib = indices[t + 1] * 3;
    const ic = indices[t + 2] * 3;
    const ax = positions[ib] - positions[ia];
    const ay = positions[ib + 1] - positions[ia + 1];
    const az = positions[ib + 2] - positions[ia + 2];
    const bx = positions[ic] - positions[ia];
    const by = positions[ic + 1] - positions[ia + 1];
    const bz = positions[ic + 2] - positions[ia + 2];
    const nxv = ay * bz - az * by;
    const nyv = az * bx - ax * bz;
    const nzv = ax * by - ay * bx;
    for (const i of [ia, ib, ic]) {
      normals[i] += nxv;
      normals[i + 1] += nyv;
      normals[i + 2] += nzv;
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len;
    normals[i + 1] /= len;
    normals[i + 2] /= len;
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    normals,
  };
}

export function horizontalSliceMesh(values, opts, colorMap) {
  const { nx, ny, nz, xKm, yKm, zM, vertExag, k, elevFn = null } = opts;
  const kk = Math.max(0, Math.min(nz - 1, k | 0));
  const positions = new Float32Array(ny * nx * 3);
  const colors = new Float32Array(ny * nx * 3);
  let p = 0;
  let c = 0;
  for (let i = 0; i < ny; i += 1) {
    for (let j = 0; j < nx; j += 1) {
      const v = values[(kk * ny + i) * nx + j];
      const x = xKm[j];
      const yGeo = yKm[i];
      let y = (zM[kk] / 1000) * vertExag;
      if (typeof elevFn === "function") y += elevFn(x, yGeo);
      positions[p++] = x;
      positions[p++] = y;
      positions[p++] = -yGeo;
      const rgb = colorMap(v);
      colors[c++] = rgb[0];
      colors[c++] = rgb[1];
      colors[c++] = rgb[2];
    }
  }
  const indices = [];
  for (let i = 0; i < ny - 1; i += 1) {
    for (let j = 0; j < nx - 1; j += 1) {
      const a = i * nx + j;
      const b = a + 1;
      const d = (i + 1) * nx + j;
      const e = d + 1;
      indices.push(a, b, e, a, e, d);
    }
  }
  return {
    positions,
    colors,
    indices: new Uint32Array(indices),
    z_m: zM[kk],
  };
}

export function heightSurfaceMesh(height2d, opts) {
  const { nx, ny, xKm, yKm, vertExag, elevFn = null } = opts;
  const positions = [];
  const indices = [];
  const map = new Int32Array(ny * nx).fill(-1);
  let vid = 0;
  for (let i = 0; i < ny; i += 1) {
    for (let j = 0; j < nx; j += 1) {
      const h = height2d[i * nx + j];
      if (!Number.isFinite(h) || h < 1) continue;
      map[i * nx + j] = vid++;
      let y = (h / 1000) * vertExag;
      if (typeof elevFn === "function") y += elevFn(xKm[j], yKm[i]);
      positions.push(xKm[j], y, -yKm[i]);
    }
  }
  if (vid < 3) return null;
  for (let i = 0; i < ny - 1; i += 1) {
    for (let j = 0; j < nx - 1; j += 1) {
      const a = map[i * nx + j];
      const b = map[i * nx + j + 1];
      const c = map[(i + 1) * nx + j + 1];
      const d = map[(i + 1) * nx + j];
      if (a < 0 || b < 0 || c < 0 || d < 0) continue;
      indices.push(a, b, c, a, c, d);
    }
  }
  const pos = new Float32Array(positions);
  const idx = new Uint32Array(indices);
  const normals = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const ia = idx[t] * 3;
    const ib = idx[t + 1] * 3;
    const ic = idx[t + 2] * 3;
    const ax = pos[ib] - pos[ia];
    const ay = pos[ib + 1] - pos[ia + 1];
    const az = pos[ib + 2] - pos[ia + 2];
    const bx = pos[ic] - pos[ia];
    const by = pos[ic + 1] - pos[ia + 1];
    const bz = pos[ic + 2] - pos[ia + 2];
    const nxv = ay * bz - az * by;
    const nyv = az * bx - ax * bz;
    const nzv = ax * by - ay * bx;
    for (const ii of [ia, ib, ic]) {
      normals[ii] += nxv;
      normals[ii + 1] += nyv;
      normals[ii + 2] += nzv;
    }
  }
  for (let ii = 0; ii < normals.length; ii += 3) {
    const len = Math.hypot(normals[ii], normals[ii + 1], normals[ii + 2]) || 1;
    normals[ii] /= len;
    normals[ii + 1] /= len;
    normals[ii + 2] /= len;
  }
  return { positions: pos, indices: idx, normals };
}

/** Named RGB stop tables in [0,1]; sampled linearly in t∈[0,1]. */
export const COLORMAPS = {
  viridis: [
    [0.267, 0.005, 0.329],
    [0.283, 0.141, 0.458],
    [0.254, 0.265, 0.53],
    [0.207, 0.372, 0.553],
    [0.164, 0.471, 0.558],
    [0.128, 0.567, 0.551],
    [0.135, 0.659, 0.518],
    [0.267, 0.749, 0.441],
    [0.478, 0.821, 0.318],
    [0.741, 0.873, 0.15],
    [0.993, 0.906, 0.144],
  ],
  plasma: [
    [0.05, 0.03, 0.528],
    [0.327, 0.019, 0.62],
    [0.545, 0.038, 0.647],
    [0.725, 0.11, 0.585],
    [0.865, 0.21, 0.485],
    [0.953, 0.347, 0.376],
    [0.988, 0.502, 0.278],
    [0.98, 0.663, 0.178],
    [0.94, 0.82, 0.1],
    [0.94, 0.975, 0.131],
  ],
  turbo: [
    [0.19, 0.07, 0.23],
    [0.25, 0.3, 0.75],
    [0.15, 0.65, 0.9],
    [0.2, 0.9, 0.5],
    [0.85, 0.95, 0.2],
    [0.98, 0.7, 0.1],
    [0.9, 0.25, 0.1],
  ],
  coolwarm: [
    [0.23, 0.3, 0.75],
    [0.55, 0.7, 0.9],
    [0.95, 0.95, 0.95],
    [0.95, 0.65, 0.5],
    [0.7, 0.1, 0.15],
  ],
  grayscale: [
    [0.05, 0.05, 0.07],
    [0.5, 0.5, 0.52],
    [0.95, 0.95, 0.97],
  ],
  magma: [
    [0.001, 0.0, 0.014],
    [0.232, 0.06, 0.358],
    [0.55, 0.14, 0.42],
    [0.87, 0.29, 0.3],
    [0.99, 0.65, 0.38],
    [0.99, 0.99, 0.75],
  ],
};

export const COLORMAP_NAMES = Object.keys(COLORMAPS);

function sampleStops(stops, t) {
  const n = stops.length;
  if (n === 1) return stops[0].slice();
  const x = Math.max(0, Math.min(1, t)) * (n - 1);
  const i0 = Math.floor(x);
  const i1 = Math.min(n - 1, i0 + 1);
  const f = x - i0;
  const a = stops[i0];
  const b = stops[i1];
  return [
    a[0] * (1 - f) + b[0] * f,
    a[1] * (1 - f) + b[1] * f,
    a[2] * (1 - f) + b[2] * f,
  ];
}

/** RGB 0–1 for normalized t. */
export function colormapRgb(name, t) {
  const stops = COLORMAPS[name] || COLORMAPS.viridis;
  return sampleStops(stops, t);
}

/** CSS linear-gradient for HUD colorbars. */
export function colormapCssGradient(name, steps = 12) {
  const stops = [];
  for (let i = 0; i < steps; i += 1) {
    const t = steps <= 1 ? 0 : i / (steps - 1);
    const [r, g, b] = colormapRgb(name, t);
    const pct = (t * 100).toFixed(1);
    stops.push(
      `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}) ${pct}%`
    );
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** Hex string (#rrggbb) for a physical value under vmin/vmax. */
export function colorHexForValue(v, vmin, vmax, name = "viridis") {
  const lo = vmin;
  const hi = vmax <= vmin ? vmin + 1e-6 : vmax;
  let t = (v - lo) / (hi - lo);
  t = Math.max(0, Math.min(1, t));
  const [r, g, b] = colormapRgb(name, t);
  const toByte = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  const hex = (n) => n.toString(16).padStart(2, "0");
  return `#${hex(toByte(r))}${hex(toByte(g))}${hex(toByte(b))}`;
}

/**
 * Continuous colormap for slice vertex colors.
 * @param {number} vmin
 * @param {number} vmax
 * @param {string} [name='viridis']
 */
export function makeColorMap(vmin, vmax, name = "viridis") {
  const lo = vmin;
  const hi = vmax <= vmin ? vmin + 1 : vmax;
  const stops = COLORMAPS[name] || COLORMAPS.viridis;
  return function colorMap(v) {
    if (!Number.isFinite(v)) return [0.15, 0.18, 0.22];
    let t = (v - lo) / (hi - lo);
    t = Math.max(0, Math.min(1, t));
    return sampleStops(stops, t);
  };
}

/** Contour levels from vmin..vmax at interval Δ (inclusive ends when they land). */
export function contourLevels(vmin, vmax, interval, maxLevels = 12) {
  const lo = Number(vmin);
  const hi = Number(vmax);
  const d = Number(interval);
  if (![lo, hi, d].every(Number.isFinite) || d <= 0 || hi <= lo) return [];
  const start = Math.ceil(lo / d - 1e-9) * d;
  const out = [];
  for (let v = start; v <= hi + 1e-9 && out.length < maxLevels; v += d) {
    const x = Math.abs(v) < 1e-10 ? 0 : Number(v.toFixed(6));
    out.push(x);
  }
  if (!out.length) out.push(lo);
  if (out[out.length - 1] < hi - 1e-6 && out.length < maxLevels) out.push(hi);
  return out;
}

export const LAYER_PALETTE = [0x38bdf8, 0xa78bfa, 0x34d399, 0xfbbf24, 0xf472b6, 0x22d3ee];
