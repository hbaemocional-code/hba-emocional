/* static/js/main.js  (REEMPLAZAR COMPLETO)
   - NO cambia: /api/compute y /api/save, nombres de funciones, ni Polar BLE.
   - Cámara PPG:
     ✅ Usa CANAL ROJO
     ✅ Intenta activar FLASH/TORCH continuo (si el dispositivo lo soporta)
     ✅ Bloqueo best-effort de foco/exposición/white balance para evitar “bombeo”
     ✅ 30fps estables: requestVideoFrameCallback si existe, fallback timer
     ✅ Baja CPU: ROI central + canvas chico + batch update del chart
     ✅ Indicador de calidad en tiempo real (barra rojo→verde)
     ✅ Envía crudo (normalizado) al backend; Python procesa
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

// Performance
let targetFps = 30;
let cameraLoopHandle = null;     // fallback timer id
let cameraRafActive = false;     // requestVideoFrameCallback loop flag
let lastFrameProcessMs = 0;

// Torch status
let torchWanted = true;
let torchAvailable = false;

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
   Calidad (barra rojo→verde)
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
   - batch update para bajar CPU
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
  const el = document.getElementById("signalChart");
  chart = new Chart(el, {
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

const chartQueue = [];
let chartFlushHandle = null;

function flushChart(){
  if(!chart) return;
  const maxPoints = 320;

  while(chartQueue.length){
    const v = chartQueue.shift();
    chart.data.labels.push("");
    chart.data.datasets[0].data.push(v);
  }

  const over = chart.data.labels.length - maxPoints;
  if(over > 0){
    chart.data.labels.splice(0, over);
    chart.data.datasets[0].data.splice(0, over);
  }
  chart.update("none");
}

// MISMA firma que tu código usa
function pushChartPoint(value){
  chartQueue.push(value);
  if(!chartFlushHandle){
    chartFlushHandle = setTimeout(() => {
      chartFlushHandle = null;
      flushChart();
    }, 66); // ~15Hz
  }
}

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

  if(metrics.freq_warning){
    freqHint.textContent = metrics.freq_warning;
  }

  if(metrics.error){
    const c = document.createElement("div");
    c.className = "card bad";
    c.innerHTML = `<div class="k">Error</div><div class="v">${metrics.error}</div><div class="u">Revisá señal / movimiento</div>`;
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
   Cámara: torch + locks (best-effort)
========================================================== */
async function enableTorch(track, on){
  if(!track || !track.getCapabilities) return false;

  const caps = track.getCapabilities();
  // En muchos Chrome Android caps.torch existe
  if(!caps || !("torch" in caps)) return false;

  try{
    await track.applyConstraints({ advanced: [{ torch: !!on }] });
    return true;
  }catch(_e){
    return false;
  }
}

async function applyCameraLocks(track){
  if(!track) return;

  const caps = track.getCapabilities ? track.getCapabilities() : null;
  const settings = track.getSettings ? track.getSettings() : null;

  const adv = [];

  // FOCO: manual cerca (finger on lens) para evitar hunting
  if(caps && caps.focusMode){
    const modes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
    if(modes.includes("manual")){
      adv.push({ focusMode: "manual" });
      if(caps.focusDistance){
        const min = caps.focusDistance.min ?? 0;
        adv.push({ focusDistance: min });
      }
    } else if(modes.includes("continuous")){
      adv.push({ focusMode: "continuous" });
    }
  }

  // EXPOSICIÓN: si torch está disponible, suele convenir mantener estable
  if(caps && caps.exposureMode){
    const modes = Array.isArray(caps.exposureMode) ? caps.exposureMode : [];
    if(modes.includes("manual")){
      adv.push({ exposureMode: "manual" });

      if(settings && typeof settings.exposureTime === "number" && caps.exposureTime){
        const v = Math.min(caps.exposureTime.max, Math.max(caps.exposureTime.min, settings.exposureTime));
        adv.push({ exposureTime: v });
      }
      if(settings && typeof settings.iso === "number" && caps.iso){
        const v = Math.min(caps.iso.max, Math.max(caps.iso.min, settings.iso));
        adv.push({ iso: v });
      }
    } else if(modes.includes("continuous")){
      adv.push({ exposureMode: "continuous" });
    }
  }

  if(caps && caps.exposureCompensation){
    const cur = (settings && typeof settings.exposureCompensation === "number") ? settings.exposureCompensation : 0;
    const v = Math.min(caps.exposureCompensation.max, Math.max(caps.exposureCompensation.min, cur));
    adv.push({ exposureCompensation: v });
  }

  // WHITE BALANCE: manual si existe, evita bombeo de color
  if(caps && caps.whiteBalanceMode){
    const modes = Array.isArray(caps.whiteBalanceMode) ? caps.whiteBalanceMode : [];
    if(modes.includes("manual")){
      adv.push({ whiteBalanceMode: "manual" });
      if(settings && typeof settings.colorTemperature === "number" && caps.colorTemperature){
        const v = Math.min(caps.colorTemperature.max, Math.max(caps.colorTemperature.min, settings.colorTemperature));
        adv.push({ colorTemperature: v });
      }
    }
  }

  if(adv.length){
    try{
      await track.applyConstraints({ advanced: adv });
    }catch(_e){
      // no romper
    }
  }
}

/* ==========================
   Cámara PPG (ROJO + FLASH)
========================== */
function computeMeanRed(imgData){
  let sumR = 0;
  for(let i=0; i<imgData.length; i+=4) sumR += imgData[i];
  return sumR / (imgData.length / 4);
}

function explainCameraPermissionError(e){
  // mensajes claros para usuarios
  const name = e?.name || "";
  const msg = e?.message || String(e);

  if(name === "NotAllowedError" || name === "PermissionDeniedError"){
    return "Permiso de cámara denegado. Tocá el candado (🔒) en la barra de Chrome → Permitir Cámara, y recargá.";
  }
  if(name === "NotFoundError" || name === "DevicesNotFoundError"){
    return "No se encontró cámara. Revisá que el dispositivo tenga cámara disponible y que no esté siendo usada por otra app.";
  }
  if(name === "NotReadableError" || name === "TrackStartError"){
    return "La cámara está ocupada o bloqueada por el sistema. Cerrá otras apps que usen cámara y reintentá.";
  }
  if(name === "OverconstrainedError"){
    return "La cámara no soporta los parámetros pedidos. Probá otro dispositivo o navegador.";
  }
  // genérico
  return `Error cámara: ${msg}`;
}

async function startCameraPPG(){
  videoEl = document.getElementById("video");
  frameCanvas = document.getElementById("frameCanvas");
  if(!videoEl || !frameCanvas) throw new Error("Faltan elementos de cámara en el DOM (video/frameCanvas).");

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

  // esperar metadata de video
  const t0 = Date.now();
  while ((videoEl.videoWidth === 0 || videoEl.videoHeight === 0) && (Date.now() - t0 < 4000)) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
    throw new Error("Cámara autorizada pero sin frames. Revisá permisos y recargá la página.");
  }

  const track = mediaStream.getVideoTracks()[0];

  // Locks best-effort (foco/exposición/WB)
  await applyCameraLocks(track);

  // ✅ Torch best-effort
  torchAvailable = false;
  if(track?.getCapabilities){
    const caps = track.getCapabilities();
    torchAvailable = !!(caps && ("torch" in caps));
  }

  if(torchWanted && torchAvailable){
    const okTorch = await enableTorch(track, true);
    if(okTorch){
      setStatus("Cámara + Flash activos • recolectando PPG (ROJO)", "ok");
    } else {
      setStatus("Cámara activa • no se pudo encender flash (limitación del dispositivo)", "warn");
    }
  } else if(!torchAvailable){
    // Tablet sin flash: avisar
    setStatus("Cámara activa • este dispositivo no tiene flash. Usá luz externa fuerte sobre el dedo.", "warn");
  } else {
    setStatus("Cámara activa • recolectando PPG (ROJO)", "ok");
  }

  // Canvas chico + ROI central (menos CPU)
  const roiW = 96, roiH = 96;
  frameCanvas.width = roiW;
  frameCanvas.height = roiH;

  // filtro online para AC
  let runningMean = null;
  const alpha = 0.02;

  // calidad
  const qbuf = [];
  const qmax = Math.round(5 * targetFps);
  let lastQualityTick = 0;
  let lowStreak = 0;

  // control FPS
  const minProcessInterval = 1000 / targetFps;
  lastFrameProcessMs = 0;

  const processFrame = (nowMs) => {
    if(!measuring) return;

    if(lastFrameProcessMs && (nowMs - lastFrameProcessMs) < (minProcessInterval * 0.85)){
      return;
    }
    lastFrameProcessMs = nowMs;

    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;

    // ROI central (finger should cover lens/flash)
    const cropSize = Math.min(vw, vh) * 0.35;
    const sx = (vw - cropSize) / 2;
    const sy = (vh - cropSize) / 2;

    frameCtx.drawImage(videoEl, sx, sy, cropSize, cropSize, 0, 0, roiW, roiH);
    const img = frameCtx.getImageData(0, 0, roiW, roiH).data;

    const meanR = computeMeanRed(img);

    if(runningMean === null) runningMean = meanR;
    runningMean = (1 - alpha) * runningMean + alpha * meanR;

    const ac = meanR - runningMean;
    const normalized = (runningMean !== 0) ? (ac / runningMean) : 0;

    // ECG estético (batch)
    pushChartPoint(ac * 45);

    // guardar crudo
    ppgSamples.push(normalized);
    ppgTimestamps.push(performance.now());

    qbuf.push(normalized);
    if(qbuf.length > qmax) qbuf.shift();

    const now = Date.now();
    if(qbuf.length > Math.round(2 * targetFps) && (now - lastQualityTick) > 300){
      lastQualityTick = now;

      const m = qbuf.reduce((a,b)=>a+b,0) / qbuf.length;
      let varx = 0;
      for(const v of qbuf) varx += (v - m) * (v - m);
      const stdx = Math.sqrt(varx / qbuf.length);

      let vard = 0;
      for(let i=1;i<qbuf.length;i++){
        const d = qbuf[i] - qbuf[i-1];
        vard += d*d;
      }
      const stdd = Math.sqrt(vard / Math.max(1, qbuf.length-1));

      const raw = stdx / (stdd + 1e-6);
      const score = Math.max(0, Math.min(100, raw * 58));
      setQuality(score);

      if(score < 25){
        lowStreak++;
        if(lowStreak >= 4){
          // guía práctica: cubrir flash+lente con presión moderada
          setStatus("Señal baja • cubrí lente+flash, presión moderada, sin movimiento", "warn");
        }
      } else if(score < 55){
        lowStreak = Math.max(0, lowStreak - 1);
        setStatus("Señal media • mantené estable (no aplastar)", "ok");
      } else {
        lowStreak = 0;
        setStatus(torchAvailable ? "Señal alta • excelente (flash activo)" : "Señal alta • excelente", "ok");
      }
    }
  };

  // loop preferido: requestVideoFrameCallback
  if(typeof videoEl.requestVideoFrameCallback === "function"){
    cameraRafActive = true;
    const loop = () => {
      if(!cameraRafActive) return;
      if(measuring) processFrame(performance.now());
      videoEl.requestVideoFrameCallback(loop);
    };
    videoEl.requestVideoFrameCallback(loop);
  } else {
    const intervalMs = Math.round(1000 / targetFps);
    cameraLoopHandle = setInterval(() => {
      if(!measuring) return;
      processFrame(performance.now());
    }, intervalMs);
  }
}

async function stopCameraPPG(){
  cameraRafActive = false;

  if(cameraLoopHandle){
    clearInterval(cameraLoopHandle);
    cameraLoopHandle = null;
  }

  // apagar torch antes de cortar track (best-effort)
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
  setQuality(null);
  setStatus("Cámara detenida", "idle");
}

/* ----------------------------
   Polar H10 BLE (mantener)
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
   (mantener endpoints y payload base)
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
  chartQueue.length = 0;

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
    payload.ppg = ppgSamples;
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

  const studentId = document.getElementById("studentId")?.value ?? "";
  const age = document.getElementById("age")?.value ?? "";
  const comorbidities = document.getElementById("comorbidities")?.value ?? "";
  const notes = document.getElementById("notes")?.value ?? "";

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
  }catch(e){
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

  document.getElementById("btnStart")?.addEventListener("click", async () => {
    if(measuring) return;
    try{
      await startMeasurement();
    }catch(e){
      measuring = false;
      enableControls();
      setStatus(e.message || String(e), "bad");
    }
  });

  document.getElementById("btnStop")?.addEventListener("click", async () => {
    await stopMeasurement();
  });

  document.getElementById("btnSave")?.addEventListener("click", async () => {
    await saveResult();
  });
});
