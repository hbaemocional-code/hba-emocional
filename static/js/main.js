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
let historyChart = null;

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
  chip.textContent = sensorType === "polar_h10" ? "Sensor: Polar H10 (BLE)" : "Sensor: Cámara (PPG)";
}

function enableControls(){
  document.getElementById("btnStart").disabled = measuring;
  document.getElementById("btnStop").disabled = !measuring;
  document.getElementById("btnSave").disabled = measuring || !lastMetrics || !!lastMetrics.error;
}

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
        borderWidth: 2,
        tension: 0.22
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { display: true, ticks: { color: "#95a3b7" } }
      }
    }
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

function initHistoryChart(){
  const ctx = document.getElementById("historyChart");
  if(!ctx) return;
  historyChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [{
        label: "RMSSD",
        data: [],
        pointRadius: 2,
        borderWidth: 2,
        tension: 0.25
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { display: true, ticks: { color: "#95a3b7" } }
      }
    }
  });
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

  if(metrics.freq_warning){
    freqHint.textContent = metrics.freq_warning;
  }

  if(metrics.error){
    const c = document.createElement("div");
    c.className = "card bad";
    c.innerHTML = `<div class="k">Error</div><div class="v">${metrics.error}</div><div class="u">Revisá señal / repetí</div>`;
    cards.appendChild(c);
    return;
  }

  const art = Number(metrics.artifact_percent);
  const rec = Number(metrics.recovery_score);

  // Cards “hero”
  const hero = [
    {k:"RMSSD", v: metrics.rmssd, u:"ms", cls:"hero"},
    {k:"Recovery", v: rec, u:"/100", cls:"hero"},
    {k:"HR media", v: metrics.hr_mean_bpm, u:"bpm", cls:""},
    {k:"Calidad", v: (Number.isFinite(art)? (100 - Math.min(100, art)) : null), u:"%", cls:""},
  ];

  hero.forEach(it=>{
    const num = typeof it.v === "number" ? it.v : Number(it.v);
    const isNum = Number.isFinite(num);
    const val = isNum ? num.toFixed(it.k==="Recovery" ? 0 : 2) : "—";

    let cls = "card " + (it.cls || "");
    if(it.k === "Calidad" && isNum){
      if(num >= 92) cls += " good";
      else if(num >= 82) cls += " warn";
      else cls += " bad";
    }
    if(it.k === "Recovery" && isNum){
      if(num >= 70) cls += " good";
      else if(num >= 45) cls += " warn";
      else cls += " bad";
    }

    const c = document.createElement("div");
    c.className = cls.trim();
    c.innerHTML = `<div class="k">${it.k}</div><div class="v">${val}</div><div class="u">${it.u}</div>`;
    cards.appendChild(c);
  });

  const items = [
    {k:"lnRMSSD", v: metrics.lnrmssd, u:"ln(ms)"},
    {k:"SDNN", v: metrics.sdnn, u:"ms"},
    {k:"pNN50", v: metrics.pnn50, u:"%"},
    {k:"Mean RR", v: metrics.mean_rr, u:"ms"},
    {k:"HR mín", v: metrics.hr_min_bpm, u:"bpm"},
    {k:"HR máx", v: metrics.hr_max_bpm, u:"bpm"},
    {k:"Resp", v: metrics.resp_rate_rpm, u:"rpm"},
    {k:"LF", v: metrics.lf_power, u:"ms²"},
    {k:"HF", v: metrics.hf_power, u:"ms²"},
    {k:"LF/HF", v: metrics.lf_hf, u:"ratio"},
    {k:"TP", v: metrics.total_power, u:"ms²"},
    {k:"Artefactos", v: metrics.artifact_percent, u:"%"},
  ];

  items.forEach(it => {
    const num = typeof it.v === "number" ? it.v : Number(it.v);
    const isNum = Number.isFinite(num);
    const val = isNum ? num.toFixed(3) : "—";

    let cls = "card";
    if(it.k === "Artefactos" && isNum){
      if(num <= 5) cls += " good";
      else if(num <= 12) cls += " warn";
      else cls += " bad";
    }

    const c = document.createElement("div");
    c.className = cls;
    c.innerHTML = `<div class="k">${it.k}</div><div class="v">${val}</div><div class="u">${it.u}</div>`;
    cards.appendChild(c);
  });

  // Cámara: si backend marca ppg_quality, lo mostramos en estado
  if(metrics.sensor_type === "camera_ppg" && metrics.ppg_quality){
    if(metrics.ppg_quality === "good") setStatus("Cálculo OK • Cámara (calidad buena)", "ok");
    else if(metrics.ppg_quality === "moderate") setStatus("Cálculo OK • Cámara (calidad moderada)", "warn");
    else setStatus("Cálculo OK • Cámara (calidad baja)", "bad");
  }
}

// ----------------------------
// Cámara PPG (más estable, menos estricta)
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
      frameRate: { ideal: 60, min: 30 },
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
  if (videoEl.videoWidth === 0) {
    throw new Error("Cámara autorizada pero sin frames. Probá Chrome y revisá permisos.");
  }

  let torchOn = false;
  const track = mediaStream.getVideoTracks()[0];
  try{
    const caps = track.getCapabilities?.();
    if (caps && caps.torch) {
      await track.applyConstraints({ advanced: [{ torch: true }] });
      torchOn = true;
    }
  }catch(_e){}

  const w = 200, h = 200;
  frameCanvas.width = w;
  frameCanvas.height = h;

  setStatus(torchOn ? "Cámara activa (torch) • Tomando PPG" : "Cámara activa • Tomando PPG", "ok");

  const intervalMs = Math.round(1000 / targetFps);

  let runningMean = null;
  let runningVar = 1;

  cameraLoopHandle = setInterval(() => {
    if(!measuring) return;

    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    const sx = Math.max(0, Math.floor(vw/2 - 150));
    const sy = Math.max(0, Math.floor(vh/2 - 150));
    const sw = Math.min(300, vw - sx);
    const sh = Math.min(300, vh - sy);

    frameCtx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, w, h);
    const img = frameCtx.getImageData(0, 0, w, h).data;

    let sumR = 0;
    for(let i=0; i<img.length; i+=4) sumR += img[i];
    const meanR = sumR / (img.length / 4);
    if(!Number.isFinite(meanR)) return;

    if (runningMean === null) runningMean = meanR;
    runningMean = 0.98 * runningMean + 0.02 * meanR;

    const ac = meanR - runningMean;
    runningVar = 0.98 * runningVar + 0.02 * (ac*ac);
    const sd = Math.sqrt(Math.max(runningVar, 1e-6));

    const normalized = ac / sd;

    // “ECG-like” visual
    pushChartPoint(normalized * 25);

    ppgSamples.push(normalized);
    ppgTimestamps.push(performance.now());
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

  // NO iniciar test hasta emparejar: acá se empareja primero
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

// ----------------------------
// Historial alumno
// ----------------------------
async function loadStudentHistory(){
  const studentId = (document.getElementById("studentId").value || "").trim();
  const hint = document.getElementById("historyHint");
  if(!historyChart){
    return;
  }
  if(!studentId){
    hint.textContent = "Ingresá un ID para ver evolución.";
    historyChart.data.labels = [];
    historyChart.data.datasets[0].data = [];
    historyChart.update("none");
    return;
  }
  try{
    const res = await fetch(`/api/history?student_id=${encodeURIComponent(studentId)}`);
    const out = await res.json();
    const rows = out.rows || [];
    if(!rows.length){
      hint.textContent = "Sin registros previos para este alumno.";
      historyChart.data.labels = [];
      historyChart.data.datasets[0].data = [];
      historyChart.update("none");
      return;
    }
    hint.textContent = `Últimos ${rows.length} tests (máx 50).`;
    historyChart.data.labels = rows.map(r => r.timestamp_utc || "");
    historyChart.data.datasets[0].data = rows.map(r => Number(r.rmssd));
    historyChart.update("none");
  }catch(e){
    hint.textContent = "No se pudo cargar historial.";
  }
}

// ----------------------------
// Medición: start/stop/compute/save
// ----------------------------
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
    } else if(metrics.sensor_type === "polar_h10") {
      const art = Number(metrics.artifact_percent);
      if(Number.isFinite(art)){
        if(art <= 5) setStatus("Polar OK • Calidad buena", "ok");
        else if(art <= 12) setStatus("Polar OK • Calidad moderada", "warn");
        else setStatus("Polar OK • Calidad baja", "bad");
      } else {
        setStatus("Polar OK", "ok");
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
      setStatus("Guardado OK • dataset actualizado", "ok");
      await loadStudentHistory();
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
  initHistoryChart();
  setupDurationButtons();
  setupSensorSelector();
  setSensorChip();
  enableControls();
  buildCards(null);

  document.getElementById("studentId").addEventListener("change", loadStudentHistory);

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
