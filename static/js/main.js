// static/js/main.js  (COMPLETO)
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

// Charts
let chart = null;
let trendChart = null;

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
        tension: 0.35
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: { display: true, ticks: { color: "#98a6bf" } }
      }
    }
  });
}

function initTrendChart(){
  const ctx = document.getElementById("trendChart");
  trendChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: [],
      datasets: [
        { label: "RMSSD", data: [], pointRadius: 2, borderWidth: 2, tension: 0.25 },
        { label: "HR media", data: [], pointRadius: 2, borderWidth: 2, tension: 0.25 },
        { label: "HRV score", data: [], pointRadius: 2, borderWidth: 2, tension: 0.25 },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: { legend: { display: true, labels: { color: "#98a6bf" } } },
      scales: {
        x: { display: true, ticks: { color: "#98a6bf", maxRotation: 0, autoSkip: true } },
        y: { display: true, ticks: { color: "#98a6bf" } }
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
      if(num <= 5) cls += " good";
      else if(num <= 12) cls += " warn";
      else cls += " bad";
    }

    const c = document.createElement("div");
    c.className = cls;
    c.innerHTML = `<div class="k">${it.k}</div><div class="v">${val}</div><div class="u">${it.u}</div>`;
    cards.appendChild(c);
  });
}

// ----------------------------
// Cámara PPG (menos estricta)
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

  const w = 160, h = 120;
  frameCanvas.width = w;
  frameCanvas.height = h;

  setStatus(torchOn ? "Cámara + torch ON • recolectando PPG" : "Cámara activa • recolectando PPG", torchOn ? "ok" : "warn");

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

    // gráfico: amplificado
    pushChartPoint(ac * 80);

    // backend: señal normalizada (AC/DC)
    const normalized = (runningMean !== 0) ? (ac / runningMean) : 0;

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
        pushChartPoint(rr); // RR curve
      });
    }
  });

  setStatus("Polar conectado • recolectando RR", "ok");
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
// Tendencias (CSV history)
// ----------------------------
async function loadTrend(){
  const studentId = document.getElementById("studentId").value.trim();
  if(!studentId || !trendChart) return;

  try{
    const res = await fetch(`/api/history?student_id=${encodeURIComponent(studentId)}`);
    const data = await res.json();
    if(!data.ok) return;

    const items = data.items || [];
    const labels = items.map(x => (x.t || "").slice(5,10)); // MM-DD
    const rmssd = items.map(x => Number(x.rmssd));
    const hr = items.map(x => Number(x.hr_mean));
    const score = items.map(x => Number(x.hrv_score));

    trendChart.data.labels = labels;
    trendChart.data.datasets[0].data = rmssd.map(v => Number.isFinite(v) ? v : null);
    trendChart.data.datasets[1].data = hr.map(v => Number.isFinite(v) ? v : null);
    trendChart.data.datasets[2].data = score.map(v => Number.isFinite(v) ? v : null);
    trendChart.update("none");
  }catch(_e){}
}

// ----------------------------
// Medición (NO arranca timer hasta que conecte)
// ----------------------------
async function startMeasurement(){
  lastMetrics = null;
  buildCards(null);

  // Reset charts
  chart.data.labels = [];
  chart.data.datasets[0].data = [];
  chart.update("none");

  setSensorChip();

  if(sensorType === "polar_h10"){
    // conectar primero, recién después inicia timer/medición
    measuring = false;
    enableControls();
    await startPolarH10();
  }

  if(sensorType === "camera_ppg"){
    measuring = false;
    enableControls();
    await startCameraPPG();
  }

  // Ahora sí empieza medición real
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

  setStatus("Procesando…", "warn");

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
        if(art <= 5) setStatus("OK • Calidad buena", "ok");
        else if(art <= 12) setStatus("OK • Calidad moderada", "warn");
        else setStatus("OK • Calidad baja (artefactos altos)", "bad");
      } else {
        setStatus("OK", "ok");
      }
    }

    await loadTrend();
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
      setStatus("Guardado OK • CSV actualizado", "ok");
      await loadTrend();
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
window.addEventListener("DOMContentLoaded", async () => {
  initChart();
  initTrendChart();
  setupDurationButtons();
  setupSensorSelector();
  setSensorChip();
  enableControls();
  buildCards(null);
  await loadTrend();

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

  document.getElementById("studentId").addEventListener("change", async () => {
    await loadTrend();
  });
});
