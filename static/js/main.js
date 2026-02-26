// static/js/main.js  (COMPLETO)  — NO cambia IDs ni nombres de funciones existentes
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
let targetFps = 45;
let cameraLoopHandle = null;

// Polar H10 BLE
let bleDevice = null;
let bleChar = null;
let rrIntervalsMs = [];
let lastMetrics = null;

// Chart.js
let chart = null;

// Real-time quality
let qualityScore = 0;
let qualityText = "—";
let qualityLevel = "idle";

// ===== ECG glow plugin (Chart.js) =====
const ecgGlowPlugin = {
  id: "ecgGlow",
  beforeDatasetsDraw(chartInstance, args, pluginOptions) {
    const { ctx } = chartInstance;
    ctx.save();
    ctx.shadowColor = pluginOptions.shadowColor || "rgba(255, 43, 43, 0.70)";
    ctx.shadowBlur = pluginOptions.shadowBlur || 18;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  },
  afterDatasetsDraw(chartInstance) {
    chartInstance.ctx.restore();
  }
};

function setStatus(text, level="idle"){
  const dot = document.getElementById("statusDot");
  const label = document.getElementById("statusText");
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
  if(!measuring || !startedAt){
    chipTimer.textContent = "00:00";
    return;
  }
  const elapsedSec = Math.floor((Date.now() - startedAt)/1000);
  chipTimer.textContent = fmtTime(elapsedSec);
}

function setSensorChip(){
  const chip = document.getElementById("chipSensor");
  chip.textContent =
    sensorType === "polar_h10" ? "Sensor: Polar H10 (BLE)" :
    sensorType === "ant_group" ? "Sensor: ANT+ Grupo (Bridge)" :
    "Sensor: Cámara (PPG)";
}

/* ✅ Mantiene el nombre setQualityChip, pero ahora controla una barra */
function setQualityChip(){
  const root = document.getElementById("chipQuality");
  if(!root) return;

  const fill = root.querySelector(".quality-fill");
  const valueEl = document.getElementById("qualityValue");

  const clamped = Math.max(0, Math.min(100, Number(qualityScore) || 0));
  if(fill) fill.style.width = `${clamped}%`;
  if(valueEl) valueEl.textContent = `${Math.round(clamped)}%`;

  // Texto/hint de calidad (sin cambiar IDs)
  const hint = document.getElementById("qualityHint");
  if(hint){
    if(qualityLevel === "ok") hint.textContent = "Señal buena: mantené el dedo firme y sin movimiento.";
    else if(qualityLevel === "warn") hint.textContent = "Señal moderada: ajustá presión y evitá movimiento.";
    else if(qualityLevel === "bad") hint.textContent = "Señal mala: más estabilidad / mejor contacto / menos movimiento.";
    else hint.textContent = "Mantener dedo firme, sin presión excesiva y sin movimiento.";
  }
}

function enableControls(){
  const startBtn = document.getElementById("btnStart");
  const stopBtn = document.getElementById("btnStop");
  const saveBtn = document.getElementById("btnSave");

  const antSelected = (sensorType === "ant_group");
  // ANT+ Grupo (bridge) no está implementado en este frontend
  startBtn.disabled = measuring || antSelected;
  stopBtn.disabled = !measuring;
  saveBtn.disabled = measuring || !lastMetrics || !!lastMetrics.error;

  if(antSelected){
    setStatus("ANT+ Grupo requiere Bridge (no realtime en web).", "warn");
  }
}

function initChart(){
  const ctx = document.getElementById("signalChart");
  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "ECG",
        data: [],
        pointRadius: 0,
        borderWidth: 2.6,
        tension: 0.25,
        borderColor: "#ff2b2b"
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: { display: false },
        ecgGlow: { shadowColor: "rgba(255, 43, 43, 0.70)", shadowBlur: 18 }
      },
      scales: {
        x: { display: false },
        y: { display: false }
      },
      elements: {
        line: { capBezierPoints: true }
      }
    },
    plugins: [ecgGlowPlugin]
  });
}

function pushChartPoint(value){
  const maxPoints = 420;
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
    enableControls();
  });

  // UI moderno (pills) -> actualiza el select original
  const pills = Array.from(document.querySelectorAll(".sensor-pill"));
  pills.forEach(btn => {
    btn.addEventListener("click", () => {
      const v = btn.getAttribute("data-value");
      if(!v) return;

      pills.forEach(x => x.classList.toggle("active", x === btn));

      sel.value = v;
      sel.dispatchEvent(new Event("change"));
    });
  });

  // Estado inicial sincronizado
  const initial = sel.value || "camera_ppg";
  pills.forEach(x => x.classList.toggle("active", x.getAttribute("data-value") === initial));
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
  if(metrics.quality_warning) freqHint.textContent = metrics.quality_warning;

  if(metrics.error){
    const c = document.createElement("div");
    c.className = "card bad";
    c.innerHTML = `<div class="k">Error</div><div class="v">${metrics.error}</div><div class="u">Revisá señal / movimiento</div>`;
    cards.appendChild(c);
    return;
  }

  const items = [
    {k:"HRV score", v: metrics.hrv_score, u:"/100"},
    {k:"HR media", v: metrics.hr_mean, u:"bpm"},
    {k:"HR máxima", v: metrics.hr_max, u:"bpm"},
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
    const val = isNum ? num.toFixed(2) : "—";

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

// ----------------------------
// Señal: Calidad en vivo (mismo nombre de función)
// ----------------------------
function computeLiveQuality(recent){
  if(!recent || recent.length < 60) return {score: 0, text: "—", level: "idle"};

  const x = recent.slice(-220);
  const mean = x.reduce((a,b)=>a+b,0) / x.length;
  const v = x.reduce((a,b)=>a+(b-mean)*(b-mean),0) / x.length;
  const std = Math.sqrt(v);

  let diffMean = 0;
  for(let i=1;i<x.length;i++) diffMean += Math.abs(x[i]-x[i-1]);
  diffMean /= (x.length-1);

  const s1 = Math.min(std / 0.018, 1.0);
  const m1 = Math.max(1.0 - (diffMean / 0.06), 0);

  const score = Math.round((0.65*s1 + 0.35*m1) * 100);

  let level = "warn";
  if(score >= 72) level="ok";
  else if(score >= 45) level="warn";
  else level="bad";

  return {score, text:`${score}%`, level};
}

function toEcgDisplayValue(v){
  // “ECG look”: compresión suave + realce
  return Math.tanh(v * 10) * 2.2;
}

// ----------------------------
// Cámara PPG
// ----------------------------
async function startCameraPPG(){
  videoEl = document.getElementById("video");
  frameCanvas = document.getElementById("frameCanvas");
  frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });

  ppgSamples = [];
  ppgTimestamps = [];

  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: "environment" },
      frameRate: { ideal: 60, min: 24 },
      width: { ideal: 1280 },
      height: { ideal: 720 }
    },
    audio: false
  });

  videoEl.srcObject = mediaStream;
  videoEl.playsInline = true;
  videoEl.muted = true;

  try { await videoEl.play(); } catch(_e) {}

  const t0 = Date.now();
  while ((videoEl.videoWidth === 0 || videoEl.videoHeight === 0) && (Date.now() - t0 < 4000)) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
    throw new Error("Cámara autorizada pero sin frames.");
  }

  // Torch si existe
  let torchOn = false;
  const track = mediaStream.getVideoTracks()[0];
  try{
    const caps = track.getCapabilities?.();
    if (caps && caps.torch) {
      await track.applyConstraints({ advanced: [{ torch: true }] });
      torchOn = true;
    }
  }catch(_e){}

  setStatus(torchOn ? "Cámara + torch ON • PPG" : "Cámara activa • PPG", torchOn ? "ok" : "warn");

  const w = 160, h = 120;
  frameCanvas.width = w;
  frameCanvas.height = h;

  const intervalMs = Math.round(1000 / targetFps);
  let runningMean = null;

  cameraLoopHandle = setInterval(() => {
    if(!measuring) return;

    frameCtx.drawImage(videoEl, 0, 0, w, h);
    const img = frameCtx.getImageData(0, 0, w, h).data;

    let sumR = 0;
    for(let i=0; i<img.length; i+=4) sumR += img[i];
    const meanR = sumR / (img.length / 4);

    if (runningMean === null) runningMean = meanR;
    runningMean = 0.97 * runningMean + 0.03 * meanR;

    const ac = meanR - runningMean;
    const normalized = (runningMean !== 0) ? (ac / runningMean) : 0;

    ppgSamples.push(normalized);
    ppgTimestamps.push(performance.now());

    const q = computeLiveQuality(ppgSamples);
    qualityScore = q.score;
    qualityText = q.text;
    qualityLevel = q.level;
    setQualityChip();

    pushChartPoint(toEcgDisplayValue(normalized));
  }, intervalMs);
}

function stopCameraPPG(){
  if(cameraLoopHandle){
    clearInterval(cameraLoopHandle);
    cameraLoopHandle = null;
  }
  if(mediaStream){
    const tracks = mediaStream.getVideoTracks();
    tracks.forEach(t => {
      try { t.applyConstraints({ advanced: [{ torch: false }] }); } catch(_e) {}
      t.stop();
    });
    mediaStream = null;
  }
  setStatus("Cámara detenida", "idle");
}

// ----------------------------
// Polar H10 BLE
// ----------------------------
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

  setStatus("Emparejando Polar H10…", "warn");

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
        pushChartPoint(rr / 1000.0);
      });
    }
  });

  setStatus("Polar conectado • RR", "ok");
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

// ----------------------------
// Medición: start/stop/compute/save
// ----------------------------
async function startMeasurement(){
  lastMetrics = null;
  buildCards(null);

  // reset chart
  chart.data.labels = [];
  chart.data.datasets[0].data = [];
  chart.update("none");

  // reset quality
  qualityScore = 0; qualityText="—"; qualityLevel="idle";
  setQualityChip();

  setSensorChip();
  enableControls();

  if(sensorType === "ant_group"){
    // no rompe nada: solo bloquea inicio en web
    setStatus("ANT+ Grupo requiere Bridge (no realtime en web).", "warn");
    return;
  }

  // conectar primero, luego iniciar medición
  if(sensorType === "polar_h10"){
    measuring = false;
    enableControls();
    await startPolarH10();
  } else {
    measuring = false;
    enableControls();
    await startCameraPPG();
  }

  measuring = true;
  startedAt = Date.now();
  enableControls();

  if(timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(async () => {
    setTimerText();
    const elapsedSec = Math.floor((Date.now() - startedAt)/1000);
    if(elapsedSec >= selectedDurationMin * 60){
      await stopMeasurement();
    }
  }, 250);

  setTimerText();
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
    stopCameraPPG();
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
        else setStatus("Cálculo OK • Calidad baja", "bad");
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

  setStatus("Guardando…", "warn");

  try{
    const res = await fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const out = await res.json();
    if(out.ok){
      setStatus("Guardado OK", "ok");
    } else {
      setStatus("No se pudo guardar", "bad");
    }
  }catch(e){
    setStatus("Error guardando", "bad");
  }
}

// ----------------------------
// Init
// ----------------------------
window.addEventListener("DOMContentLoaded", () => {
  initChart();
  setupDurationButtons();
  setupSensorSelector();
  setSensorChip();
  enableControls();
  buildCards(null);
  setQualityChip();

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
