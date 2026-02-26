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

// Calidad señal (frontend)
let qualityScore = 0; // 0..100
let qualityWindow = []; // últimos N samples (para estimar)
let qualityLastUpdate = 0;

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
    dot.style.boxShadow = "0 0 0 4px rgba(255,43,43,0.18)";
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
  chip.textContent = sensorType === "polar_h10" ? "Sensor: Polar H10 (BLE)" : "Sensor: Cámara (PPG)";
}

function enableControls(){
  document.getElementById("btnStart").disabled = measuring;
  document.getElementById("btnStop").disabled = !measuring;
  document.getElementById("btnSave").disabled = measuring || !lastMetrics || !!lastMetrics.error;
}

/* Glow rojo para Chart.js (sin cambiar IDs) */
const glowPlugin = {
  id: "glowPlugin",
  beforeDatasetsDraw(chart, args, pluginOptions){
    const { ctx } = chart;
    ctx.save();
    ctx.shadowColor = "rgba(255, 43, 43, 0.55)";
    ctx.shadowBlur = 14;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
  },
  afterDatasetsDraw(chart){
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
        label: "ECG",
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
      scales: {
        x: { display: false },
        y: {
          display: false,
          suggestedMin: -2,
          suggestedMax: 2
        }
      }
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

/* Barra de calidad (sin cambiar IDs existentes) */
function setQuality(score, text){
  const fill = document.getElementById("qualityFill");
  const label = document.getElementById("qualityLabel");
  const hint = document.getElementById("qualityHint");

  const s = Math.max(0, Math.min(100, Math.round(score)));
  fill.style.width = `${s}%`;

  label.textContent = text || `${s}%`;

  if(s >= 75){
    hint.textContent = "Señal buena. Mantené el dedo firme.";
  } else if(s >= 45){
    hint.textContent = "Señal media. Presioná un poco más y evitá mover el dedo.";
  } else {
    hint.textContent = "Señal baja. Tapá completamente el lente + flash/linterna y evitá movimiento.";
  }
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

  if(metrics.freq_warning){
    freqHint.textContent = metrics.freq_warning;
  }

  if(metrics.error){
    const c = document.createElement("div");
    c.className = "card bad";
    c.innerHTML = `<div class="k">ERROR</div><div class="v">${metrics.error}</div><div class="u">Revisá señal / movimiento</div>`;
    cards.appendChild(c);
    return;
  }

  const items = [
    {k:"HR (Media)", v: metrics.hr_mean, u:"bpm"},
    {k:"HR (Máx)", v: metrics.hr_max, u:"bpm"},
    {k:"HR (Mín)", v: metrics.hr_min, u:"bpm"},
    {k:"RMSSD", v: metrics.rmssd, u:"ms"},
    {k:"SDNN", v: metrics.sdnn, u:"ms"},
    {k:"lnRMSSD", v: metrics.lnrmssd, u:"ln(ms)"},
    {k:"pNN50", v: metrics.pnn50, u:"%"},
    {k:"Mean RR", v: metrics.mean_rr, u:"ms"},
    {k:"LF Power", v: metrics.lf_power, u:"ms²"},
    {k:"HF Power", v: metrics.hf_power, u:"ms²"},
    {k:"LF/HF", v: metrics.lf_hf, u:"ratio"},
    {k:"Total Power", v: metrics.total_power, u:"ms²"},
    {k:"Resp (est.)", v: metrics.resp_rate_rpm, u:"rpm"},
    {k:"Artefactos", v: metrics.artifact_percent, u:"%"},
  ];

  items.forEach(it => {
    const num = typeof it.v === "number" ? it.v : Number(it.v);
    const isNum = Number.isFinite(num);
    const val = isNum ? (it.k.includes("LF/HF") ? num.toFixed(2) : num.toFixed(1)) : "—";

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
// Cámara PPG (tolerante + calidad realtime)
// ----------------------------
async function startCameraPPG(){
  videoEl = document.getElementById("video");
  frameCanvas = document.getElementById("frameCanvas");
  frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });

  ppgSamples = [];
  ppgTimestamps = [];
  qualityWindow = [];
  qualityScore = 0;
  setQuality(0, "—");

  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "environment",
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

  // esperar frames reales
  const t0 = Date.now();
  while ((videoEl.videoWidth === 0 || videoEl.videoHeight === 0) && (Date.now() - t0 < 4000)) {
    await new Promise(r => setTimeout(r, 50));
  }
  if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
    throw new Error("Cámara autorizada pero sin frames (revisá permisos / Chrome real).");
  }

  // torch si existe
  let torchOn = false;
  const track = mediaStream.getVideoTracks()[0];
  try{
    const caps = track.getCapabilities?.();
    if (caps && caps.torch) {
      await track.applyConstraints({ advanced: [{ torch: true }] });
      torchOn = true;
    }
  }catch(_e){}

  const w = 160, h = 120;
  frameCanvas.width = w;
  frameCanvas.height = h;

  setStatus(torchOn ? "Cámara trasera + torch ON • recolectando PPG" : "Cámara trasera • recolectando PPG", torchOn ? "ok" : "warn");

  const intervalMs = Math.round(1000 / targetFps);

  // extracción robusta:
  // - meanR
  // - AC = meanR - runningMean
  // - normalizado: AC/DC
  let runningMean = null;
  let runningVar = 0;

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
    const norm = (runningMean !== 0) ? (ac / runningMean) : 0;

    // suavizado simple para curva fluida
    const last = ppgSamples.length ? ppgSamples[ppgSamples.length-1] : 0;
    const sm = 0.75 * last + 0.25 * norm;

    ppgSamples.push(sm);
    ppgTimestamps.push(performance.now());

    // curva ECG-like (centrada y amplificada)
    pushChartPoint(sm * 120);

    // calidad (cada ~250ms)
    qualityWindow.push(sm);
    const maxW = Math.max(120, Math.round(targetFps * 6)); // 6s aprox
    if(qualityWindow.length > maxW) qualityWindow.shift();

    const now = performance.now();
    if(now - qualityLastUpdate > 250){
      qualityLastUpdate = now;

      // métricas rápidas: var + “actividad pulsátil”
      const n = qualityWindow.length;
      if(n > Math.round(targetFps * 2)){
        let m = 0;
        for(let i=0;i<n;i++) m += qualityWindow[i];
        m /= n;

        let v = 0;
        for(let i=0;i<n;i++){
          const d = qualityWindow[i] - m;
          v += d*d;
        }
        v /= n;

        runningVar = 0.85 * runningVar + 0.15 * v;

        // score: var moderada (no cero, no caos)
        const varScore = Math.max(0, Math.min(1, (runningVar - 1e-6) / (2.5e-4))); // calibrado empírico
        // penalizar saturación / oscuridad
        const lightPenalty = (meanR < 8) ? 0.35 : 1.0;

        // penalizar movimiento brusco (saltos)
        let jumps = 0;
        for(let i=1;i<n;i++){
          if(Math.abs(qualityWindow[i]-qualityWindow[i-1]) > 0.05) jumps++;
        }
        const jumpRate = jumps / Math.max(n-1,1);
        const motionPenalty = 1.0 - Math.max(0, Math.min(0.55, jumpRate * 2.2));

        const raw = 100 * varScore * lightPenalty * motionPenalty;
        qualityScore = 0.7 * qualityScore + 0.3 * raw;

        let label = `${Math.round(qualityScore)}%`;
        if(qualityScore >= 75) label = "BUENA";
        else if(qualityScore >= 45) label = "MEDIA";
        else label = "BAJA";

        setQuality(qualityScore, label);
      } else {
        setQuality(0, "—");
      }
    }
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
        // curva tipo ECG también: mapear RR a variación visual suave
        pushChartPoint((60_000 / rr - 60) * 2.0);
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

// ----------------------------
// Medición: start/stop/compute/save
// ----------------------------
async function startMeasurement(){
  lastMetrics = null;
  buildCards(null);

  // bloquear ANT+ (no implementado acá)
  if(sensorType === "ant_group"){
    setStatus("ANT+ Grupo: próximamente", "warn");
    return;
  }

  measuring = true;
  startedAt = Date.now();
  enableControls();
  setSensorChip();

  // Reset chart
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
  setQuality(0, "—");

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
