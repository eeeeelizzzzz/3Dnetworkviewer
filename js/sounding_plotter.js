/**
 * Plotly panels: profile, multi-source time series, cross-section heatmap.
 */
(function (global) {
  "use strict";

  const DEFAULT_PALETTE = {
    UAS: "#B900C7",
    HRRR: "#777777",
    A: "#DE8A00",
    B: "#3018A9",
    C: "#88CCEE",
  };

  const SOURCE_LABELS = {
    UAS: "UAS y",
    HRRR: "HRRR H(x_b)",
    A: "A 3D-Var",
    B: "B residual",
    C: "C multi-obs",
  };

  function cleanXY(x, z) {
    const xx = [];
    const zz = [];
    if (!x || !z) return { x: xx, y: zz };
    const n = Math.min(x.length, z.length);
    for (let i = 0; i < n; i += 1) {
      if (x[i] == null || z[i] == null) continue;
      if (!Number.isFinite(x[i]) || !Number.isFinite(z[i])) continue;
      xx.push(x[i]);
      zz.push(z[i]);
    }
    return { x: xx, y: zz };
  }

  function unitFor(variable) {
    if (variable === "temperature") return "°C";
    if (variable === "relative_humidity") return "%";
    if (
      variable === "wind_speed" ||
      variable === "u_wind" ||
      variable === "v_wind"
    ) {
      return "m s⁻¹";
    }
    if (variable === "theta_k") return "K";
    return "";
  }

  /**
   * Render profile from optional source columns + toggles.
   * opts.sources: { UAS: {z, var}, HRRR:..., A:... }
   * opts.enabled: string[] of keys to show
   * opts.mode: 'site' | 'grid'
   * opts.xRange / opts.zRange: [min, max] optional axis limits
   */
  function renderSounding(elId, options) {
    const opts = options || {};
    const palette = Object.assign({}, DEFAULT_PALETTE, opts.palette || {});
    const variable = opts.variable || "temperature";
    const mode = opts.mode || "site";
    const enabled = new Set(opts.enabled || Object.keys(opts.sources || {}));
    const sources = opts.sources || {};
    const highlight = opts.highlight || null;
    const unit = unitFor(variable);
    const traces = [];

    const el0 = document.getElementById(elId);
    if (el0 && window.Plotly && el0.layout && el0.layout.xaxis && el0.layout.xaxis.scaleanchor) {
      try {
        Plotly.purge(el0);
      } catch (_) {
        /* ignore */
      }
    }

    function add(key, dash, width, styleExtra) {
      if (!enabled.has(key)) return;
      const src = sources[key];
      if (!src) return;
      const c = cleanXY(src[variable], src.z);
      if (!c.x.length) return;
      const isHi = highlight === key;
      const tr = {
        x: c.x,
        y: c.y,
        mode: mode === "site" && key === "UAS" ? "lines+markers" : "lines",
        name: SOURCE_LABELS[key] || key,
        line: {
          color: palette[key] || "#94a3b8",
          width: isHi ? (width || 2.4) + 0.6 : width || 2.2,
          dash: dash || "solid",
        },
        hovertemplate: "%{y:.0f} m · %{x:.2f}<extra>" + (SOURCE_LABELS[key] || key) + "</extra>",
        legendgroup: key,
      };
      if (mode === "site" && key === "UAS") {
        tr.marker = { size: 4, color: palette.UAS };
      }
      if (mode === "grid" && key !== "UAS") {
        tr.line.width = (tr.line.width || 2) * 0.95;
        if (key === "HRRR") tr.line.dash = "dash";
      }
      if (styleExtra) Object.assign(tr, styleExtra);
      traces.push(tr);
    }

    if (mode === "site") {
      add("UAS", "solid", 2.9);
      add("HRRR", "dash", 1.9);
      add("A", "solid", 2.0);
      add("B", "solid", 2.4);
      add("C", "solid", 2.0);
    } else {
      add("UAS", "solid", 2.4);
      add("HRRR", "dot", 2.0);
      add("A", "solid", 2.1);
      add("B", "solid", 2.5);
      add("C", "solid", 2.1);
    }

    const zRange = Array.isArray(opts.zRange) && opts.zRange.length === 2
      ? opts.zRange
      : [0, 1500];
    const layout = {
      // Panel header carries the probe label — skip Plotly title to avoid duplicate text
      title: { text: "" },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: mode === "site" ? "rgba(40,10,45,0.15)" : "rgba(8,28,45,0.2)",
      xaxis: {
        title: { text: unit || variable, font: { size: 10 } },
        color: "#94a3b8",
        gridcolor: "#334155",
        zeroline: false,
      },
      yaxis: {
        title: { text: "AGL (m)", font: { size: 10 } },
        color: "#94a3b8",
        gridcolor: "#334155",
        range: zRange,
        zeroline: false,
      },
      margin: { l: 46, r: 8, t: 8, b: 32 },
      showlegend: false,
    };
    if (Array.isArray(opts.xRange) && opts.xRange.length === 2) {
      layout.xaxis.range = opts.xRange;
    }
    if (!traces.length) {
      layout.annotations = [
        {
          text:
            opts.emptyText ||
            (mode === "grid"
              ? "Enable A/B/C/HRRR · click domain"
              : "No profile for site / sources"),
          xref: "paper",
          yref: "paper",
          x: 0.5,
          y: 0.5,
          showarrow: false,
          font: { color: "#94a3b8" },
        },
      ];
    }
    Plotly.react(elId, traces, layout, { responsive: true, displayModeBar: false });

    const legendEl = document.getElementById(opts.legendId || "profile-legend");
    if (legendEl) {
      legendEl.innerHTML = "";
      const modeNote = document.createElement("span");
      modeNote.className = "lg-note";
      modeNote.textContent = opts.emptyText
        ? opts.emptyText
        : mode === "site"
          ? "OBS — UAS + columns @ site"
          : "GRID — 3D volume sample";
      legendEl.appendChild(modeNote);
      traces.forEach((tr) => {
        const item = document.createElement("span");
        item.className = "lg-item";
        const sw = document.createElement("span");
        const dash = tr.line && tr.line.dash && tr.line.dash !== "solid";
        sw.className = "lg-swatch" + (dash ? " is-dash" : "");
        const col = (tr.line && tr.line.color) || "#e2e8f0";
        sw.style.color = col;
        if (!dash) sw.style.background = col;
        item.appendChild(sw);
        item.appendChild(document.createTextNode(tr.name));
        legendEl.appendChild(item);
      });
    }
  }

  function renderTimeSeries(elId, series, options) {
    const opts = options || {};
    const mode = opts.mode || "site";
    const traces = (series || []).map((s) => ({
      x: s.times,
      y: s.values,
      mode: s.style === "markers" ? "markers" : "lines+markers",
      name: s.name,
      line: {
        color: s.color,
        width: s.width || 2,
        dash: s.dash || "solid",
      },
      marker: { size: s.markerSize || 5, color: s.color },
    }));
    const layout = {
      title: { text: "" },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: mode === "site" ? "rgba(40,10,45,0.12)" : "rgba(8,28,45,0.18)",
      xaxis: { color: "#94a3b8", gridcolor: "#334155", tickangle: -30, tickfont: { size: 9 } },
      yaxis: {
        title: { text: opts.ylabel || "", font: { size: 10 } },
        color: "#94a3b8",
        gridcolor: "#334155",
      },
      margin: { l: 48, r: 10, t: 18, b: 42 },
      legend: {
        font: { color: "#e2e8f0", size: 9 },
        bgcolor: "rgba(0,0,0,0)",
        orientation: "h",
        y: 1.08,
        x: 0,
      },
      showlegend: true,
    };
    if (opts.margin) {
      layout.margin = Object.assign({}, layout.margin, opts.margin);
    }
    if (Array.isArray(opts.yRange) && opts.yRange.length === 2) {
      layout.yaxis.range = opts.yRange;
    }
    if (!traces.length) {
      layout.annotations = [
        {
          text: opts.emptyText || "Toggle series sources",
          xref: "paper",
          yref: "paper",
          x: 0.5,
          y: 0.5,
          showarrow: false,
          font: { color: "#94a3b8" },
        },
      ];
    }
    Plotly.react(elId, traces, layout, { responsive: true, displayModeBar: false });
  }

  function renderCrossSection(elId, section, options) {
    const opts = options || {};
    const kind = (section && section.kind) || opts.kind || "spatial";
    if (!section || !section.grid) {
      const emptyText =
        opts.emptyText ||
        (kind === "timeheight"
          ? "Time–height at probe — pick a site or grid column"
          : "Draw a section line in the 3D view");
      Plotly.react(
        elId,
        [],
        {
          paper_bgcolor: "rgba(0,0,0,0)",
          plot_bgcolor: "rgba(0,0,0,0)",
          annotations: [
            {
              text: emptyText,
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
          margin: { l: 40, r: 10, t: 10, b: 20 },
        },
        { responsive: true, displayModeBar: false }
      );
      return;
    }
    const isTH = kind === "timeheight";
    const colorscale = opts.colorscale || "Viridis";
    const trace = {
      z: section.grid,
      x: section.xAxis,
      y: section.zAxis,
      type: "heatmap",
      colorscale,
      zsmooth: false,
      colorbar: {
        title: opts.unit || section.unit || "",
        len: 0.65,
        thickness: 10,
        tickfont: { size: 9 },
      },
      hovertemplate: isTH
        ? "t=%{x}<br>z=%{y:.0f} m<br>%{z:.2f}<extra></extra>"
        : "s=%{x:.1f} km<br>z=%{y:.0f} m<br>%{z:.2f}<extra></extra>",
    };
    if (opts.zmin != null && Number.isFinite(Number(opts.zmin))) {
      trace.zmin = Number(opts.zmin);
    }
    if (opts.zmax != null && Number.isFinite(Number(opts.zmax))) {
      trace.zmax = Number(opts.zmax);
    }
    if (opts.reversescale) trace.reversescale = true;
    let zTop = 1500;
    if (section.zAxis && section.zAxis.length) {
      zTop = section.zAxis[0];
      for (let i = 1; i < section.zAxis.length; i += 1) {
        if (Number.isFinite(section.zAxis[i]) && section.zAxis[i] > zTop) {
          zTop = section.zAxis[i];
        }
      }
    }
    const titleText = isTH
      ? section.title || `Time–height · ${section.variable}`
      : `${section.dist != null ? Number(section.dist).toFixed(1) : "—"} km · ${section.variable}`;
    const hostEl = typeof elId === "string" ? document.getElementById(elId) : elId;
    const fit = !!opts.fitContainer;
    const forcedH = opts.height != null && Number.isFinite(Number(opts.height)) ? Number(opts.height) : null;
    const hostH = forcedH || (hostEl ? hostEl.clientHeight : 0);
    const hostW = hostEl ? hostEl.clientWidth : 0;
    if (hostEl && forcedH) {
      hostEl.style.height = `${forcedH}px`;
    }
    const layout = {
      title: {
        text: titleText,
        font: { color: "#e2e8f0", size: 11 },
        x: 0.02,
        xanchor: "left",
      },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      autosize: !forcedH,
      xaxis: {
        title: isTH ? "Valid time" : "km",
        color: "#94a3b8",
        gridcolor: "#334155",
        tickfont: { size: 9 },
        tickangle: isTH ? -35 : 0,
        type: isTH ? "category" : "linear",
      },
      yaxis: {
        title: "AGL m",
        color: "#94a3b8",
        gridcolor: "#334155",
        range: [0, zTop],
        tickfont: { size: 9 },
      },
      margin: { l: 46, r: 16, t: 26, b: isTH ? 52 : 34 },
    };
    // Pin size to the cell so stacked panels cannot overflow into each other
    if ((fit || forcedH) && hostH > 40) layout.height = hostH;
    if (fit && hostW > 40) layout.width = hostW;
    Plotly.react(elId, [trace], layout, {
      responsive: !forcedH,
      displayModeBar: false,
    });
  }

  /**
   * Wind hodograph: u (+east) vs v (+north). Open circle = lowest valid level ≥ 50 m AGL.
   * opts.sources: { KEY: { z, u_wind, v_wind } }
   * opts.zMinM: minimum height to plot (default 50 m AGL)
   */
  function renderHodograph(elId, options) {
    const opts = options || {};
    const palette = Object.assign({}, DEFAULT_PALETTE, opts.palette || {});
    const mode = opts.mode || "site";
    const enabled = new Set(opts.enabled || Object.keys(opts.sources || {}));
    const sources = opts.sources || {};
    const highlight = opts.highlight || null;
    const zMinM = opts.zMinM != null && Number.isFinite(Number(opts.zMinM)) ? Number(opts.zMinM) : 50;
    const dataTraces = [];
    let maxR = 8;

    function add(key, dash, width) {
      if (!enabled.has(key)) return;
      const src = sources[key];
      if (!src || !src.z || !src.u_wind || !src.v_wind) return;
      const u = [];
      const v = [];
      const z = [];
      const n = Math.min(src.z.length, src.u_wind.length, src.v_wind.length);
      for (let i = 0; i < n; i += 1) {
        const uu = Number(src.u_wind[i]);
        const vv = Number(src.v_wind[i]);
        const zz = Number(src.z[i]);
        if (!Number.isFinite(uu) || !Number.isFinite(vv) || !Number.isFinite(zz)) continue;
        if (zz < zMinM) continue;
        u.push(uu);
        v.push(vv);
        z.push(zz);
        maxR = Math.max(maxR, Math.hypot(uu, vv));
      }
      if (!u.length) return;
      const col = palette[key] || "#94a3b8";
      const isHi = highlight === key;
      dataTraces.push({
        x: u,
        y: v,
        customdata: z,
        mode: "lines+markers",
        name: SOURCE_LABELS[key] || key,
        line: {
          color: col,
          width: isHi ? (width || 2.2) + 0.5 : width || 2.0,
          dash: dash || "solid",
        },
        marker: {
          size: mode === "site" && key === "UAS" ? 5 : 3.5,
          color: col,
        },
        hovertemplate:
          "u=%{x:.1f}<br>v=%{y:.1f}<br>z=%{customdata:.0f} m AGL<extra>" +
          (SOURCE_LABELS[key] || key) +
          "</extra>",
        legendgroup: key,
        showlegend: false,
      });
      dataTraces.push({
        x: [u[0]],
        y: [v[0]],
        mode: "markers",
        marker: {
          size: 9,
          symbol: "circle-open",
          color: col,
          line: { width: 2, color: col },
        },
        hoverinfo: "skip",
        showlegend: false,
        legendgroup: key,
      });
    }

    const order =
      mode === "site"
        ? [
            ["UAS", "solid", 2.6],
            ["HRRR", "dash", 1.7],
            ["A", "solid", 1.8],
            ["B", "solid", 2.2],
            ["C", "solid", 1.8],
          ]
        : [
            ["UAS", "solid", 2.2],
            ["HRRR", "dot", 1.8],
            ["A", "solid", 1.9],
            ["B", "solid", 2.3],
            ["C", "solid", 1.9],
          ];
    order.forEach(function (row) {
      add(row[0], row[1], row[2]);
    });

    maxR = Math.max(8, Math.ceil(maxR / 2) * 2 + 2);
    if (opts.maxR != null && Number.isFinite(Number(opts.maxR))) {
      maxR = Math.max(4, Number(opts.maxR));
    }
    const guide = [];
    for (let r = 5; r <= maxR; r += 5) {
      const tx = [];
      const ty = [];
      for (let i = 0; i <= 72; i += 1) {
        const a = (i / 72) * Math.PI * 2;
        tx.push(r * Math.sin(a));
        ty.push(r * Math.cos(a));
      }
      guide.push({
        x: tx,
        y: ty,
        mode: "lines",
        line: { color: "rgba(148,163,184,0.32)", width: 1, dash: "dot" },
        hoverinfo: "skip",
        showlegend: false,
      });
    }
    guide.push({
      x: [-maxR, maxR],
      y: [0, 0],
      mode: "lines",
      line: { color: "rgba(148,163,184,0.5)", width: 1 },
      hoverinfo: "skip",
      showlegend: false,
    });
    guide.push({
      x: [0, 0],
      y: [-maxR, maxR],
      mode: "lines",
      line: { color: "rgba(148,163,184,0.5)", width: 1 },
      hoverinfo: "skip",
      showlegend: false,
    });

    const traces = guide.concat(dataTraces);
    const layout = {
      title: { text: "" },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: mode === "site" ? "rgba(40,10,45,0.12)" : "rgba(8,28,45,0.18)",
      xaxis: {
        title: { text: "u (m/s, +E)", font: { size: 10 } },
        color: "#94a3b8",
        gridcolor: "#334155",
        zeroline: false,
        range: [-maxR, maxR],
        constrain: "domain",
        scaleanchor: "y",
        scaleratio: 1,
      },
      yaxis: {
        title: { text: "v (m/s, +N)", font: { size: 10 } },
        color: "#94a3b8",
        gridcolor: "#334155",
        zeroline: false,
        range: [-maxR, maxR],
        constrain: "domain",
      },
      margin: { l: 48, r: 10, t: 10, b: 40 },
      showlegend: false,
      annotations: [
        {
          x: 0,
          y: maxR * 0.88,
          text: "N",
          showarrow: false,
          font: { color: "#86efac", size: 11 },
        },
      ],
    };

    if (!dataTraces.length) {
      layout.annotations.push({
        text:
          opts.emptyText ||
          (mode === "grid"
            ? "Enable A / B / C / HRRR for wind"
            : "No u/v wind for selected sources"),
        xref: "paper",
        yref: "paper",
        x: 0.5,
        y: 0.5,
        showarrow: false,
        font: { color: "#94a3b8", size: 12 },
      });
    }

    var el = document.getElementById(elId);
    // Clear prior profile axes so scaleanchor does not inherit AGL [0,1500]
    if (el && window.Plotly && el.data) {
      try {
        Plotly.purge(el);
      } catch (e) {
        /* ignore */
      }
    }
    Plotly.react(elId, traces, layout, { responsive: true, displayModeBar: false });
    if (el && window.Plotly) {
      try {
        Plotly.Plots.resize(el);
      } catch (e2) {
        /* ignore */
      }
    }

    const legendEl = document.getElementById(opts.legendId || "profile-legend");
    if (legendEl) {
      legendEl.innerHTML = "";
      const modeNote = document.createElement("span");
      modeNote.className = "lg-note";
      modeNote.textContent = opts.emptyText
        ? opts.emptyText
        : mode === "site"
          ? "HODO — OBS site wind"
          : "HODO — grid column";
      legendEl.appendChild(modeNote);
      const tip = document.createElement("span");
      tip.className = "lg-note";
      tip.textContent = `Open ○ = first level ≥ ${zMinM} m AGL`;
      legendEl.appendChild(tip);
      ["UAS", "HRRR", "A", "B", "C"].forEach(function (key) {
        if (!enabled.has(key) || !sources[key]) return;
        const src = sources[key];
        if (!src.u_wind || !src.v_wind) return;
        const item = document.createElement("span");
        item.className = "lg-item";
        const sw = document.createElement("span");
        sw.className = "lg-swatch";
        const col = palette[key] || "#e2e8f0";
        sw.style.background = col;
        item.appendChild(sw);
        item.appendChild(document.createTextNode(SOURCE_LABELS[key] || key));
        legendEl.appendChild(item);
      });
    }
  }

  function valueAtHeight(src, variable, heightM) {
    if (!src || !src.z || !src[variable]) return null;
    const z = src.z;
    const v = src[variable];
    let best = null;
    let bestD = Infinity;
    for (let i = 0; i < z.length; i += 1) {
      if (z[i] == null || v[i] == null) continue;
      if (!Number.isFinite(z[i]) || !Number.isFinite(v[i])) continue;
      const d = Math.abs(z[i] - heightM);
      if (d < bestD) {
        bestD = d;
        best = v[i];
      }
    }
    return best;
  }

  function dewpointC(tC, rhPct) {
    const t = Number(tC);
    const rh = Number(rhPct);
    if (!Number.isFinite(t) || !Number.isFinite(rh) || rh <= 0) return null;
    const a = 17.625;
    const b = 243.04;
    const r = Math.min(Math.max(rh, 0.1), 100) / 100;
    const gamma = Math.log(r) + (a * t) / (b + t);
    const td = (b * gamma) / (a - gamma);
    return Number.isFinite(td) ? td : null;
  }

  /** ISA pressure (hPa) from height AGL plus surface elevation MSL. */
  function pressureHpa(zAgl, elevMsl) {
    const z = (Number(elevMsl) || 320) + (Number(zAgl) || 0);
    const p = 1013.25 * Math.pow(Math.max(1 - 2.25577e-5 * z, 1e-6), 5.25588);
    return Number.isFinite(p) ? p : null;
  }

  /**
   * Skew-T coordinate: MetPy/NWS-style.
   * Isotherms tilt up-and-to-the-right (~30°). At 1000 hPa, skewX(T)=T so
   * bottom-axis tick labels are true temperature (°C).
   * SKEW ≈ tan(30°) * 100 °C per log10 pressure decade (MetPy default rotation).
   */
  const SKEW_T_ROT_DEG = 30;
  const SKEW_T_ASPECT = 100; // °C per decade of pressure (display aspect)
  const SKEW_T_FACTOR = Math.tan((SKEW_T_ROT_DEG * Math.PI) / 180) * SKEW_T_ASPECT;

  function skewX(tC, pHpa) {
    const p = Math.max(Number(pHpa) || 1000, 50);
    return Number(tC) + SKEW_T_FACTOR * Math.log10(1000 / p);
  }

  function windDirFromUV(u, v) {
    if (!Number.isFinite(u) || !Number.isFinite(v)) return null;
    let deg = (Math.atan2(u, v) * 180) / Math.PI + 180;
    return ((deg % 360) + 360) % 360;
  }

  /**
   * Standard skew-T log-P. T solid, Td dashed.
   * opts.sources / enabled / palette / elevMsl / title
   *
   * Plotly log-axis `range` must be log10(hPa), not raw hPa.
   */
  function renderSkewT(elId, options) {
    const opts = options || {};
    const palette = Object.assign({}, DEFAULT_PALETTE, opts.palette || {});
    const enabled = new Set(opts.enabled || ["UAS"]);
    const sources = opts.sources || {};
    const elevMsl =
      opts.elevMsl != null
        ? Number(opts.elevMsl)
        : opts.elev_msl != null
          ? Number(opts.elev_msl)
          : 320;
    const traces = [];
    let tMin = Infinity;
    let tMax = -Infinity;
    let haveData = false;

    // Standard sounding frame (MetPy-like). UAS only fills the lower part.
    const pBot = 1050;
    const pTop = 200;
    const pIsobars = [1000, 925, 850, 700, 500, 400, 300, 250, 200];
    const pGrid = [];
    for (let p = 1050; p >= 200; p -= 10) pGrid.push(p);
    const tIsotherms = [];
    for (let t = -80; t <= 50; t += 5) tIsotherms.push(t);

    function addGridLine(xs, ys, color, width, dash) {
      traces.push({
        x: xs,
        y: ys,
        mode: "lines",
        line: { color: color, width: width || 1, dash: dash || "solid" },
        hoverinfo: "skip",
        showlegend: false,
      });
    }

    // Isobars (horizontal on log-P)
    pIsobars.forEach((p) => {
      addGridLine(
        [skewX(-80, p), skewX(50, p)],
        [p, p],
        "rgba(148,163,184,0.35)",
        1
      );
    });

    // Isotherms — MUST lean up and to the RIGHT (standard skew-T)
    tIsotherms.forEach((t) => {
      const major = t % 10 === 0;
      const zero = t === 0;
      const xs = pGrid.map((p) => skewX(t, p));
      addGridLine(
        xs,
        pGrid.slice(),
        zero ? "rgba(248,113,113,0.55)" : major ? "rgba(248,113,113,0.28)" : "rgba(148,163,184,0.12)",
        zero ? 1.6 : major ? 1.15 : 0.8
      );
    });

    // Dry adiabats (θ constant)
    for (let theta = -30; theta <= 50; theta += 10) {
      const ax = [];
      const ay = [];
      pGrid.forEach((p) => {
        const tC = (theta + 273.15) * Math.pow(p / 1000, 0.2854) - 273.15;
        if (tC < -80 || tC > 50) return;
        ax.push(skewX(tC, p));
        ay.push(p);
      });
      if (ax.length > 1) addGridLine(ax, ay, "rgba(74,222,128,0.18)", 1, "dot");
    }

    // Mixing-ratio lines (approx, g/kg) — lean opposite to dry adiabats
    const mixRates = [0.4, 1, 2, 4, 7, 10, 16, 24];
    mixRates.forEach((w) => {
      const ax = [];
      const ay = [];
      // e ≈ (w/1000) * p / (0.622 + w/1000); Td from vapor pressure (Bolton-ish)
      pGrid.forEach((p) => {
        if (p < 400) return;
        const e = (w / 1000) * p / (0.622 + w / 1000);
        if (e <= 0.01) return;
        const td = (243.5 * Math.log(e / 6.112)) / (17.67 - Math.log(e / 6.112));
        if (!Number.isFinite(td) || td < -80 || td > 40) return;
        ax.push(skewX(td, p));
        ay.push(p);
      });
      if (ax.length > 1) addGridLine(ax, ay, "rgba(34,211,238,0.16)", 1, "dash");
    });

    function addSource(key, width) {
      if (!enabled.has(key)) return;
      const src = sources[key];
      if (!src || !src.z || !src.temperature) return;
      const tX = [];
      const tY = [];
      const tVals = [];
      const dX = [];
      const dY = [];
      const dVals = [];
      const n = Math.min(src.z.length, src.temperature.length);
      const rh = src.relative_humidity || [];
      for (let i = 0; i < n; i += 1) {
        const t = Number(src.temperature[i]);
        const z = Number(src.z[i]);
        if (!Number.isFinite(t) || !Number.isFinite(z)) continue;
        const p = pressureHpa(z, elevMsl);
        if (!p || p < pTop || p > pBot) continue;
        tX.push(skewX(t, p));
        tY.push(p);
        tVals.push(t);
        haveData = true;
        tMin = Math.min(tMin, t);
        tMax = Math.max(tMax, t);
        const td = dewpointC(t, rh[i]);
        if (td != null) {
          dX.push(skewX(td, p));
          dY.push(p);
          dVals.push(td);
          tMin = Math.min(tMin, td);
        }
      }
      if (!tX.length) return;
      const col = palette[key] || "#94a3b8";
      const lab = SOURCE_LABELS[key] || key;
      traces.push({
        x: tX,
        y: tY,
        mode: "lines",
        name: `${lab} T`,
        line: { color: col, width: width || 2.6 },
        hovertemplate: `${lab} T<br>%{customdata:.1f} °C<br>%{y:.0f} hPa<extra></extra>`,
        customdata: tVals,
        legendgroup: key,
      });
      if (dX.length) {
        traces.push({
          x: dX,
          y: dY,
          mode: "lines",
          name: `${lab} Td`,
          line: { color: col, width: Math.max(1.3, (width || 2.6) - 0.7), dash: "dash" },
          hovertemplate: `${lab} Td<br>%{customdata:.1f} °C<br>%{y:.0f} hPa<extra></extra>`,
          customdata: dVals,
          legendgroup: key,
        });
      }
    }

    addSource("UAS", 2.9);
    addSource("HRRR", 1.9);
    addSource("A", 2.0);
    addSource("B", 2.1);
    addSource("C", 2.0);

    // Temperature window in true °C along 1000 hPa (MetPy-like xlim)
    let tLeft = -30;
    let tRight = 40;
    if (Number.isFinite(tMin) && Number.isFinite(tMax)) {
      tLeft = Math.min(tLeft, Math.floor(tMin / 5) * 5 - 5);
      tRight = Math.max(tRight, Math.ceil(tMax / 5) * 5 + 5);
    }
    // Expand right for skew at top of diagram so isotherms stay in frame
    const xLeft = skewX(tLeft, pBot);
    const xRight = skewX(tRight, pTop);
    const tickTs = [];
    for (let t = Math.ceil(tLeft / 10) * 10; t <= tRight; t += 10) tickTs.push(t);

    // Isotherm labels along mid-levels (true T), not misleading vertical ticks alone
    const annotations = tickTs.filter((t) => t >= -20 && t <= 40).map((t) => ({
      x: skewX(t, 850),
      y: 850,
      text: String(t),
      showarrow: false,
      font: { size: 9, color: "rgba(248,113,113,0.75)" },
      xanchor: "center",
      yanchor: "bottom",
    }));

    const layout = {
      title: {
        text: opts.title || "",
        font: { color: "#e2e8f0", size: 11 },
        x: 0.02,
        xanchor: "left",
      },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(15,23,42,0.55)",
      xaxis: {
        title: { text: "Temperature (°C) — isotherms skewed 30°", font: { size: 10 } },
        color: "#94a3b8",
        showgrid: false,
        zeroline: false,
        tickfont: { size: 9 },
        range: [xLeft, xRight],
        // Bottom ticks = true T at 1000 hPa (skewX(T,1000) === T)
        tickmode: "array",
        tickvals: tickTs.map((t) => skewX(t, 1000)),
        ticktext: tickTs.map(String),
      },
      yaxis: {
        title: { text: "Pressure (hPa)", font: { size: 10 } },
        color: "#94a3b8",
        showgrid: false,
        tickfont: { size: 9 },
        type: "log",
        // Plotly log range is log10(data values)
        range: [Math.log10(pBot), Math.log10(pTop)],
        tickmode: "array",
        tickvals: pIsobars,
        ticktext: pIsobars.map(String),
      },
      margin: { l: 54, r: 14, t: 36, b: 44 },
      legend: {
        font: { color: "#e2e8f0", size: 9 },
        bgcolor: "rgba(0,0,0,0)",
        orientation: "h",
        y: 1.14,
        x: 0,
      },
      showlegend: traces.some((tr) => tr.showlegend !== false && tr.name),
      annotations: annotations,
    };

    if (!haveData) {
      layout.annotations = [
        {
          text: opts.emptyText || opts.empty_text || "No profile at this time",
          xref: "paper",
          yref: "paper",
          x: 0.5,
          y: 0.5,
          showarrow: false,
          font: { color: "#94a3b8" },
        },
      ];
    }

    const el = document.getElementById(elId);
    if (el && window.Plotly && el.data) {
      try {
        Plotly.purge(el);
      } catch (_) {
        /* ignore */
      }
    }
    Plotly.react(elId, traces, layout, { responsive: true, displayModeBar: false });
  }

  /**
   * Wind speed (left) and direction (right) vs height AGL.
   * opts.sources: { KEY: { z, wind_speed?, u_wind, v_wind } }
   */
  function renderWindProfile(elId, options) {
    const opts = options || {};
    const palette = Object.assign({}, DEFAULT_PALETTE, opts.palette || {});
    const enabled = new Set(opts.enabled || ["UAS"]);
    const sources = opts.sources || {};
    const zMin = opts.zMin != null ? Number(opts.zMin) : 0;
    const zMax = opts.zMax != null ? Number(opts.zMax) : 1500;
    const traces = [];

    function add(key, width, dash) {
      if (!enabled.has(key)) return;
      const src = sources[key];
      if (!src || !src.z) return;
      const z = [];
      const spd = [];
      const dir = [];
      const n = src.z.length;
      for (let i = 0; i < n; i += 1) {
        const zz = Number(src.z[i]);
        if (!Number.isFinite(zz)) continue;
        let ws = src.wind_speed ? Number(src.wind_speed[i]) : NaN;
        const u = src.u_wind ? Number(src.u_wind[i]) : NaN;
        const v = src.v_wind ? Number(src.v_wind[i]) : NaN;
        if (!Number.isFinite(ws) && Number.isFinite(u) && Number.isFinite(v)) {
          ws = Math.hypot(u, v);
        }
        if (!Number.isFinite(ws)) continue;
        z.push(zz);
        spd.push(ws);
        dir.push(windDirFromUV(u, v));
      }
      if (!z.length) return;
      const col = palette[key] || "#94a3b8";
      const lab = SOURCE_LABELS[key] || key;
      traces.push({
        x: spd,
        y: z,
        xaxis: "x",
        yaxis: "y",
        mode: "lines",
        name: lab,
        line: { color: col, width: width || 2.2, dash: dash || "solid" },
        hovertemplate: `${lab}<br>%{x:.1f} m s⁻¹<br>%{y:.0f} m<extra></extra>`,
        legendgroup: key,
      });
      // Wind direction as points (not lines) — direction wrapping looks wrong as a continuous line
      traces.push({
        x: dir,
        y: z,
        xaxis: "x2",
        yaxis: "y2",
        mode: "markers",
        name: lab,
        marker: {
          color: col,
          size: key === "UAS" ? 6 : 5,
          symbol: "circle",
          line: { width: 0 },
        },
        hovertemplate: `${lab}<br>%{x:.0f}°<br>%{y:.0f} m<extra></extra>`,
        showlegend: false,
        legendgroup: key,
      });
    }

    add("UAS", 2.6, "solid");
    add("HRRR", 1.8, "dash");
    add("A", 1.9, "solid");
    add("B", 2.0, "solid");
    add("C", 1.9, "solid");

    const layout = {
      title: { text: opts.title || "", font: { color: "#e2e8f0", size: 11 }, x: 0.02, xanchor: "left" },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(15,23,42,0.35)",
      xaxis: {
        title: { text: "Speed (m s⁻¹)", font: { size: 10 } },
        color: "#94a3b8",
        gridcolor: "#334155",
        tickfont: { size: 9 },
        domain: [0, 0.46],
        rangemode: "tozero",
      },
      xaxis2: {
        title: { text: "Direction (° from)", font: { size: 10 } },
        color: "#94a3b8",
        gridcolor: "#334155",
        tickfont: { size: 9 },
        domain: [0.54, 1],
        range: [0, 360],
        dtick: 90,
        anchor: "y2",
      },
      yaxis: {
        title: { text: "AGL m", font: { size: 10 } },
        color: "#94a3b8",
        gridcolor: "#334155",
        tickfont: { size: 9 },
        range: [zMin, zMax],
      },
      yaxis2: {
        color: "#94a3b8",
        gridcolor: "#334155",
        tickfont: { size: 9 },
        range: [zMin, zMax],
        anchor: "x2",
        showticklabels: false,
      },
      margin: { l: 48, r: 12, t: 28, b: 42 },
      legend: {
        font: { color: "#e2e8f0", size: 9 },
        bgcolor: "rgba(0,0,0,0)",
        orientation: "h",
        y: 1.12,
        x: 0,
      },
      showlegend: traces.some((tr) => tr.showlegend !== false && tr.name),
    };

    if (!traces.length) {
      layout.annotations = [
        {
          text: opts.emptyText || "No wind profile at this time",
          xref: "paper",
          yref: "paper",
          x: 0.5,
          y: 0.5,
          showarrow: false,
          font: { color: "#94a3b8" },
        },
      ];
      layout.xaxis.visible = false;
      layout.xaxis2 = { visible: false };
      layout.yaxis.visible = false;
    }

    Plotly.react(elId, traces, layout, { responsive: true, displayModeBar: false });
  }

  global.SoundingPlotter = {
    renderSounding,
    renderHodograph,
    renderTimeSeries,
    renderCrossSection,
    renderSkewT,
    renderWindProfile,
    valueAtHeight,
    dewpointC,
    pressureHpa,
    DEFAULT_PALETTE,
    SOURCE_LABELS,
  };
})(window);
