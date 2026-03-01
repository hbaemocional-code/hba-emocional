/* static/js/main.js (REEMPLAZAR COMPLETO)
   Mantiene:
   - /api/compute y /api/save
   - Polar BLE
   - PPG PRO (AC-only + ROI + torch auto + calidad)
   Agrega:
   - Render del Dashboard HBA usando tu CSS (dashGrid, dashTile, cards, card good/warn/bad)
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

/* ========================= Chart ========================= */
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
  const ctx = document.getElementById("signalChart");
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
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

/* ========================= Dashboard HBA render ========================= */
function clsFromState(state){
  const s = (state || "").toLowerCase();
  if(s === "alto") return "good";
  if(s === "medio") return "warn";
  if(s === "bajo") return "bad";
  return "";
}

function fmtNum(v, decimals=2){
  const n = (typeof v === "number") ? v : Number(v);
  return Number.isFinite(n) ? n.toFixed(decimals) : "—";
}

function clearDash(){
  const dashGrid = document.getElementById("dashGrid");
  const cards = document.getElementById("cards");
  const meaning = document.getElementById("meaningCards");
  const norms = document.getElementById("normsCards");
  const sem = document.getElementById("semaforoCards");

  if(dashGrid) dashGrid.innerHTML = "";
  if(cards) cards.innerHTML = `<div class="hint">Aún no hay métricas calculadas..</div>`;
  if(meaning) meaning.innerHTML = "";
  if(norms) norms.innerHTML = "";
  if(sem) sem.innerHTML = "";
}

function buildDashTiles(metrics){
  const dashGrid = document.getElementById("dashGrid");
  if(!dashGrid) return;
  dashGrid.innerHTML = "";

  if(!metrics || metrics.error){
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = "Aún no hay métricas calculadas..";
    dashGrid.appendChild(h);
    return;
  }

  const hba = metrics.hba_dashboard;
  if(!hba){
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = "No hay dashboard HBA en la respuesta del backend.";
    dashGrid.appendChild(h);
    return;
  }

  // buscar biomarcadores clave
  const bm = Array.isArray(hba.biomarkers) ? hba.biomarkers : [];
  const pick = (name) => bm.find(x => (x.name || "").toLowerCase() === name.toLowerCase());

  const rm = pick("HRV (RMSSD)");
  const si = pick("Índice de estrés Baevsky");
  const sc = pick("Score autonómico");
  const st = pick("Estrés");
  const fp = pick("Fatiga física");
  const fe = pick("Fatiga emocional");

  const tiles = [
    { title: "HRV (RMSSD)", badge: rm?.state, main: `${fmtNum(rm?.value, 1)} ms`, a: "Estado", av: (rm?.state || "—"), b: "Ref", bv: (rm?.detail || "—"), c: "Modo", cv: (metrics.hrv_mode || "—") },
    { title: "Carga autonómica", badge: sc?.state, main: `${fmtNum(sc?.value, 0)}/100`, a: "Estrés", av: (st?.state || "—"), b: "Baevsky", bv: fmtNum(si?.value, 0), c: "LF/HF", cv: fmtNum(metrics.lf_hf, 2) },
    { title: "Fatiga", badge: (fp?.state || fe?.state), main: "Física / Emocional", a: "Física", av: `${fmtNum(fp?.value, 0)}/100`, b: "Emocional", bv: `${fmtNum(fe?.value, 0)}/100`, c: "FC media", cv: `${fmtNum(metrics.hr_mean, 0)} bpm` },
  ];

  tiles.forEach(t => {
    const badgeState = (t.badge || "").toLowerCase();
    const badgeCls = badgeState === "alto" ? "warn" : (badgeState === "bajo" ? "ok" : "warn");
    // Nota: tu CSS tiene .tileBadge.ok y .tileBadge.warn (no hay bad), usamos ok/warn.
    const badgeText = (t.badge || "—").toUpperCase();

    const el = document.createElement("div");
    el.className = "dashTile glass neon";

    el.innerHTML = `
      <div class="tileTop">
        <div class="tileName">${t.title}</div>
        <div class="tileBadge ${badgeCls}">${badgeText}</div>
      </div>

      <div class="tileMid">
        <div class="miniStat"><span>${t.a}</span><strong>${t.av}</strong></div>
        <div class="miniStat"><span>${t.b}</span><strong>${t.bv}</strong></div>
        <div class="miniStat"><span>${t.c}</span><strong>${t.cv}</strong></div>
      </div>

      <div class="tileBar"><span class="tileBarFill"></span></div>
    `;
    dashGrid.appendChild(el);
  });
}

function buildBiomarkerCards(metrics){
  const cards = document.getElementById("cards");
  const freqHint = document.getElementById("freqHint");
  if(!cards || !freqHint) return;

  cards.innerHTML = "";
  freqHint.textContent = "";

  if(!metrics){
    cards.innerHTML = `<div class="hint">Aún no hay métricas calculadas..</div>`;
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

  const hba = metrics.hba_dashboard;
  if(!hba || !Array.isArray(hba.biomarkers)){
    // fallback: mostrar tus métricas clásicas si no viene HBA
    const items = [
      {k:"HR Media", v: metrics.hr_mean, u:"bpm"},
      {k:"HR Máx", v: metrics.hr_max, u:"bpm"},
      {k:"HR Mín", v: metrics.hr_min, u:"bpm"},
      {k:"RMSSD", v: metrics.rmssd, u:"ms"},
      {k:"SDNN", v: metrics.sdnn, u:"ms"},
      {k:"lnRMSSD", v: metrics.lnrmssd, u:"ln(ms)"},
      {k:"pNN50", v: metrics.pnn50, u:"%"},
      {k:"Mean RR", v: metrics.mean_rr, u:"ms"},
      {k:"LF Power", v: metrics.lf_power, u:"ms²"},
      {k:"HF Power", v: metrics.hf_power, u:"ms²"},
      {k:"LF/HF", v: metrics.lf_hf, u:"ratio"},
      {k:"Total Power", v: metrics.total_power, u:"ms²"},
      {k:"Artefactos", v: metrics.artifact_percent, u:"%"},
    ];

    items.forEach(it => {
      const num = typeof it.v === "number" ? it.v : Number(it.v);
      const isNum = Number.isFinite(num);
      const val = isNum ? num.toFixed(it.k.startsWith("HR") ? 0 : 2) : "—";

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

    return;
  }

  // HBA cards
  hba.biomarkers.forEach(b => {
    const cls = clsFromState(b.state);
    const c = document.createElement("div");
    c.className = `card ${cls}`.trim();

    const unit = b.unit || "";
    const v = (typeof b.value === "number" || Number.isFinite(Number(b.value)))
      ? (unit === "bpm" ? fmtNum(b.value, 0) : fmtNum(b.value, 2))
      : "—";

    const stateText = b.state ? `Estado: ${String(b.state).toUpperCase()}` : "Estado: —";
    const detail = b.detail ? ` • ${b.detail}` : "";

    c.innerHTML = `
      <div class="k">${b.name}</div>
      <div class="v">${v}${unit ? " " + unit : ""}</div>
      <div class="u">${stateText}${detail}</div>
    `;
    cards.appendChild(c);
  });
}

function buildMeaningCards(metrics){
  const meaning = document.getElementById("meaningCards");
  if(!meaning) return;
  meaning.innerHTML = "";

  const hba = metrics?.hba_dashboard;
  const arr = Array.isArray(hba?.interpretation) ? hba.interpretation : [];

  if(!arr.length){
    meaning.innerHTML = `<div class="hint">Sin datos de interpretación.</div>`;
    return;
  }

  arr.forEach(x => {
    const c = document.createElement("div");
    c.className = "card";
    c.innerHTML = `<div class="k">${x.biomarker || "Biomarcador"}</div><div class="v">—</div><div class="u">${x.meaning || ""}</div>`;
    meaning.appendChild(c);
  });
}

function buildNormsCards(metrics){
  const norms = document.getElementById("normsCards");
  if(!norms) return;
  norms.innerHTML = "";

  const hba = metrics?.hba_dashboard;
  const n = hba?.norms;
  if(!n){
    norms.innerHTML = `<div class="hint">Sin datos de normas por edad.</div>`;
    return;
  }

  const cls = clsFromState(n.rmssd_state);
  const c = document.createElement("div");
  c.className = `card ${cls}`.trim();

  c.innerHTML = `
    <div class="k">Referencia RMSSD</div>
    <div class="v">${fmtNum(n.rmssd_low,0)}–${fmtNum(n.rmssd_high,0)} ms</div>
    <div class="u">Edad: ${n.age ?? "—"} • Sexo: ${n.sex ?? "—"} • Estado: ${(n.rmssd_state || "—").toUpperCase()}</div>
  `;
  norms.appendChild(c);
}

function buildSemaforoCards(metrics){
  const sem = document.getElementById("semaforoCards");
  if(!sem) return;
  sem.innerHTML = "";

  const hba = metrics?.hba_dashboard;
  const s = hba?.semaphore;
  if(!s){
    sem.innerHTML = `<div class="hint">Sin datos de semáforo.</div>`;
    return;
  }

  const color = (s.color || "gris").toLowerCase();
  let cls = "";
  if(color === "verde") cls = "good";
  else if(color === "amarillo") cls = "warn";
  else if(color === "rojo") cls = "bad";

  const plan = Array.isArray(s.plan) ? s.plan : [];
  const lines = plan.map(p => `• ${p.pct}% ${p.item}`).join("<br>");

  const c = document.createElement("div");
  c.className = `card ${cls}`.trim();
  c.innerHTML = `
    <div class="k">Semáforo</div>
    <div class="v">${color.toUpperCase()}</div>
    <div class="u">${lines || "—"}</div>
  `;
  sem.appendChild(c);

  // diferenciador
  const d = hba?.differentiator?.what_distinguishes;
  if(d){
    const c2 = document.createElement("div");
    c2.className = "card";
    c2.innerHTML = `<div class="k">¿Qué te distingue?</div><div class="v">—</div><div class="u">${d}</div>`;
    sem.appendChild(c2);
  }
}

function renderAll(metrics){
  buildDashTiles(metrics);
  buildBiomarkerCards(metrics);
  buildMeaningCards(metrics);
  buildNormsCards(metrics);
  buildSemaforoCards(metrics);
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
   Camera PPG (PRO)
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
  clearDash();

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
    // si después agregás sexo en UI, mandalo acá:
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

    renderAll(metrics);

    if(metrics.error){
      setStatus("Error en cálculo (ver panel)", "bad");
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
    renderAll(lastMetrics);
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
  clearDash();
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
  } else {
    // si no existe, no pasa nada
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
