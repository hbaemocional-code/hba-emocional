/* static/js/main.js  (REEMPLAZAR COMPLETO)
   Mantiene:
   - fetch a /api/compute y /api/save (sin cambios)
   - Polar BLE (sin cambios de lógica)
   Cambia SOLO “caño” de cámara PPG:
   1) ROI 50x50 centro, canal ROJO
   2) Feedback por amplitud y cambios bruscos de luz
   3) 30 FPS constantes con requestAnimationFrame (scheduler fijo)
   4) Detrending básico + normalización antes de enviar al backend
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
let torchAvailable = false;
let torchEnabled = false;

// Polar H10 BLE
let bleDevice = null;
let bleChar = null;
let rrIntervalsMs = [];
let lastMetrics = null;

// Chart.js
let chart = null;

/* =========================
   UI helpers
========================= */
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
  document.getElementById("btnStart").disabled = measuring;
  document.getElementById("btnStop").disabled = !measuring;
  document.getElementById("btnSave").disabled = measuring || !lastMetrics || !!lastMetrics.error;
}

/* =========================
   Calidad
========================= */
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

/* =========================
   Chart ECG (estético)
========================= */
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
    data: { labels: [], datasets: [{
      label: "Señal",
      data: [],
      pointRadius: 0,
      borderWidth: 3,
      tension: 0.18,
      borderColor: "#ff2b2b"
    }]},
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
  const maxPoints = 320;
  chart.data.labels.push("");
  chart.data.datasets[0].data.push(value);
  if(chart.data.labels.length > maxPoints){
    chart.data.labels.shift();
    chart.data.datasets[0].data.shift();
  }
  chart.update("none");
}

function setupDurationButtons(){
  const b3 = document.getElementById("dur3");
  const b5 = document.getElementById("dur5");
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
  sel.addEventListener("change", () => {
    sensorType = sel.value;
    setSensorChip();
    setStatus("Listo", "idle");
  });
}

function buildCards(metrics){
  const cards = document.getElementById("cards");
  const freqHint = document.getElementById("freqHint");
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
    c.innerHTML = `<div class="k">Error</div><div class="v">${metrics.error}</div><div class="u">Revisá señal / dedo / luz</div>`;
    cards.appendChild(c);
    return;
  }

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
    const val = isNum ? num.toFixed(it.k.startsWith("HR") ? 0 : 3) : "—";

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

/* ==========================================================
   Cámara helpers: permisos / torch
========================================================== */
function explainCameraPermissionError(e){
  const name = e?.name || "";
  if(name === "NotAllowedError" || name === "PermissionDeniedError"){
    return "Permiso de cámara denegado. Tocá el candado (🔒) en Chrome → Permitir Cámara, y recargá.";
  }
  if(name === "NotReadableError" || name === "TrackStartError"){
    return "La cámara está ocupada o bloqueada. Cerrá otras apps que usen cámara y reintentá.";
  }
  if(name === "NotFoundError"){
    return "No se encontró cámara en este dispositivo.";
  }
  return `Error cámara: ${e?.message || String(e)}`;
}

async function enableTorch(track, on){
  if(!track?.getCapabilities) return false;
  const caps = track.getCapabilities();
  if(!caps || !("torch" in caps)) return false;
  try{
    await track.applyConstraints({ advanced: [{ torch: !!on }] });
    return true;
  }catch(_e){
    return false;
  }
}

function getTorchWanted(){
  const t = document.getElementById("torchToggle");
  return t ? !!t.checked : true; // default auto ON
}

function setTorchLabel(text){
  const lbl = document.getElementById("torchLabel");
  if(lbl) lbl.textContent = text;
}

/* ==========================================================
   CÁMARA PPG REGLAS:
   1) ROI 50x50 centro, canal ROJO
   2) Feedback por amplitud y cambios bruscos de luz
   3) 30 FPS estables con requestAnimationFrame (scheduler fijo)
   4) Detrending antes de enviar
========================================================== */
function meanRedROI(img){
  // img = Uint8ClampedArray RGBA 50x50
  let sum = 0;
  for(let i=0; i<img.length; i+=4) sum += img[i];
  return sum / (img.length / 4);
}

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
        frameRate: { ideal: 30, min: 30, max: 30 },
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

  // esperar frames
  const t0 = Date.now();
  while ((videoEl.videoWidth === 0 || videoEl.videoHeight === 0) && (Date.now() - t0 < 4000)) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
    throw new Error("Cámara autorizada pero sin frames. Recargá y revisá permisos.");
  }

  const track = mediaStream.getVideoTracks()[0];

  // ROI EXACTO 50x50
  const roiW = 50, roiH = 50;
  frameCanvas.width = roiW;
  frameCanvas.height = roiH;

  // Torch
  torchAvailable = false;
  torchEnabled = false;
  if(track?.getCapabilities){
    const caps = track.getCapabilities();
    torchAvailable = !!(caps && ("torch" in caps));
  }

  const wantTorch = getTorchWanted();
  if(torchAvailable && wantTorch){
    torchEnabled = await enableTorch(track, true);
    setTorchLabel(torchEnabled ? "ON" : "Bloq.");
  } else if(torchAvailable && !wantTorch){
    torchEnabled = await enableTorch(track, false);
    setTorchLabel("OFF");
  } else {
    setTorchLabel("N/A");
  }

  setStatus(torchEnabled ? "Cámara activa • Flash ON • PPG (ROJO)" : "Cámara activa • PPG (ROJO)", torchEnabled ? "ok" : "warn");

  // Señal: trabajamos con el nivel de rojo y sacamos AC
  let baseline = null;
  const alpha = 0.02;

  // Buffers para feedback de usuario (últimos ~2s)
  const ampWindowSec = 2.0;
  const ampBuf = [];
  const lightBuf = [];

  // Scheduler 30fps fijo con rAF
  const framePeriod = 1000 / 30;
  let lastTick = performance.now();
  let acc = 0;

  // thresholds (ajustados a finger+flash)
  const AMP_LOW = 0.0012;   // amplitud muy chica -> “presioná más firmeza”
  const LIGHT_JUMP = 7.0;   // salto en meanR (0-255) -> “quieto”
  const SAT_HIGH = 245;     // saturación por flash
  const DARK_LOW = 20;      // muy oscuro

  let lastMeanR = null;
  let lastMsgAt = 0;

  const loop = (now) => {
    if(!measuring) return;

    acc += (now - lastTick);
    lastTick = now;

    // procesar a 30fps “cuasi-constantes”
    // (si hay backlog, procesamos máx 2 frames para no quemar CPU)
    let steps = 0;
    while(acc >= framePeriod && steps < 2){
      acc -= framePeriod;
      steps++;

      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;

      // ROI centro del video (50x50). Dibujamos SOLO esa región al canvas 50x50.
      const sx = (vw / 2) - (roiW / 2);
      const sy = (vh / 2) - (roiH / 2);

      frameCtx.drawImage(videoEl, sx, sy, roiW, roiH, 0, 0, roiW, roiH);
      const img = frameCtx.getImageData(0, 0, roiW, roiH).data;
      const meanR = meanRedROI(img);

      // feedback por luz (saltos bruscos)
      if(lastMeanR != null){
        const dL = Math.abs(meanR - lastMeanR);
        lightBuf.push(dL);
        if(lightBuf.length > Math.round(ampWindowSec * 30)) lightBuf.shift();
      }
      lastMeanR = meanR;

      // Si está quemando u oscuro, avisar y NO acumular basura
      if(meanR >= SAT_HIGH){
        setQuality(10);
        if(now - lastMsgAt > 900){
          lastMsgAt = now;
          setStatus("Flash quema la señal • desactivá Flash o aflojá presión", "warn");
        }
        continue;
      }
      if(meanR <= DARK_LOW){
        setQuality(5);
        if(now - lastMsgAt > 900){
          lastMsgAt = now;
          setStatus(torchAvailable ? "Muy oscuro • el dedo no cubre lente+flash" : "Muy oscuro • sin flash PPG suele fallar", "warn");
        }
        continue;
      }

      // AC extraction (quita deriva lenta)
      if(baseline === null) baseline = meanR;
      baseline = (1 - alpha) * baseline + alpha * meanR;

      const ac = meanR - baseline;
      const normalized = (baseline !== 0) ? (ac / baseline) : 0;

      // guardado crudo (normalizado “semi-plano”)
      ppgSamples.push(normalized);
      ppgTimestamps.push(performance.now());

      // estética ECG (amplificación visual)
      pushChartPoint(ac * 60);

      // amplitud (peak-to-peak) sobre ventana
      ampBuf.push(normalized);
      const maxLen = Math.round(ampWindowSec * 30);
      if(ampBuf.length > maxLen) ampBuf.shift();

      if(ampBuf.length >= Math.round(1.2 * 30)){
        let mn = Infinity, mx = -Infinity;
        for(const v of ampBuf){ if(v < mn) mn = v; if(v > mx) mx = v; }
        const p2p = mx - mn;

        // detectar cambios bruscos de luz
        const lightMax = lightBuf.length ? Math.max(...lightBuf) : 0;
        const lightBad = lightMax > LIGHT_JUMP;

        // score simple: amplitud buena y luz estable
        let score = 0;
        score += Math.min(70, (p2p / (AMP_LOW * 6)) * 70); // escala por amplitud
        if(!lightBad) score += 30;
        score = Math.max(0, Math.min(100, score));
        setQuality(score);

        // feedback textual (prioridades)
        if(now - lastMsgAt > 850){
          lastMsgAt = now;

          if(lightBad){
            setStatus("Cambios de luz detectados • mantené el dedo quieto", "warn");
          } else if(p2p < AMP_LOW){
            setStatus("Amplitud baja • presioná el dedo con más firmeza (sin aplastar)", "warn");
          } else if(score >= 70){
            setStatus(torchEnabled ? "Señal alta • excelente (Flash ON)" : "Señal alta • excelente", "ok");
          } else {
            setStatus("Señal media • mantené estable", "ok");
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

  // apagar torch
  try{
    const track = mediaStream?.getVideoTracks?.()[0];
    if(track && torchAvailable){
      await enableTorch(track, false);
    }
  }catch(_e){}

  if(mediaStream){
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }

  torchAvailable = false;
  torchEnabled = false;

  setQuality(null);
  setStatus("Cámara detenida", "idle");
}

/* ==========================
   Detrending (JS) antes de enviar
   - Sustrae media móvil (high-pass básico)
   - Normaliza z-score (mejor para NeuroKit2)
========================== */
function detrendMovingAverage(x, fs, winSec = 1.5){
  const n = x.length;
  if(n < 10) return x.slice();

  const w = Math.max(3, Math.floor(fs * winSec));
  const half = Math.floor(w / 2);

  // prefix sums para media móvil eficiente
  const pref = new Array(n + 1);
  pref[0] = 0;
  for(let i=0;i<n;i++) pref[i+1] = pref[i] + x[i];

  const y = new Array(n);
  for(let i=0;i<n;i++){
    const a = Math.max(0, i - half);
    const b = Math.min(n - 1, i + half);
    const mean = (pref[b+1] - pref[a]) / (b - a + 1);
    y[i] = x[i] - mean;
  }
  return y;
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

/* ----------------------------
   Polar H10 BLE (SIN CAMBIOS)
---------------------------- */
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

/* ----------------------------
   Medición: start/stop/compute/save
   (ENDPOINTS SIN CAMBIOS)
---------------------------- */
async function startMeasurement(){
  lastMetrics = null;
  buildCards(null);

  measuring = true;
  startedAt = Date.now();
  enableControls();
  setSensorChip();

  chart.data.labels = [];
  chart.data.datasets[0].data = [];
  chart.update("none");

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

  let payload = {
    sensor_type: sensorType,
    duration_minutes: selectedDurationMin
  };

  if(sensorType === "camera_ppg"){
    // fs estimado real por timestamps
    let fs = targetFps;
    if(ppgTimestamps.length > 10){
      const diffs = [];
      for(let i=1; i<ppgTimestamps.length; i++){
        diffs.push((ppgTimestamps[i] - ppgTimestamps[i-1]) / 1000.0);
      }
      const meanDt = diffs.reduce((a,b)=>a+b,0) / diffs.length;
      if(meanDt > 0) fs = 1.0 / meanDt;
    }

    // ✅ detrend + zscore antes de enviar a NeuroKit2
    let cleaned = detrendMovingAverage(ppgSamples, fs, 1.5);
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

/* ----------------------------
   Init
---------------------------- */
window.addEventListener("DOMContentLoaded", () => {
  initChart();
  setupDurationButtons();
  setupSensorSelector();
  setSensorChip();
  enableControls();
  buildCards(null);
  setQuality(null);
  setTimerText();
  setStatus("Listo", "idle");

  // toggle torch label init
  const t = document.getElementById("torchToggle");
  if(t){
    setTorchLabel(t.checked ? "Auto" : "OFF");
    t.addEventListener("change", () => {
      setTorchLabel(t.checked ? "Auto" : "OFF");
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
