/* static/js/main.js  (REEMPLAZAR COMPLETO)
   ✅ FIX CRÍTICO: sin await dentro de requestAnimationFrame (evita que el JS no cargue)
   Mantiene:
   - fetch a /api/compute y /api/save
   - Polar H10 BLE
   Mejora:
   - PPG cámara robusto: ROI 50x50 centro, canal ROJO
   - rAF + scheduler 30fps
   - Torch adaptativo (oscuro -> ON, saturado -> OFF) con throttle y sin bloquear
   - Feedback de usuario + barra calidad
   - Preprocesado antes de enviar: detrend + bandpass + winsorize + zscore
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

// Torch / camera controls
let trackRef = null;
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
  const s = document.getElementById("btnStart");
  const t = document.getElementById("btnStop");
  const v = document.getElementById("btnSave");
  if(s) s.disabled = measuring;
  if(t) t.disabled = !measuring;
  if(v) v.disabled = measuring || !lastMetrics || !!lastMetrics.error;
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
   Chart ECG rojo (estético)
========================= */
const glowPlugin = {
  id: "ecgGlow",
  beforeDatasetDraw(chart){
    const ctx = chart.ctx;
    ctx.save();
    ctx.shadowColor = "rgba(255,43,43,0.45)";
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
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

/* =========================
   Setup UI
========================= */
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
   Torch helpers (NO bloqueantes)
========================================================== */
function getTorchWanted(){
  const el = document.getElementById("torchToggle");
  return el ? !!el.checked : true;
}
function setTorchLabel(text){
  const lbl = document.getElementById("torchLabel");
  if(lbl) lbl.textContent = text;
}

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

function torchCapable(track){
  try{
    const caps = track?.getCapabilities?.();
    return !!(caps && ("torch" in caps));
  }catch(_e){
    return false;
  }
}

// throttle constraints para no spamear el pipeline
let lastTorchApplyAt = 0;
let torchApplyInFlight = false;

function applyTorch(track, on){
  if(!track || !torchAvailable) return;
  const now = Date.now();
  if(torchApplyInFlight) return;
  if(now - lastTorchApplyAt < 800) return;

  torchApplyInFlight = true;
  lastTorchApplyAt = now;

  track.applyConstraints({ advanced: [{ torch: !!on }] })
    .then(() => { torchEnabled = !!on; })
    .catch(() => {})
    .finally(() => { torchApplyInFlight = false; });
}

/* ==========================================================
   PPG ROI 50x50 canal rojo
========================================================== */
function meanRedROI(img){
  let sum = 0;
  for(let i=0; i<img.length; i+=4) sum += img[i];
  return sum / (img.length / 4);
}

/* ==========================================================
   Preprocesado (robusto, NO “más estricto”)
========================================================== */
function detrendMovingAverage(x, fs, winSec = 1.5){
  const n = x.length;
  if(n < 20) return x.slice();

  const w = Math.max(5, Math.floor(fs * winSec));
  const half = Math.floor(w / 2);

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
   Cámara PPG (ARRANCA SIEMPRE) + rAF 30fps
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

  // ROI exacto 50x50
  const roiW = 50, roiH = 50;
  frameCanvas.width = roiW;
  frameCanvas.height = roiH;

  // torch
  torchAvailable = torchCapable(trackRef);
  torchEnabled = false;

  if(torchAvailable && getTorchWanted()){
    // no await: si falla no rompe
    applyTorch(trackRef, true);
    setTorchLabel("AUTO");
  } else if(torchAvailable) {
    applyTorch(trackRef, false);
    setTorchLabel("OFF");
  } else {
    setTorchLabel("N/A");
  }

  setStatus("Cámara activa • recolectando PPG", "ok");

  // señal: baseline EWMA
  let baseline = null;
  const alpha = 0.02;

  // buffers de calidad (2s)
  const winN = Math.round(2.0 * targetFps);
  const buf = [];
  let lastMeanR = null;
  let lastMsgAt = 0;

  // thresholds
  const SAT_HIGH = 250;    // flash quema
  const DARK_LOW = 18;     // oscuro
  const LIGHT_JUMP = 10.0; // movimiento/luz
  const AMP_LOW = 0.0010;  // amplitud baja

  let satStreak = 0;
  let darkStreak = 0;

  // scheduler 30fps con rAF
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

      // saltos de luz
      const dL = (lastMeanR == null) ? 0 : Math.abs(meanR - lastMeanR);
      lastMeanR = meanR;

      const clipped = meanR >= SAT_HIGH;
      const tooDark = meanR <= DARK_LOW;
      const lightBad = dL >= LIGHT_JUMP;

      // torch adaptativo (NO estricto: intenta mejorar en caliente)
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

      // si quema sostenido: apagar torch
      if(satStreak >= 6){
        satStreak = 0;
        if(torchAvailable && torchEnabled){
          applyTorch(trackRef, false);
          if(Date.now() - lastMsgAt > 900){
            lastMsgAt = Date.now();
            setStatus("Flash quema • apagando flash automático", "warn");
          }
        } else if(Date.now() - lastMsgAt > 900){
          lastMsgAt = Date.now();
          setStatus("Saturación • aflojá presión o reubicá dedo", "warn");
        }
      }

      // si oscuro sostenido: prender torch (solo si user permite AUTO)
      if(darkStreak >= 6){
        darkStreak = 0;
        if(torchAvailable && getTorchWanted() && !torchEnabled){
          applyTorch(trackRef, true);
          if(Date.now() - lastMsgAt > 900){
            lastMsgAt = Date.now();
            setStatus("Oscuro • encendiendo flash automático", "warn");
          }
        } else if(Date.now() - lastMsgAt > 900){
          lastMsgAt = Date.now();
          setStatus(torchAvailable ? "Muy oscuro • cubrí lente+flash" : "Muy oscuro • sin flash puede fallar", "warn");
        }
      }

      // baseline / señal
      if(baseline === null) baseline = meanR;
      baseline = (1 - alpha) * baseline + alpha * meanR;

      const ac = meanR - baseline;
      const norm = (baseline !== 0) ? (ac / baseline) : 0;

      // “inteligente”: si frame malo, no metemos basura, interpolamos suave
      const okFrame = (!clipped && !tooDark && !lightBad);

      const ts = performance.now();
      ppgTimestamps.push(ts);

      if(okFrame){
        ppgSamples.push(norm);
      } else {
        const prev = ppgSamples.length ? ppgSamples[ppgSamples.length - 1] : 0;
        ppgSamples.push(prev);
      }

      // estética ECG
      pushChartPoint(ac * 60);

      // calidad por amplitud ventana
      buf.push(norm);
      if(buf.length > winN) buf.shift();

      if(buf.length >= Math.round(1.2 * targetFps)){
        let mn = Infinity, mx = -Infinity;
        for(const v of buf){ if(v < mn) mn = v; if(v > mx) mx = v; }
        const p2p = mx - mn;

        let score = 0;
        score += Math.min(70, (p2p / (AMP_LOW * 6)) * 70);
        score += okFrame ? 30 : 10;
        score = Math.max(0, Math.min(100, score));
        setQuality(score);

        if(Date.now() - lastMsgAt > 850){
          lastMsgAt = Date.now();
          if(clipped) setStatus("Flash quema • aflojá o desactivá flash", "warn");
          else if(tooDark) setStatus(torchAvailable ? "Muy oscuro • cubrí lente+flash" : "Muy oscuro • sin flash puede fallar", "warn");
          else if(lightBad) setStatus("Movimiento/luz • mantené el dedo quieto", "warn");
          else if(p2p < AMP_LOW) setStatus("Amplitud baja • presioná un poco más firme (sin aplastar)", "warn");
          else if(score >= 70) setStatus("Señal alta • excelente", "ok");
          else setStatus("Señal media • mantené estable", "ok");
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
      applyTorch(trackRef, false);
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
---------------------------- */
async function startMeasurement(){
  lastMetrics = null;
  buildCards(null);

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

  let payload = {
    sensor_type: sensorType,
    duration_minutes: selectedDurationMin
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

    let cleaned = detrendMovingAverage(ppgSamples, fs, 1.5);
    cleaned = iirHighPass(cleaned, fs, 0.7);
    cleaned = iirLowPass(cleaned, fs, 4.0);
    cleaned = winsorize(cleaned, 4.5);
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

  const tt = document.getElementById("torchToggle");
  if(tt){
    setTorchLabel(tt.checked ? "AUTO" : "OFF");
    tt.addEventListener("change", () => {
      setTorchLabel(tt.checked ? "AUTO" : "OFF");
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
