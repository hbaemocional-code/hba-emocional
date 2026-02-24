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
let polarDevice = null;
let polarChar = null;
let polarRrIntervalsMs = [];
let polarDeviceName = "";

// Garmin HRM BLE
let garminDevice = null;
let garminChar = null;
let garminRrIntervalsMs = [];
let garminDeviceName = "";

// Resultado
let lastMetrics = null;

// Chart.js
let chart = null;

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
  if(sensorType === "polar_h10") chip.textContent = "Sensor: Polar H10 (BLE)";
  else if(sensorType === "garmin_hrm") chip.textContent = "Sensor: Garmin Banda Pecho (BLE)";
  else chip.textContent = "Sensor: Cámara (PPG)";
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

function pushChartPoint(value){
  const maxPoints = 300;
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

function _toNumber(v){
  if (typeof v === "number") return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

function _formatNumber(v, decimals){
  const n = _toNumber(v);
  if (!Number.isFinite(n)) return "—";
  return n.toFixed(decimals);
}

function _addCard(cardsEl, {k, v, u, cls=""}){
  const c = document.createElement("div");
  c.className = `card ${cls}`.trim();
  c.innerHTML = `<div class="k">${k}</div><div class="v">${v}</div><div class="u">${u}</div>`;
  cardsEl.appendChild(c);
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
    c.innerHTML = `<div class="k">Error</div><div class="v">${metrics.error}</div><div class="u">Revisá duración / señal / permisos</div>`;
    cards.appendChild(c);
    return;
  }

  // Vitals
  const hrMean = _toNumber(metrics.hr_mean_bpm);
  const hrMin  = _toNumber(metrics.hr_min_bpm);
  const hrMax  = _toNumber(metrics.hr_max_bpm);
  const respRpm = _toNumber(metrics.resp_rate_rpm);

  // HRV score: solo Polar (backend manda null en Garmin/PPG)
  const hrvScore = _toNumber(metrics.hrv_score);

  // ppg quality solo cámara
  const ppgQuality = _toNumber(metrics.ppg_quality);
  const ppgValid = metrics.ppg_valid;

  let hrTone = "";
  if(Number.isFinite(hrMean)){
    if(hrMean >= 50 && hrMean <= 90) hrTone = "good";
    else if((hrMean >= 40 && hrMean < 50) || (hrMean > 90 && hrMean <= 110)) hrTone = "warn";
    else hrTone = "bad";
  }

  let respTone = "";
  if(Number.isFinite(respRpm)){
    if(respRpm >= 10 && respRpm <= 20) respTone = "good";
    else if((respRpm >= 8 && respRpm < 10) || (respRpm > 20 && respRpm <= 24)) respTone = "warn";
    else respTone = "bad";
  }

  let scoreTone = "";
  if(Number.isFinite(hrvScore)){
    if(hrvScore >= 70) scoreTone = "good";
    else if(hrvScore >= 40) scoreTone = "warn";
    else scoreTone = "bad";
  }

  _addCard(cards, { k: "FC Media", v: _formatNumber(hrMean, 1), u: "bpm", cls: hrTone });
  _addCard(cards, { k: "FC Mínima", v: _formatNumber(hrMin, 1), u: "bpm" });
  _addCard(cards, { k: "FC Máxima", v: _formatNumber(hrMax, 1), u: "bpm" });

  _addCard(cards, {
    k: "HRV Score",
    v: Number.isFinite(hrvScore) ? Math.round(hrvScore).toString() : "—",
    u: "0–100 (solo Polar)",
    cls: scoreTone
  });

  _addCard(cards, { k: "Respiración", v: _formatNumber(respRpm, 1), u: "rpm", cls: respTone });

  if(sensorType === "camera_ppg"){
    let qTone = "";
    if(Number.isFinite(ppgQuality)){
      if(ppgQuality >= 80) qTone = "good";
      else if(ppgQuality >= 60) qTone = "warn";
      else qTone = "bad";
    }
    _addCard(cards, {
      k: "Calidad PPG",
      v: Number.isFinite(ppgQuality) ? Math.round(ppgQuality).toString() : "—",
      u: ppgValid === true ? "válida" : "no válida",
      cls: qTone
    });
  }

  // HRV details
  const items = [
    {k:"RMSSD", v: metrics.rmssd, u:"ms", d: 3},
    {k:"SDNN", v: metrics.sdnn, u:"ms", d: 3},
    {k:"lnRMSSD", v: metrics.lnrmssd, u:"ln(ms)", d: 3},
    {k:"pNN50", v: metrics.pnn50, u:"%", d: 3},
    {k:"Mean RR", v: metrics.mean_rr, u:"ms", d: 3},
    {k:"LF Power", v: metrics.lf_power, u:"ms²", d: 3},
    {k:"HF Power", v: metrics.hf_power, u:"ms²", d: 3},
    {k:"LF/HF", v: metrics.lf_hf, u:"ratio", d: 3},
    {k:"Total Power", v: metrics.total_power, u:"ms²", d: 3},
    {k:"Artefactos", v: metrics.artifact_percent, u:"%", d: 1},
    {k:"n RR", v: metrics.n_rr, u:"intervalos", d: 0},
  ];

  items.forEach(it => {
    const num = _toNumber(it.v);
    const isNum = Number.isFinite(num);
    const val = isNum ? num.toFixed(it.d) : "—";

    let cls = "";
    if(it.k === "Artefactos" && isNum){
      if(num <= 5) cls = "good";
      else if(num <= 12) cls = "warn";
      else cls = "bad";
    }
    _addCard(cards, { k: it.k, v: val, u: it.u, cls });
  });
}

// ----------------------------
// Cámara PPG (Android robust)
// ----------------------------
async function startCameraPPG(){
  videoEl = document.getElementById("video");
  frameCanvas = document.getElementById("frameCanvas");
  frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });

  ppgSamples = [];
  ppgTimestamps = [];

  mediaStream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { exact: "environment" },
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
  if (videoEl.videoWidth === 0 || videoEl.videoHeight === 0) {
    throw new Error("Cámara autorizada pero sin frames. Usá Chrome y revisá permisos.");
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

  const w = 160, h = 120;
  frameCanvas.width = w;
  frameCanvas.height = h;

  setStatus(torchOn ? "Cámara trasera + torch ON • recolectando PPG" : "Cámara trasera • recolectando PPG", torchOn ? "ok" : "warn");

  const intervalMs = Math.round(1000 / targetFps);

  let runningMean = null;
  let flatCount = 0;

  cameraLoopHandle = setInterval(() => {
    if(!measuring) return;

    frameCtx.drawImage(videoEl, 0, 0, w, h);
    const img = frameCtx.getImageData(0, 0, w, h).data;

    let sumR = 0;
    for(let i=0; i<img.length; i+=4) sumR += img[i];
    const meanR = sumR / (img.length / 4);

    if (!Number.isFinite(meanR) || meanR < 2) flatCount++;
    else flatCount = Math.max(0, flatCount - 1);

    if (runningMean === null) runningMean = meanR;
    runningMean = 0.97 * runningMean + 0.03 * meanR;

    const ac = meanR - runningMean;

    // gráfico visible
    const visible = ac * 80;
    pushChartPoint(visible);

    // señal para backend
    const normalized = (runningMean !== 0) ? (ac / runningMean) : 0;

    ppgSamples.push(normalized);
    ppgTimestamps.push(performance.now());

    if (flatCount > (2000 / intervalMs)) {
      setStatus("Sin señal útil (oscuro). Tapá el lente y probá con más luz.", "bad");
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
// BLE HR parser (Polar/Garmin)
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

// ----------------------------
// Polar H10 (driver separado)
// ----------------------------
async function connectPolarH10(){
  if(!navigator.bluetooth){
    throw new Error("Web Bluetooth no disponible en este navegador.");
  }

  setStatus("Buscando Polar H10…", "warn");

  polarDevice = await navigator.bluetooth.requestDevice({
    filters: [{ services: ["heart_rate"] }]
  });

  polarDeviceName = polarDevice?.name || "Polar H10";

  polarDevice.addEventListener("gattserverdisconnected", () => {
    setStatus("Polar desconectado", "bad");
    measuring = false;
    enableControls();
  });

  const server = await polarDevice.gatt.connect();
  const service = await server.getPrimaryService("heart_rate");
  polarChar = await service.getCharacteristic("heart_rate_measurement");

  await polarChar.startNotifications();
  polarChar.addEventListener("characteristicvaluechanged", (event) => {
    if(!measuring) return;
    const dv = event.target.value;
    const rrs = parseHeartRateMeasurement(dv);
    if(rrs.length){
      rrs.forEach(rr => {
        polarRrIntervalsMs.push(rr);
        pushChartPoint(rr);
      });
    }
  });

  setStatus("Polar H10 conectado • recolectando RR", "ok");
}

async function startPolarH10(){
  polarRrIntervalsMs = [];
  await connectPolarH10();
}

async function stopPolarH10(){
  try{ if(polarChar) await polarChar.stopNotifications(); }catch(_e){}
  try{
    if(polarDevice && polarDevice.gatt.connected){
      polarDevice.gatt.disconnect();
    }
  }catch(_e){}
  polarChar = null;
  polarDevice = null;
  setStatus("Polar detenido", "idle");
}

// ----------------------------
// Garmin HRM (driver separado)
// ----------------------------
function _isGarminName(name){
  if(!name) return false;
  const n = String(name).toLowerCase();
  // nombres típicos: "HRM-Pro", "HRM-Dual", "Garmin HRM..."
  return n.includes("garmin") || n.includes("hrm");
}

async function connectGarminHRM(){
  if(!navigator.bluetooth){
    throw new Error("Web Bluetooth no disponible en este navegador.");
  }

  setStatus("Buscando Garmin HRM…", "warn");

  // Garmin a veces no aparece bien con filters estrictos → aceptamos todos y validamos por nombre
  garminDevice = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: ["heart_rate"]
  });

  garminDeviceName = garminDevice?.name || "Garmin HRM";

  if(!_isGarminName(garminDeviceName)){
    try{
      if(garminDevice.gatt && garminDevice.gatt.connected) garminDevice.gatt.disconnect();
    }catch(_e){}
    garminDevice = null;
    throw new Error(`Dispositivo no parece Garmin HRM: "${garminDeviceName}". Seleccioná tu banda Garmin (HRM).`);
  }

  garminDevice.addEventListener("gattserverdisconnected", () => {
    setStatus("Garmin desconectado", "bad");
    measuring = false;
    enableControls();
  });

  const server = await garminDevice.gatt.connect();
  const service = await server.getPrimaryService("heart_rate");
  garminChar = await service.getCharacteristic("heart_rate_measurement");

  let rrSeen = false;

  await garminChar.startNotifications();
  garminChar.addEventListener("characteristicvaluechanged", (event) => {
    if(!measuring) return;
    const dv = event.target.value;
    const rrs = parseHeartRateMeasurement(dv);
    if(rrs.length){
      rrSeen = true;
      rrs.forEach(rr => {
        garminRrIntervalsMs.push(rr);
        pushChartPoint(rr);
      });
    }
  });

  // Si en ~5s no vimos RR, avisar (sin cortar medición: algunos mandan RR más tarde, pero es raro)
  setTimeout(() => {
    if(measuring && sensorType === "garmin_hrm" && !rrSeen){
      setStatus("Garmin conectado pero sin RR (solo HR). Sin RR no hay HRV.", "warn");
    }
  }, 5000);

  setStatus(`Garmin conectado • recolectando RR`, "ok");
}

async function startGarminHRM(){
  garminRrIntervalsMs = [];
  await connectGarminHRM();
}

async function stopGarminHRM(){
  try{ if(garminChar) await garminChar.stopNotifications(); }catch(_e){}
  try{
    if(garminDevice && garminDevice.gatt.connected){
      garminDevice.gatt.disconnect();
    }
  }catch(_e){}
  garminChar = null;
  garminDevice = null;
  setStatus("Garmin detenido", "idle");
}

// ----------------------------
// API helper
// ----------------------------
async function fetchJsonOrThrow(url, payload){
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const contentType = (res.headers.get("content-type") || "").toLowerCase();

  if(!res.ok){
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }

  if(!contentType.includes("application/json")){
    const text = await res.text();
    throw new Error(`Respuesta no-JSON: ${text.slice(0, 200)}`);
  }

  return await res.json();
}

// ----------------------------
// Medición start/stop/compute/save
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
  } else if(sensorType === "polar_h10"){
    await startPolarH10();
  } else {
    await startGarminHRM();
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
  } else if(sensorType === "polar_h10"){
    await stopPolarH10();
  } else {
    await stopGarminHRM();
  }

  setStatus("Procesando HRV…", "warn");

  let payload = {
    sensor_type: sensorType,
    duration_minutes: selectedDurationMin,
    device_name: ""
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
    payload.device_name = "Camera PPG";
  } else if(sensorType === "polar_h10"){
    payload.rri_ms = polarRrIntervalsMs;
    payload.device_name = polarDeviceName || "Polar H10";
  } else {
    payload.rri_ms = garminRrIntervalsMs;
    payload.device_name = garminDeviceName || "Garmin HRM";
  }

  try{
    const metrics = await fetchJsonOrThrow("/api/compute", payload);
    lastMetrics = metrics;

    buildCards(metrics);

    if(metrics.error){
      setStatus("Error en cálculo (ver tarjetas)", "bad");
    } else {
      const art = _toNumber(metrics.artifact_percent);
      if(Number.isFinite(art)){
        if(art <= 5) setStatus("Cálculo OK • Calidad buena", "ok");
        else if(art <= 12) setStatus("Cálculo OK • Calidad moderada", "warn");
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
    const out = await fetchJsonOrThrow("/api/save", payload);
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
