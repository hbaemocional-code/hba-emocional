/* static/js/main.js  (REEMPLAZAR COMPLETO)
   Mantiene:
   - /api/compute y /api/save
   - Polar BLE
   - Cámara PPG (AC-only + rAF scheduler)
   Agrega (SIN ROMPER UI):
   - Dashboard tiles
   - Cuadro de Biomarcadores (alto/medio/bajo)
   - Significados
   - Normas por edad
   - Semáforo HBA (tu diferenciador)
*/

let selectedDurationMin = 3;
let measuring = false;
let sensorType = "camera_ppg";

let timerInterval = null;
let startedAt = null;

// Cámara PPG
let mediaStream = null;
let videoEl = null;
let frameCanvas = null;
let frameCtx = null;

let ppgSamples = [];
let ppgTimestamps = [];

let targetFps = 30;
let rafId = null;

// Torch
let trackRef = null;
let torchAvailable = false;
let torchEnabled = false;
let torchMode = "auto"; // "auto" | "off"

// Polar H10 BLE
let bleDevice = null;
let bleChar = null;
let rrIntervalsMs = [];
let lastMetrics = null;

// Chart.js
let chart = null;

/* ========================= UI helpers ========================= */
function setStatus(text, level="idle"){
  const dot = document.getElementById("statusDot");
  const label = document.getElementById("statusText");
  if(!dot || !label) return;

  label.textContent = text;

  if(level === "ok"){
    dot.style.background = "var(--ok)";
    dot.style.boxShadow = "0 0 0 4px rgba(52,211,153,0.16)";
  } else if(level === "warn"){
    dot.style.background = "var(--warn)";
    dot.style.boxShadow = "0 0 0 4px rgba(251,191,36,0.16)";
  } else if(level === "bad"){
    dot.style.background = "var(--bad)";
    dot.style.boxShadow = "0 0 0 4px rgba(251,113,133,0.16)";
  } else {
    dot.style.background = "var(--muted)";
    dot.style.boxShadow = "0 0 0 4px rgba(149,163,183,0.12)";
  }
}

function fmtTime(sec){
  const m = String(Math.floor(sec/60)).padStart(2,"0");
  const s = String(sec%60).padStart(2,"0");
  return `${m}:${s}`;
}

function setTimerText(){
  const chipTimer = document.getElementById("chipTimer");
  if(!chipTimer) return;
  if(!measuring || !startedAt){
    chipTimer.textContent = "00:00";
    return;
  }
  const elapsedSec = Math.floor((Date.now() - startedAt)/1000);
  chipTimer.textContent = fmtTime(elapsedSec);
}

function setSensorChip(){
  const chip = document.getElementById("chipSensor");
  if(!chip) return;
  chip.textContent = sensorType === "polar_h10" ? "Sensor: Polar H10 (BLE)" : "Sensor: Cámara (PPG)";
}

function enableControls(){
  const s = document.getElementById("btnStart");
  const t = document.getElementById("btnStop");
  const v = document.getElementById("btnSave");
  if(s) s.disabled = measuring;
  if(t) t.disabled = !measuring;
  if(v) v.disabled = measuring || !lastMetrics || !!lastMetrics.error;
}

/* ========================= Calidad ========================= */
function setQuality(score){
  const fill = document.getElementById("qualityFill");
  const txt = document.getElementById("qualityText");
  if(!fill || !txt) return;

  if(score == null || !Number.isFinite(score)){
    fill.style.width = "0%";
    txt.textContent = "—";
    return;
  }
  const s = Math.max(0, Math.min(100, score));
  fill.style.width = `${s.toFixed(0)}%`;
  if(s >= 70) txt.textContent = "Alta";
  else if(s >= 40) txt.textContent = "Media";
  else txt.textContent = "Baja";
}

/* ========================= Chart ECG ========================= */
const glowPlugin = {
  id: "ecgGlow",
  beforeDatasetDraw(chart){
    const ctx = chart.ctx;
    ctx.save();
    ctx.shadowColor = "rgba(255,43,43,0.45)";
    ctx.shadowBlur = 10;
  },
  afterDatasetDraw(chart){
    chart.ctx.restore();
  }
};

function initChart(){
  const canvas = document.getElementById("signalChart");
  if(!canvas) return;

  chart = new Chart(canvas, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "Señal",
        data: [],
        pointRadius: 0,
        borderWidth: 3,
        tension: 0.18,
        borderColor: "#ff2b2b"
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: { x: { display: false }, y: { display: false } }
    },
    plugins: [glowPlugin]
  });
}

function pushChartPoint(value){
  if(!chart) return;
  const maxPoints = 320;
  chart.data.labels.push("");
  chart.data.datasets[0].data.push(value);
  if(chart.data.labels.length > maxPoints){
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }
  chart.update("none");
}

/* ========================= UI setup ========================= */
function setupDurationButtons(){
  const b3 = document.getElementById("dur3");
  const b5 = document.getElementById("dur5");
  if(!b3 || !b5) return;

  function setActive(min){
    selectedDurationMin = min;
    b3.classList.toggle("active", min === 3);
    b5.classList.toggle("active", min === 5);
  }
  b3.addEventListener("click", () => setActive(3));
  b5.addEventListener("click", () => setActive(5));
}

function setupSensorSelector(){
  const sel = document.getElementById("sensorType");
  if(!sel) return;
  sel.addEventListener("change", () => {
    sensorType = sel.value;
    setSensorChip();
    setStatus("Listo", "idle");
  });
}

/* ========================= Cards: métricas base ========================= */
function buildCards(metrics){
  const cards = document.getElementById("cards");
  const freqHint = document.getElementById("freqHint");
  if(!cards || !freqHint) return;

  cards.innerHTML = "";
  freqHint.textContent = "";

  if(!metrics){
    const empty = document.createElement("div");
    empty.className = "hint";
    empty.textContent = "Aún no hay métricas calculadas.";
    cards.appendChild(empty);
    return;
  }

  if(metrics.freq_warning) freqHint.textContent = metrics.freq_warning;

  if(metrics.error){
    const c = document.createElement("div");
    c.className = "card bad";
    c.innerHTML = `<div class="k">Error</div><div class="v">${metrics.error}</div><div class="u">Revisá señal / iluminación</div>`;
    cards.appendChild(c);
    return;
  }

  const items = [
    {k:"HR Media", v: metrics.hr_mean, u:"bpm"},
    {k:"HR Máx", v: metrics.hr_max, u:"bpm"},
    {k:"HR Mín", v: metrics.hr_min, u:"bpm"},
    {k:"HRV (RMSSD)", v: metrics.rmssd, u:"ms"},
    {k:"SDNN", v: metrics.sdnn, u:"ms"},
    {k:"lnRMSSD", v: metrics.lnrmssd, u:""},
    {k:"pNN50", v: metrics.pnn50, u:"%"},
    {k:"Mean RR", v: metrics.mean_rr, u:"ms"},
    {k:"LF Power", v: metrics.lf_power, u:"ms²"},
    {k:"HF Power", v: metrics.hf_power, u:"ms²"},
    {k:"LF/HF", v: metrics.lf_hf, u:"ratio"},
    {k:"Total Power", v: metrics.total_power, u:"ms²"},
    {k:"Artefactos", v: metrics.artifact_percent, u:"%"},
    {k:"Resp (estim.)", v: metrics.resp_rate_rpm, u:"rpm"},
  ];

  items.forEach(it => {
    const num = typeof it.v === "number" ? it.v : Number(it.v);
    const isNum = Number.isFinite(num);
    const val =
      !isNum ? "—" :
      (it.k.startsWith("HR ") ? num.toFixed(0) :
      (it.k === "Artefactos" ? num.toFixed(1) :
      (it.k === "Resp (estim.)" ? num.toFixed(1) : num.toFixed(3))));

    let cls = "card";
    if(it.k === "Artefactos" && isNum){
      if(num <= 8) cls += " good";
      else if(num <= 18) cls += " warn";
      else cls += " bad";
    }

    const c = document.createElement("div");
    c.className = cls;
    c.innerHTML = `<div class="k">${it.k}</div><div class="v">${val}</div><div class="u">${it.u}</div>`;
    cards.appendChild(c);
  });
}

/* ========================= HBA Dashboard (NUEVO) ========================= */
function _stateToCardClass(state){
  const s = String(state || "").toLowerCase();
  if(s === "alto" || s === "ok" || s === "verde") return "good";
  if(s === "medio" || s === "amarillo" || s === "warn") return "warn";
  if(s === "bajo" || s === "rojo" || s === "bad") return "bad";
  return "";
}

function _fmtValue(v){
  const num = (typeof v === "number") ? v : Number(v);
  if(!Number.isFinite(num)) return "—";
  return num.toFixed(2);
}

function buildDashTiles(metrics){
  const grid = document.getElementById("dashGrid");
  if(!grid) return;
  grid.innerHTML = "";

  if(!metrics || metrics.error){
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = "Aún no hay métricas calculadas.";
    grid.appendChild(h);
    return;
  }

  const dash = metrics.hba_dashboard;
  const rm = dash?.norms?.rmssd_state || "—";
  const sem = dash?.semaphore?.color || "gris";
  const art = Number(metrics.artifact_percent);

  const hr = Number(metrics.hr_mean);
  const rmssd = Number(metrics.rmssd);

  const tile = document.createElement("div");
  tile.className = "dashTile glass neon";
  tile.innerHTML = `
    <div class="tileTop">
      <div class="tileName">Paciente</div>
      <div class="tileBadge ${art<=8 ? "ok" : (art<=18 ? "warn" : "warn")}" style="${art>18 ? "border-color: rgba(251,113,133,0.22); box-shadow: 0 0 18px rgba(251,113,133,0.10);" : ""}">
        ${metrics.error ? "Error" : "Listo"}
      </div>
    </div>

    <div class="tileMid">
      <div class="miniStat"><span>HR</span><strong>${Number.isFinite(hr) ? hr.toFixed(0) : "—"}</strong></div>
      <div class="miniStat"><span>RMSSD</span><strong>${Number.isFinite(rmssd) ? rmssd.toFixed(0) : "—"}</strong></div>
      <div class="miniStat"><span>Artef.</span><strong>${Number.isFinite(art) ? art.toFixed(0) : "—"}</strong></div>
    </div>

    <div class="miniStat" style="margin-top:2px;">
      <span>Semáforo</span>
      <strong style="text-transform:uppercase">${String(sem)}</strong>
    </div>

    <div class="miniStat">
      <span>HRV estado (edad)</span>
      <strong style="text-transform:uppercase">${String(rm)}</strong>
    </div>

    <div class="tileBar"><span class="tileBarFill" style="width:${Number.isFinite(art)? Math.max(5, Math.min(100, 100-art)) : 35}%;"></span></div>
  `;
  grid.appendChild(tile);
}

function buildHBADashboard(metrics){
  const bio = document.getElementById("bioCards");
  const meaning = document.getElementById("meaningCards");
  const norms = document.getElementById("normsCards");
  const sema = document.getElementById("semaforoCards");

  if(bio) bio.innerHTML = "";
  if(meaning) meaning.innerHTML = "";
  if(norms) norms.innerHTML = "";
  if(sema) sema.innerHTML = "";

  if(!metrics || metrics.error){
    if(bio){
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = "Aún no hay biomarcadores.";
      bio.appendChild(h);
    }
    return;
  }

  const dash = metrics.hba_dashboard;
  if(!dash){
    if(bio){
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = "Dashboard HBA no disponible (backend no lo devolvió).";
      bio.appendChild(h);
    }
    return;
  }

  // 1) Biomarcadores: card con biomarcador + valor + estado + detalle
  const list = Array.isArray(dash.biomarkers) ? dash.biomarkers : [];
  if(bio){
    if(!list.length){
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = "No hay biomarcadores para mostrar.";
      bio.appendChild(h);
    } else {
      list.forEach(bm => {
        const cls = _stateToCardClass(bm.state);
        const c = document.createElement("div");
        c.className = `card ${cls}`;
        const val = _fmtValue(bm.value);
        const unit = bm.unit ? String(bm.unit) : "";
        const st = bm.state ? String(bm.state).toUpperCase() : "—";
        const detail = bm.detail ? String(bm.detail) : "";

        c.innerHTML = `
          <div class="k">${bm.name}</div>
          <div class="v">${val}</div>
          <div class="u">${unit} • Estado: <b>${st}</b>${detail ? " • " + detail : ""}</div>
        `;
        bio.appendChild(c);
      });
    }
  }

  // 2) Significados
  const meanings = Array.isArray(dash.interpretation) ? dash.interpretation : [];
  if(meaning){
    if(!meanings.length){
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = "Sin definiciones.";
      meaning.appendChild(h);
    } else {
      meanings.forEach(m => {
        const c = document.createElement("div");
        c.className = "card";
        c.innerHTML = `
          <div class="k">${m.biomarker}</div>
          <div class="v" style="font-size: clamp(16px, 1.8vw, 20px);">Guía</div>
          <div class="u">${m.meaning}</div>
        `;
        meaning.appendChild(c);
      });
    }
  }

  // 3) Normas RMSSD por edad/sexo
  if(norms){
    const n = dash.norms || {};
    const low = Number(n.rmssd_low);
    const high = Number(n.rmssd_high);
    const state = String(n.rmssd_state || "—").toUpperCase();
    const age = n.age ?? "—";
    const sex = n.sex ?? "—";

    const c = document.createElement("div");
    c.className = `card ${_stateToCardClass(String(n.rmssd_state||""))}`;
    c.innerHTML = `
      <div class="k">Referencia RMSSD (edad/sexo)</div>
      <div class="v">${Number.isFinite(low) ? low.toFixed(0) : "—"} – ${Number.isFinite(high) ? high.toFixed(0) : "—"}</div>
      <div class="u">Edad: <b>${age}</b> • Sexo: <b>${sex}</b> • Estado: <b>${state}</b></div>
    `;
    norms.appendChild(c);
  }

  // 4) Semáforo HBA (plan porcentual)
  if(sema){
    const s = dash.semaphore || {};
    const color = String(s.color || "gris").toUpperCase();
    const plan = Array.isArray(s.plan) ? s.plan : [];

    const cls = _stateToCardClass(String(dash.norms?.rmssd_state || ""));
    const c = document.createElement("div");
    c.className = `card ${cls}`;
    const itemsHtml = plan.map(p => {
      const pct = Number(p.pct);
      return `<div class="u" style="margin-top:6px;">• <b>${Number.isFinite(pct) ? pct : "—"}%</b> ${p.item}</div>`;
    }).join("");

    c.innerHTML = `
      <div class="k">Semáforo HBA</div>
      <div class="v" style="text-transform:uppercase">${color}</div>
      <div class="u">Plan según RMSSD (edad/sexo):</div>
      ${itemsHtml || `<div class="u">—</div>`}
      <div class="u" style="margin-top:10px;"><b>Diferenciador:</b> ${dash.differentiator?.what_distinguishes || "Semáforo HBA"}</div>
    `;
    sema.appendChild(c);
  }
}

/* ========================= Torch helpers ========================= */
function setTorchLabel(text){
  const lbl = document.getElementById("torchLabel");
  if(lbl) lbl.textContent = text;
}
function readTorchModeFromUI(){
  const el = document.getElementById("torchToggle");
  torchMode = (el && el.checked) ? "auto" : "off";
  setTorchLabel(torchMode === "auto" ? "AUTO" : "OFF");
}

function torchCapable(track){
  try{
    const caps = track?.getCapabilities?.();
    return !!(caps && ("torch" in caps));
  }catch(_e){
    return false;
  }
}

let torchApplyInFlight = false;
let lastTorchApplyAt = 0;

function applyTorch(on){
  if(!trackRef || !torchAvailable) return;
  const now = Date.now();
  if(torchApplyInFlight) return;
  if(now - lastTorchApplyAt < 600) return;
  torchApplyInFlight = true;
  lastTorchApplyAt = now;

  trackRef.applyConstraints({ advanced: [{ torch: !!on }] })
    .then(() => { torchEnabled = !!on; })
    .catch(() => {})
    .finally(() => { torchApplyInFlight = false; });
}

/* ========================= Camera errors ========================= */
function explainCameraPermissionError(e){
  const name = e?.name || "";
  if(name === "NotAllowedError" || name === "PermissionDeniedError"){
    return "Permiso de cámara denegado. Candado (🔒) → Permitir Cámara → recargar.";
  }
  if(name === "NotReadableError" || name === "TrackStartError"){
    return "Cámara ocupada/bloqueada. Cerrá otras apps que usen cámara y reintentá.";
  }
  if(name === "NotFoundError"){
    return "No se encontró cámara en este dispositivo.";
  }
  return `Error cámara: ${e?.message || String(e)}`;
}

/* ========================= ROI red ========================= */
function meanRedROI(img){
  let sum = 0;
  for(let i=0; i<img.length; i+=4) sum += img[i];
  return sum / (img.length / 4);
}

/* ========================= Robust preprocesado ========================= */
function replaceNonFinite(x){
  const y = new Array(x.length);
  let last = 0;
  for(let i=0;i<x.length;i++){
    const v = x[i];
    if(Number.isFinite(v)){
      last = v;
      y[i] = v;
    } else {
      y[i] = last;
    }
  }
  return y;
}

function clampByMAD(x, k=8.0){
  const n = x.length;
  if(n < 20) return x.slice();

  const sorted = x.slice().sort((a,b)=>a-b);
  const median = sorted[Math.floor(n/2)];
  const absDev = x.map(v => Math.abs(v - median)).sort((a,b)=>a-b);
  const mad = absDev[Math.floor(n/2)] || 1e-6;

  const lo = median - k*mad;
  const hi = median + k*mad;

  return x.map(v => Math.min(hi, Math.max(lo, v)));
}

function movingAverage(x, w){
  const n = x.length;
  if(n === 0) return [];
  const ww = Math.max(3, w|0);
  const half = Math.floor(ww/2);

  const pref = new Array(n+1);
  pref[0]=0;
  for(let i=0;i<n;i++) pref[i+1]=pref[i]+x[i];

  const y = new Array(n);
  for(let i=0;i<n;i++){
    const a = Math.max(0, i-half);
    const b = Math.min(n-1, i+half);
    y[i]=(pref[b+1]-pref[a])/(b-a+1);
  }
  return y;
}

function detrendMovingAverage(x, fs, winSec = 1.5){
  const n = x.length;
  if(n < 20) return x.slice();
  const w = Math.max(5, Math.floor(fs * winSec));
  const trend = movingAverage(x, w);
  const y = new Array(n);
  for(let i=0;i<n;i++) y[i]=x[i]-trend[i];
  return y;
}

function iirHighPass(x, fs, cutoffHz){
  const dt = 1 / fs;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = rc / (rc + dt);
  const y = new Array(x.length);
  y[0] = 0;
  for(let i=1;i<x.length;i++){
    y[i] = alpha * (y[i-1] + x[i] - x[i-1]);
  }
  return y;
}

function iirLowPass(x, fs, cutoffHz){
  const dt = 1 / fs;
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const alpha = dt / (rc + dt);
  const y = new Array(x.length);
  y[0] = x[0];
  for(let i=1;i<x.length;i++){
    y[i] = y[i-1] + alpha * (x[i] - y[i-1]);
  }
  return y;
}

function winsorize(x, zLim = 4.5){
  const n = x.length;
  if(n < 10) return x.slice();
  let m = 0;
  for(const v of x) m += v;
  m /= n;
  let v2 = 0;
  for(const v of x) v2 += (v - m) * (v - m);
  const sd = Math.sqrt(v2 / n) || 1e-6;
  const lo = m - zLim * sd;
  const hi = m + zLim * sd;
  return x.map(v => Math.min(hi, Math.max(lo, v)));
}

function zscore(x){
  const n = x.length;
  if(n < 2) return x.slice();
  let m = 0;
  for(const v of x) m += v;
  m /= n;
  let v2 = 0;
  for(const v of x) v2 += (v - m) * (v - m);
  const sd = Math.sqrt(v2 / n) || 1e-6;
  return x.map(v => (v - m) / sd);
}

/* ==========================================================
   Camera PPG
========================================================== */
async function startCameraPPG(){
  videoEl = document.getElementById("video");
  frameCanvas = document.getElementById("frameCanvas");
  if(!videoEl || !frameCanvas) throw new Error("Faltan elementos de cámara en el DOM.");

  frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });

  ppgSamples = [];
  ppgTimestamps = [];
  setQuality(null);

  setStatus("Solicitando permiso de cámara…", "warn");

  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        frameRate: { ideal: 30, min: 24, max: 30 },
        width: { ideal: 640 },
        height: { ideal: 480 }
      },
      audio: false
    });
  }catch(e){
    throw new Error(explainCameraPermissionError(e));
  }

  videoEl.srcObject = mediaStream;
  videoEl.playsInline = true;
  videoEl.muted = true;
  try { await videoEl.play(); } catch(_e) {}

  const t0 = Date.now();
  while ((videoEl.videoWidth === 0 || videoEl.videoHeight === 0) && (Date.now() - t0 < 4000)) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
    throw new Error("Cámara autorizada pero sin frames. Revisá permisos y recargá.");
  }

  trackRef = mediaStream.getVideoTracks()[0];

  const roiW = 50, roiH = 50;
  frameCanvas.width = roiW;
  frameCanvas.height = roiH;

  torchAvailable = torchCapable(trackRef);
  torchEnabled = false;

  readTorchModeFromUI();
  if(torchAvailable){
    if(torchMode === "auto") applyTorch(true);
    else applyTorch(false);
  } else {
    setTorchLabel("N/A");
  }

  setStatus("Cámara activa • recolectando PPG", "ok");

  // ---------- estados de filtro en vivo ----------
  let baseline = null;
  const dcAlpha = 0.01;

  let hpState = 0;
  let prevNorm = null;
  const hpAlpha = 0.96;

  let lpState = 0;
  const lpAlpha = 0.18;

  const winN = Math.round(2.5 * targetFps);
  const buf = [];
  const peakTimes = [];
  let lastMsgAt = 0;

  const SAT_HIGH = 242;
  const DARK_LOW = 55;
  let satStreak = 0;
  let darkStreak = 0;

  let prev2 = 0, prev1 = 0, cur = 0;
  let lastPeakAt = 0;

  const framePeriod = 1000 / targetFps;
  let lastTick = performance.now();
  let acc = 0;

  const loop = (now) => {
    if(!measuring) return;

    acc += (now - lastTick);
    lastTick = now;

    let steps = 0;
    while(acc >= framePeriod && steps < 2){
      acc -= framePeriod;
      steps++;

      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;

      const sx = (vw / 2) - (roiW / 2);
      const sy = (vh / 2) - (roiH / 2);

      frameCtx.drawImage(videoEl, sx, sy, roiW, roiH, 0, 0, roiW, roiH);
      const img = frameCtx.getImageData(0, 0, roiW, roiH).data;
      const meanR = meanRedROI(img);

      const clipped = meanR >= SAT_HIGH;
      const tooDark = meanR <= DARK_LOW;

      if(clipped){
        satStreak++;
        darkStreak = Math.max(0, darkStreak - 1);
      } else if(tooDark){
        darkStreak++;
        satStreak = Math.max(0, satStreak - 1);
      } else {
        satStreak = Math.max(0, satStreak - 1);
        darkStreak = Math.max(0, darkStreak - 1);
      }

      if(torchAvailable && torchMode === "auto"){
        if(satStreak >= 5){
          satStreak = 0;
          if(torchEnabled) applyTorch(false);
        }
        if(darkStreak >= 5){
          darkStreak = 0;
          if(!torchEnabled) applyTorch(true);
        }
      }

      if(baseline === null) baseline = meanR;
      baseline = (1 - dcAlpha) * baseline + dcAlpha * meanR;

      let ac = meanR - baseline;
      let norm = 0;
      if(baseline > 12) norm = ac / baseline;

      if(prevNorm === null) prevNorm = norm;
      hpState = hpAlpha * (hpState + norm - prevNorm);
      prevNorm = norm;

      lpState = lpState + lpAlpha * (hpState - lpState);

      let clean = lpState;
      if(clean > 0.06) clean = 0.06;
      if(clean < -0.06) clean = -0.06;

      ppgTimestamps.push(performance.now());
      ppgSamples.push(clean);

      pushChartPoint(clean * 220);

      buf.push(clean);
      if(buf.length > winN) buf.shift();

      prev2 = prev1;
      prev1 = cur;
      cur = clean;

      const tNow = performance.now();
      const refractoryMs = 330;
      if(prev1 > prev2 && prev1 > cur && (tNow - lastPeakAt) > refractoryMs){
        let mn = Infinity, mx = -Infinity;
        for(const v of buf){ if(v < mn) mn = v; if(v > mx) mx = v; }
        const p2p = mx - mn;
        if(p2p > 0.004){
          peakTimes.push(tNow);
          lastPeakAt = tNow;
          while(peakTimes.length > 10) peakTimes.shift();
        }
      }

      if(buf.length >= Math.round(1.5 * targetFps)){
        const nowMs = Date.now();
        if(nowMs - lastMsgAt > 350){
          lastMsgAt = nowMs;

          let mn = Infinity, mx = -Infinity;
          for(const v of buf){ if(v < mn) mn = v; if(v > mx) mx = v; }
          const p2p = mx - mn;

          let stab = 0;
          if(peakTimes.length >= 5){
            const rr = [];
            for(let i=1;i<peakTimes.length;i++) rr.push(peakTimes[i]-peakTimes[i-1]);
            const m = rr.reduce((a,b)=>a+b,0)/rr.length;
            let v = 0;
            for(const x of rr) v += (x-m)*(x-m);
            const sd = Math.sqrt(v/rr.length);
            const cv = sd / (m + 1e-6);
            stab = 1 - Math.min(1, Math.max(0, (cv - 0.05) / 0.20));
          } else {
            stab = 0.15;
          }

          const ampScore = Math.max(0, Math.min(1, (p2p - 0.0035) / 0.0165));

          let lightPenalty = 1.0;
          if(clipped) lightPenalty *= 0.65;
          if(tooDark) lightPenalty *= 0.75;

          const score = 100 * lightPenalty * (0.55 * ampScore + 0.45 * stab);
          setQuality(score);

          if(clipped){
            setStatus("Flash quema • AUTO bajará luz / aflojá presión", "warn");
          } else if(tooDark){
            setStatus(torchAvailable ? "Muy oscuro • AUTO prenderá flash" : "Muy oscuro • sin flash puede fallar", "warn");
          } else if(p2p < 0.004){
            setStatus("Señal baja • apoyá firme, sin apretar de más", "warn");
          } else if(stab < 0.35){
            setStatus("Señal inestable • dedo quieto y presión constante", "warn");
          } else {
            setStatus("Señal estable • excelente", "ok");
          }
        }
      }
    }

    rafId = requestAnimationFrame(loop);
  };

  rafId = requestAnimationFrame(loop);
}

async function stopCameraPPG(){
  if(rafId){
    cancelAnimationFrame(rafId);
    rafId = null;
  }

  try{
    if(trackRef && torchAvailable){
      applyTorch(false);
    }
  }catch(_e){}

  if(mediaStream){
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  trackRef = null;
  torchAvailable = false;
  torchEnabled = false;

  setQuality(null);
  setStatus("Cámara detenida", "idle");
}

/* ========================= Polar BLE ========================= */
function parseHeartRateMeasurement(value){
  const flags = value.getUint8(0);
  const hrValue16 = (flags & 0x01) !== 0;
  const rrPresent = (flags & 0x10) !== 0;

  let index = 1;

  if(hrValue16) index += 2;
  else index += 1;

  if((flags & 0x08) !== 0) index += 2;

  const rrs = [];
  if(rrPresent){
    while(index + 1 < value.byteLength){
      const rr = value.getUint16(index, true);
      index += 2;
      const rrMs = (rr / 1024.0) * 1000.0;
      rrs.push(rrMs);
    }
  }
  return rrs;
}

async function connectPolarH10(){
  if(!navigator.bluetooth){
    throw new Error("Web Bluetooth no disponible en este navegador.");
  }

  setStatus("Buscando Polar H10…", "warn");

  bleDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: ["heart_rate"] }]
  });

  bleDevice.addEventListener("gattserverdisconnected", () => {
    setStatus("Polar desconectado", "bad");
    measuring = false;
    enableControls();
  });

  const server = await bleDevice.gatt.connect();
  const service = await server.getPrimaryService("heart_rate");
  bleChar = await service.getCharacteristic("heart_rate_measurement");

  await bleChar.startNotifications();
  bleChar.addEventListener("characteristicvaluechanged", (event) => {
    if(!measuring) return;
    const dv = event.target.value;
    const rrs = parseHeartRateMeasurement(dv);
    if(rrs.length){
      rrs.forEach(rr => {
        rrIntervalsMs.push(rr);
        pushChartPoint(rr);
      });
    }
  });

  setStatus("Polar H10 conectado • recolectando RR", "ok");
}

async function startPolarH10(){
  rrIntervalsMs = [];
  await connectPolarH10();
}

async function stopPolarH10(){
  try{ if(bleChar) await bleChar.stopNotifications(); }catch(_e){}
  try{
    if(bleDevice && bleDevice.gatt.connected){
      bleDevice.gatt.disconnect();
    }
  }catch(_e){}
  bleChar = null;
  bleDevice = null;
  setStatus("Polar detenido", "idle");
}

/* ========================= Measurement ========================= */
async function startMeasurement(){
  lastMetrics = null;

  buildCards(null);
  buildDashTiles(null);
  buildHBADashboard(null);

  measuring = true;
  startedAt = Date.now();
  enableControls();
  setSensorChip();

  if(chart){
    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.update("none");
  }

  if(timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(async () => {
    setTimerText();
    const elapsedSec = Math.floor((Date.now() - startedAt)/1000);
    if(elapsedSec >= selectedDurationMin * 60){
      await stopMeasurement();
    }
  }, 250);

  if(sensorType === "camera_ppg"){
    await startCameraPPG();
  } else {
    await startPolarH10();
  }
}

async function stopMeasurement(){
  if(!measuring) return;

  measuring = false;
  enableControls();

  if(timerInterval){
    clearInterval(timerInterval);
    timerInterval = null;
  }
  setTimerText();

  if(sensorType === "camera_ppg"){
    await stopCameraPPG();
  } else {
    await stopPolarH10();
  }

  setStatus("Procesando HRV…", "warn");

  const payload = {
    sensor_type: sensorType,
    duration_minutes: selectedDurationMin,
    // para normas por sexo si después lo agregás en UI:
    // sex: document.getElementById("sex")?.value || ""
    age: document.getElementById("age")?.value || ""
  };

  if(sensorType === "camera_ppg"){
    let fs = targetFps;
    if(ppgTimestamps.length > 10){
      const diffs = [];
      for(let i=1; i<ppgTimestamps.length; i++){
        diffs.push((ppgTimestamps[i] - ppgTimestamps[i-1]) / 1000.0);
      }
      const meanDt = diffs.reduce((a,b)=>a+b,0) / diffs.length;
      if(meanDt > 0) fs = 1.0 / meanDt;
    }

    let cleaned = replaceNonFinite(ppgSamples);
    cleaned = clampByMAD(cleaned, 10.0);
    cleaned = detrendMovingAverage(cleaned, fs, 1.8);
    cleaned = iirHighPass(cleaned, fs, 0.5);
    cleaned = iirLowPass(cleaned, fs, 4.5);
    cleaned = winsorize(cleaned, 6.0);
    cleaned = zscore(cleaned);

    payload.ppg = cleaned;
    payload.sampling_rate = fs;
  } else {
    payload.rri_ms = rrIntervalsMs;
  }

  try{
    const res = await fetch("/api/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const metrics = await res.json();
    lastMetrics = metrics;

    buildCards(metrics);
    buildDashTiles(metrics);
    buildHBADashboard(metrics);

    if(metrics.error){
      setStatus("Error en cálculo (ver tarjetas)", "bad");
    } else {
      const art = Number(metrics.artifact_percent);
      if(Number.isFinite(art)){
        if(art <= 8) setStatus("Cálculo OK • Calidad buena", "ok");
        else if(art <= 18) setStatus("Cálculo OK • Calidad moderada", "warn");
        else setStatus("Cálculo OK • Calidad baja (artefactos altos)", "bad");
      } else {
        setStatus("Cálculo OK", "ok");
      }
    }
  }catch(e){
    lastMetrics = { error: e.message || String(e) };
    buildCards(lastMetrics);
    buildDashTiles(lastMetrics);
    buildHBADashboard(lastMetrics);
    setStatus("Fallo comunicando con servidor", "bad");
  }

  enableControls();
}

async function saveResult(){
  if(!lastMetrics || lastMetrics.error){
    setStatus("No hay métricas válidas para guardar", "warn");
    return;
  }

  const studentId = document.getElementById("studentId").value;
  const age = document.getElementById("age").value;
  const comorbidities = document.getElementById("comorbidities").value;
  const notes = document.getElementById("notes").value;

  const payload = {
    student_id: studentId,
    age: age,
    comorbidities: comorbidities,
    notes: notes,
    metrics: lastMetrics
  };

  setStatus("Guardando en dataset_hba.csv…", "warn");

  try{
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const out = await res.json();
    if(out.ok){
      setStatus("Guardado OK • dataset_hba.csv actualizado", "ok");
    } else {
      setStatus("No se pudo guardar", "bad");
    }
  }catch(_e){
    setStatus("Error guardando", "bad");
  }
}

/* ========================= Init ========================= */
window.addEventListener("DOMContentLoaded", () => {
  initChart();
  setupDurationButtons();
  setupSensorSelector();
  setSensorChip();
  enableControls();
  buildCards(null);
  buildDashTiles(null);
  buildHBADashboard(null);
  setQuality(null);
  setTimerText();
  setStatus("Listo", "idle");

  const tt = document.getElementById("torchToggle");
  if(tt){
    readTorchModeFromUI();
    tt.addEventListener("change", () => {
      readTorchModeFromUI();
      if(trackRef && torchAvailable){
        if(torchMode === "off") applyTorch(false);
        else applyTorch(true);
      }
    });
  }

  document.getElementById("btnStart").addEventListener("click", async () => {
    if(measuring) return;
    try{
      await startMeasurement();
    }catch(e){
      measuring = false;
      enableControls();
      setStatus(e.message || String(e), "bad");
    }
  });

  document.getElementById("btnStop").addEventListener("click", async () => {
    await stopMeasurement();
  });

  document.getElementById("btnSave").addEventListener("click", async () => {
    await saveResult();
  });
});
