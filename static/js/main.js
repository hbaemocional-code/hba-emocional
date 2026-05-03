/* ═══════════════════════════════════════════════════════════════
   HBA v2.0 — main.js
   Sensores: cámara PPG · rPPG facial · vibración SCG ·
             Polar H10 BLE · importación CSV/JSON RR
   Dashboard: semáforo clínico · cargas diferenciadas ·
              biomarcadores · Poincaré · plan de intervención
═══════════════════════════════════════════════════════════════ */

"use strict";

// ── Constantes ───────────────────────────────────────────────────
const PPG_SR   = 30;          // muestras/s (cámara PPG / rPPG)
const SCG_SR   = 50;          // muestras/s (acelerómetro)
const SIGNAL_WIN = 300;       // puntos visibles en la gráfica
const CHART_FPS  = 10;        // fps máximo del gráfico

// ── Estado global ────────────────────────────────────────────────
const G = {
  sensor        : "camera_ppg",
  durationMin   : 3,
  running       : false,
  ppgBuffer     : [],      // muestras raw PPG/SCG
  rrBuffer      : [],      // intervalos RR en ms (Polar / upload)
  signalBuffer  : [],      // para la gráfica en tiempo real
  totalSeconds  : 0,
  elapsedSec    : 0,
  lastMetrics   : null,
  quality       : null,    // 0-100
  // handles
  timerHandle   : null,
  rafHandle     : null,
  chartLastDraw : 0,
  // BLE Polar
  bleDevice     : null,
  bleServer     : null,
  // Media streams
  stream        : null,
  videoEl       : null,
  frameCtx      : null,
  // Sensor motion
  motionHandler : null,
  motionBuffer  : [],
};

// ── Refs DOM ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Gráfica señal (Chart.js) ─────────────────────────────────────
let signalChart = null;

function buildChart() {
  const ctx = $("signalChart").getContext("2d");
  signalChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: Array(SIGNAL_WIN).fill(""),
      datasets: [{
        data           : Array(SIGNAL_WIN).fill(null),
        borderColor    : "rgba(29,78,216,0.85)",
        borderWidth    : 1.5,
        pointRadius    : 0,
        fill           : true,
        backgroundColor: "rgba(29,78,216,0.06)",
        tension        : 0.3,
      }]
    },
    options: {
      animation       : false,
      responsive      : true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { enabled: false } },
      scales: {
        x: { display: false },
        y: { display: false, grace: "20%" }
      }
    }
  });
}

function pushSignal(val) {
  G.signalBuffer.push(val);
  if (G.signalBuffer.length > SIGNAL_WIN * 3) G.signalBuffer.shift();
}

function renderChart(now) {
  G.rafHandle = requestAnimationFrame(renderChart);
  if (!G.running) return;
  if (now - G.chartLastDraw < 1000 / CHART_FPS) return;
  G.chartLastDraw = now;

  const buf  = G.signalBuffer;
  const data = buf.length >= SIGNAL_WIN
    ? buf.slice(buf.length - SIGNAL_WIN)
    : [...Array(SIGNAL_WIN - buf.length).fill(null), ...buf];

  signalChart.data.datasets[0].data = data;
  signalChart.update("none");
}

// ── Timer ────────────────────────────────────────────────────────
function startTimer() {
  G.elapsedSec = 0;
  G.timerHandle = setInterval(() => {
    G.elapsedSec++;
    const m = String(Math.floor(G.elapsedSec / 60)).padStart(2, "0");
    const s = String(G.elapsedSec % 60).padStart(2, "0");
    $("chipTimer").textContent = `${m}:${s}`;

    if (G.elapsedSec >= G.totalSeconds) {
      stopSession(true);
    }
  }, 1000);
}

function stopTimer() {
  if (G.timerHandle) { clearInterval(G.timerHandle); G.timerHandle = null; }
}

// ── Countdown ────────────────────────────────────────────────────
function showCountdown(title, text, hint, secs) {
  return new Promise(resolve => {
    const overlay = $("countdownOverlay");
    $("countdownTitle").textContent = title;
    $("countdownText").textContent  = text;
    $("countdownHint").textContent  = hint;
    overlay.style.display = "flex";

    let n = secs;
    $("countdownN").textContent = n;
    const iv = setInterval(() => {
      n--;
      if (n <= 0) {
        clearInterval(iv);
        overlay.style.display = "none";
        resolve();
      } else {
        $("countdownN").textContent = n;
      }
    }, 1000);
  });
}

// ── UI helpers ───────────────────────────────────────────────────
function setStatus(text, cls = "") {
  $("statusText").textContent = text;
  const dot = $("statusDot");
  dot.className = "status-dot";
  if (cls) dot.classList.add(cls);
}

function setChipSensor(text) { $("chipSensor").textContent = text; }

function setBtns(running) {
  $("btnStart").disabled = running;
  $("btnStop").disabled  = !running;
  $("btnSave").disabled  = running || !G.lastMetrics;
}

function updateQuality(q) {
  G.quality = q;
  const fill = $("qualityFill");
  const text = $("qualityText");
  if (q == null) { fill.style.width = "0%"; text.textContent = "—"; return; }
  fill.style.width = `${q}%`;
  text.textContent = `${Math.round(q)}%`;
  fill.style.background = q >= 70 ? "var(--s-optimo)" : q >= 40 ? "var(--s-comprometido)" : "var(--s-critico)";
}

// ── Selector de sensor ────────────────────────────────────────────
const SENSOR_META = {
  camera_ppg   : { label: "Cámara PPG",    hint: "Dedo sobre lente. Cubrí bien la cámara.", dur1: false, torch: true,  media: true,  guide: "Apoyá el codo en la mesa. Colocá el dedo índice cubriendo completamente el lente y el flash. Respirá con normalidad." },
  face_rppg    : { label: "Rostro rPPG",   hint: "Iluminación frontal constante recomendada.", dur1: true, torch: false, media: true,  guide: "Sentate frente a la cámara con luz natural o artificial estable. No te muevas durante el test." },
  vibration_scg: { label: "Vibración SCG", hint: "Apoyá el celular sobre el esternón.", dur1: true, torch: false, media: false, guide: "Acostáte boca arriba. Colocá el celular centrado sobre el esternón. Otorgá permiso de movimiento cuando el browser lo solicite." },
  polar_h10    : { label: "Polar H10 BLE", hint: "Requiere Chrome/Edge + HTTPS + cinta pectoral.", dur1: true, torch: false, media: false, guide: "Ajustá la cinta Polar H10 y presioná Iniciar. El browser pedirá permiso Bluetooth." },
  rr_upload    : { label: "Importar RR",   hint: "CSV (columna 'rr' o primera columna en ms) o JSON.", dur1: true, torch: false, media: false, guide: "Cargá el archivo exportado desde Polar App, Kubios, Garmin u otro sistema HRV." },
};

$("sensorType").addEventListener("change", () => {
  G.sensor = $("sensorType").value;
  const meta = SENSOR_META[G.sensor];
  setChipSensor(meta.label);
  $("sensorHint").textContent = meta.hint;
  $("guideText").textContent  = meta.guide;
  $("dur1").style.display     = meta.dur1  ? "" : "none";
  $("torchField").style.display = meta.torch ? "" : "none";
  $("cameraCard").style.display = meta.media ? "" : "none";
  $("rrUploadField").style.display = G.sensor === "rr_upload" ? "" : "none";

  if (meta.media) {
    $("mediaTitle").textContent = G.sensor === "face_rppg" ? "Cámara facial (rPPG)" : "Cámara PPG";
    $("mediaSub").textContent   = G.sensor === "face_rppg" ? "Iluminá tu rostro de forma uniforme" : "Colocá el dedo sobre el lente";
    $("mediaNote").textContent  = G.sensor === "face_rppg" ? "rPPG facial: señal más ruidosa. Resultados orientativos." : "Consejo: apoyá el codo, evitá movimiento, cubrí bien el lente.";
  }

  if (!meta.dur1 && G.durationMin === 1) {
    $("dur3").click();
  }
});

// Selector duración
document.querySelectorAll(".seg-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    G.durationMin = parseInt(btn.dataset.min, 10);
    G.totalSeconds = G.durationMin * 60;
    $("durHint").textContent = G.durationMin < 5
      ? `Test de ${G.durationMin} min: LF/HF es orientativo. Para máxima precisión usá 5 min.`
      : "5 min: análisis espectral y DFA más estable.";
  });
});

// Inicialización
G.durationMin  = 3;
G.totalSeconds = 180;
G.sensor = "camera_ppg";

// ── Cámara PPG / rPPG ─────────────────────────────────────────────
async function startCamera() {
  const isFace = G.sensor === "face_rppg";
  const constraints = {
    video: {
      facingMode: isFace ? "user" : "environment",
      width: { ideal: isFace ? 320 : 160 },
      height: { ideal: isFace ? 240 : 120 },
      frameRate: { ideal: PPG_SR },
    }
  };

  G.stream = await navigator.mediaDevices.getUserMedia(constraints);
  G.videoEl = $("video");
  G.videoEl.srcObject = G.stream;
  await G.videoEl.play();

  const canvas = $("frameCanvas");
  G.frameCtx = canvas.getContext("2d", { willReadFrequently: true });

  // Torch para PPG de dedo
  if (G.sensor === "camera_ppg" && $("torchToggle").checked) {
    try {
      const track = G.stream.getVideoTracks()[0];
      await track.applyConstraints({ advanced: [{ torch: true }] });
    } catch (_) { /* no soportado */ }
  }

  const canvas2d = $("frameCanvas");
  canvas2d.width  = 4;
  canvas2d.height = 4;

  let lastFrame = 0;
  const interval = 1000 / PPG_SR;

  function captureFrame(ts) {
    if (!G.running) return;
    if (ts - lastFrame >= interval) {
      lastFrame = ts;
      G.frameCtx.drawImage(G.videoEl, 0, 0, 4, 4);
      const px = G.frameCtx.getImageData(0, 0, 4, 4).data;
      let val = 0;
      if (isFace) {
        // rPPG: canal verde es más sensible al flujo sanguíneo facial
        for (let i = 1; i < px.length; i += 4) val += px[i];
      } else {
        // PPG dedo: canal rojo + infrarrojo emulado
        for (let i = 0; i < px.length; i += 4) val += px[i];
      }
      val /= (px.length / 4);
      G.ppgBuffer.push(val);
      pushSignal(val);
    }
    requestAnimationFrame(captureFrame);
  }

  requestAnimationFrame(captureFrame);
}

function stopCamera() {
  if (G.stream) {
    G.stream.getTracks().forEach(t => {
      try {
        if (t.getConstraints().advanced) t.applyConstraints({ advanced: [{ torch: false }] });
      } catch (_) {}
      t.stop();
    });
    G.stream = null;
  }
  if (G.videoEl) { G.videoEl.srcObject = null; }
}

// ── Vibración / SCG ───────────────────────────────────────────────
function startVibration() {
  if (!window.DeviceMotionEvent) {
    alert("Tu dispositivo no soporta el acelerómetro.");
    throw new Error("No DeviceMotionEvent");
  }

  // iOS 13+ requiere permiso explícito
  if (typeof DeviceMotionEvent.requestPermission === "function") {
    DeviceMotionEvent.requestPermission().then(state => {
      if (state !== "granted") throw new Error("Permiso denegado");
      _bindMotion();
    });
  } else {
    _bindMotion();
  }
}

function _bindMotion() {
  G.motionBuffer = [];
  G.motionHandler = (e) => {
    if (!G.running) return;
    const a = e.accelerationIncludingGravity;
    if (!a) return;
    const mag = Math.sqrt((a.x||0)**2 + (a.y||0)**2 + (a.z||0)**2);
    G.motionBuffer.push(mag);
    G.ppgBuffer.push(mag);
    pushSignal(mag);
  };
  window.addEventListener("devicemotion", G.motionHandler, { passive: true });
}

function stopVibration() {
  if (G.motionHandler) {
    window.removeEventListener("devicemotion", G.motionHandler);
    G.motionHandler = null;
  }
}

// ── Polar H10 BLE ─────────────────────────────────────────────────
const POLAR_SERVICE_HR   = "0000180d-0000-1000-8000-00805f9b34fb";
const POLAR_CHAR_HR      = "00002a37-0000-1000-8000-00805f9b34fb";
const POLAR_SERVICE_PMD  = "fb005c80-02e7-f387-1cad-8acd2d8df0c8";
const POLAR_CHAR_PMD_CP  = "fb005c81-02e7-f387-1cad-8acd2d8df0c8";
const POLAR_CHAR_PMD_DAT = "fb005c82-02e7-f387-1cad-8acd2d8df0c8";

async function startPolarH10() {
  if (!navigator.bluetooth) {
    alert("Web Bluetooth no disponible. Usá Chrome/Edge con HTTPS.");
    throw new Error("No Bluetooth");
  }

  setStatus("Buscando Polar H10…", "warn");

  G.bleDevice = await navigator.bluetooth.requestDevice({
    filters: [{ namePrefix: "Polar" }],
    optionalServices: [POLAR_SERVICE_HR, POLAR_SERVICE_PMD],
  });

  G.bleServer = await G.bleDevice.gatt.connect();
  setStatus("Polar conectado", "ok");

  // Intentar RR via PMD (más preciso)
  let gotPMD = false;
  try {
    const pmdSvc  = await G.bleServer.getPrimaryService(POLAR_SERVICE_PMD);
    const pmdCp   = await pmdSvc.getCharacteristic(POLAR_CHAR_PMD_CP);
    const pmdDat  = await pmdSvc.getCharacteristic(POLAR_CHAR_PMD_DAT);

    // Solicitar stream ECG
    await pmdCp.writeValue(new Uint8Array([0x02, 0x00, 0x00, 0x01, 0x82, 0x00, 0x01, 0x01, 0x0E, 0x00]));

    pmdDat.addEventListener("characteristicvaluechanged", e => {
      if (!G.running) return;
      parsePolarPMD(e.target.value);
    });
    await pmdDat.startNotifications();
    gotPMD = true;
  } catch (_) { /* Fallback a HR service */ }

  if (!gotPMD) {
    // Fallback: usar HR characteristic (RR está en flag bit)
    const hrSvc  = await G.bleServer.getPrimaryService(POLAR_SERVICE_HR);
    const hrChar = await hrSvc.getCharacteristic(POLAR_CHAR_HR);
    hrChar.addEventListener("characteristicvaluechanged", e => {
      if (!G.running) return;
      parseHRMeasurement(e.target.value);
    });
    await hrChar.startNotifications();
  }
}

function parsePolarPMD(dv) {
  // Frame ECG Polar PMD: byte 0 = tipo, bytes 10+ = muestras ECG int16 LE
  const type = dv.getUint8(0);
  if (type !== 0x00) return; // solo ECG
  // Acumular muestras como señal y derivar RR simplificado
  for (let i = 10; i + 1 < dv.byteLength; i += 3) {
    const val = dv.getInt16(i, true);
    pushSignal(val);
    G.ppgBuffer.push(val);
  }
}

function parseHRMeasurement(dv) {
  const flags  = dv.getUint8(0);
  const hrFmt  = flags & 0x01;
  const hasRR  = (flags >> 4) & 0x01;
  let offset   = hrFmt ? 3 : 2;

  const hr = hrFmt ? dv.getUint16(1, true) : dv.getUint8(1);
  pushSignal(hr);

  if (hasRR) {
    while (offset + 1 < dv.byteLength) {
      const rr = dv.getUint16(offset, true) / 1024.0 * 1000.0;
      offset += 2;
      if (rr > 300 && rr < 2200) {
        G.rrBuffer.push(rr);
        // Usar el RR como señal visual
        pushSignal(rr);
      }
    }
  }
}

function stopPolarH10() {
  try {
    if (G.bleDevice && G.bleDevice.gatt.connected) G.bleDevice.gatt.disconnect();
  } catch (_) {}
  G.bleDevice = null;
  G.bleServer = null;
}

// ── Importación RR ────────────────────────────────────────────────
async function loadRRFile() {
  const file = $("rrFile").files[0];
  if (!file) throw new Error("Sin archivo");

  const text = await file.text();
  const name = file.name.toLowerCase();
  let rrs = [];

  if (name.endsWith(".json")) {
    const obj = JSON.parse(text);
    if (Array.isArray(obj)) rrs = obj.map(Number);
    else if (obj.rri_ms) rrs = obj.rri_ms.map(Number);
    else if (obj.rr)     rrs = obj.rr.map(Number);
    else rrs = Object.values(obj).flat().map(Number);
  } else {
    // CSV: buscar columna "rr", "rri", "rri_ms" o primera columna
    const lines = text.trim().split(/\r?\n/);
    const header = lines[0].toLowerCase().split(/[,;\t]/);
    let col = -1;
    for (const key of ["rr", "rri", "rri_ms", "nn", "ibi"]) {
      col = header.indexOf(key);
      if (col >= 0) break;
    }
    if (col < 0) col = 0;
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(/[,;\t]/);
      const v = parseFloat(parts[col]);
      if (!isNaN(v)) rrs.push(v);
    }
  }

  // Auto-detectar si está en segundos → convertir a ms
  const mean = rrs.reduce((a, b) => a + b, 0) / rrs.length;
  if (mean < 5) rrs = rrs.map(r => r * 1000);

  rrs = rrs.filter(r => r > 200 && r < 2500);
  if (rrs.length < 12) throw new Error(`Solo ${rrs.length} intervalos válidos. Mínimo 12.`);

  G.rrBuffer = rrs;
  rrs.forEach(r => pushSignal(r));
  $("rrFileLabel").textContent = `✓ ${file.name} (${rrs.length} RR)`;
  return rrs;
}

// ── Sesión principal ──────────────────────────────────────────────
$("btnStart").addEventListener("click", startSession);
$("btnStop").addEventListener("click",  () => stopSession(false));
$("btnSave").addEventListener("click",  saveSession);

async function startSession() {
  G.ppgBuffer   = [];
  G.rrBuffer    = [];
  G.signalBuffer= [];
  G.lastMetrics = null;
  G.totalSeconds= G.durationMin * 60;
  updateQuality(null);
  $("freqWarning").classList.remove("visible");

  const meta = SENSOR_META[G.sensor];

  try {
    if (G.sensor === "rr_upload") {
      // Cargar archivo antes del countdown
      await loadRRFile();
      await showCountdown("Analizando…", "Procesando intervalos RR importados.", "No cierres la pestaña.", 3);
      G.running = true;
      setBtns(true);
      setStatus("Analizando RR…", "ok");
      // Para RR upload, calcular inmediatamente
      await computeAndDisplay();
      G.running = false;
      setBtns(false);
      return;
    }

    await showCountdown(
      "Preparación",
      meta.guide,
      G.sensor === "polar_h10" ? "Aceptá el permiso Bluetooth cuando aparezca." : "No bloquees la pantalla.",
      5
    );

    G.running = true;
    setBtns(true);
    setStatus("Midiendo…", "ok");

    if (G.sensor === "polar_h10")   await startPolarH10();
    if (G.sensor === "camera_ppg")  await startCamera();
    if (G.sensor === "face_rppg")   await startCamera();
    if (G.sensor === "vibration_scg") startVibration();

    G.rafHandle = requestAnimationFrame(renderChart);
    startTimer();

  } catch (err) {
    G.running = false;
    setBtns(false);
    setStatus("Error al iniciar", "bad");
    console.error(err);
    alert(`Error: ${err.message}`);
  }
}

async function stopSession(autoStop = false) {
  G.running = false;
  stopTimer();

  if (G.sensor === "camera_ppg" || G.sensor === "face_rppg") stopCamera();
  if (G.sensor === "polar_h10")    stopPolarH10();
  if (G.sensor === "vibration_scg") stopVibration();

  setBtns(false);
  setStatus(autoStop ? "Midición completa" : "Detenido", autoStop ? "ok" : "warn");

  if (autoStop || G.ppgBuffer.length >= 30 || G.rrBuffer.length >= 12) {
    await computeAndDisplay();
  }
}

// ── Cómputo y envío al backend ────────────────────────────────────
async function computeAndDisplay() {
  setStatus("Calculando HRV…", "warn");

  const payload = buildPayload();

  try {
    const res  = await fetch("/api/compute", {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(payload),
    });
    const data = await res.json();

    if (data.error) {
      setStatus("Error de cálculo", "bad");
      alert(`Error HRV: ${data.error}`);
      return;
    }

    G.lastMetrics = { ...data, ...payload };
    updateDashboard(data);
    updateQuality(data.quality_score ?? null);
    setBtns(false);
    setStatus("Análisis completado", "ok");

    if (data.freq_warning) {
      $("freqWarning").textContent = `⚠ ${data.freq_warning}`;
      $("freqWarning").classList.add("visible");
    }

  } catch (err) {
    setStatus("Sin conexión al servidor", "bad");
    console.error(err);
    alert("No se pudo conectar con el servidor. ¿El backend está corriendo?");
  }
}

function buildPayload() {
  const isRR  = G.sensor === "polar_h10" || G.sensor === "rr_upload";
  const isSCG = G.sensor === "vibration_scg";

  const base = {
    sensor_type     : isRR ? G.sensor : (isSCG ? "camera_ppg" : G.sensor),
    duration_minutes: G.durationMin,
    age             : $("age").value          || null,
    sex             : $("sex").value          || null,
    patient_id      : $("patientId").value    || "",
    comorbidities   : $("comorbidities").value|| "",
    notes           : $("notes").value        || "",
  };

  if (isRR) {
    base.rri_ms = G.rrBuffer.length > 0 ? G.rrBuffer : G.ppgBuffer;
  } else if (isSCG) {
    base.ppg           = G.ppgBuffer;
    base.sampling_rate = SCG_SR;
    base.sensor_type   = "camera_ppg";  // backend trata SCG como señal genérica
  } else {
    base.ppg           = G.ppgBuffer;
    base.sampling_rate = PPG_SR;
  }

  return base;
}

// ── Dashboard — render ────────────────────────────────────────────
function updateDashboard(data) {
  const dash = data.hba_dashboard;
  if (!dash) return;

  renderSemaphore(dash.semaphore);
  renderNorms(dash.norms, data.rmssd_corr);
  renderCargas(dash.cargas);
  renderMetrics(data);
  renderBioTable(dash.biomarkers);
  renderPlan(dash.semaphore.plan);
}

function renderSemaphore(sem) {
  const card = $("semaphoreCard");
  card.className = `semaphore-card ${sem.key}`;
  $("semaphoreIcon").textContent  = sem.icon;
  $("semaphoreLabel").textContent = sem.label;
  $("semaphoreDesc").textContent  = sem.description;
}

function renderNorms(norms, rmssdCorr) {
  const sec = $("normsSection");
  if (!norms || !norms.rmssd_low) return;
  sec.style.display = "";

  $("normsRange").textContent = `${norms.rmssd_low.toFixed(0)}–${norms.rmssd_high.toFixed(0)} ms`;

  // Posicionar marcador en la barra (0% = bajo, 50% = normal, 100% = alto)
  if (rmssdCorr != null) {
    const lo  = norms.rmssd_low;
    const hi  = norms.rmssd_high;
    const mid = (lo + hi) / 2;
    let pct;
    if (rmssdCorr <= lo)  pct = Math.max(0, (rmssdCorr / lo) * 35);
    else if (rmssdCorr <= hi) pct = 35 + ((rmssdCorr - lo) / (hi - lo)) * 30;
    else pct = Math.min(100, 65 + ((rmssdCorr - hi) / (hi * 0.5)) * 35);
    $("normsMarker").style.left = `${pct}%`;
  }
}

function renderCargas(cargas) {
  const grid = $("cargasGrid");
  if (!cargas) return;

  const items = [
    { key: "carga_autonomica",  label: "Autonómica" },
    { key: "carga_emocional",   label: "Emocional"  },
    { key: "carga_fisica",      label: "Física"     },
    { key: "estres",            label: "Estrés"     },
  ];

  grid.innerHTML = items.map(it => {
    const c = cargas[it.key] || {};
    const v = c.value != null ? Math.round(c.value) : "—";
    const l = (c.level || "bajo").replace(/ /g, "-");
    const pct = c.value != null ? c.value : 0;
    return `
      <div class="carga-item">
        <div class="carga-name">${it.label}</div>
        <div class="carga-value">${v}<small style="font-size:0.5em;font-weight:400;color:var(--text-muted)"> / 100</small></div>
        <div class="carga-track"><div class="carga-fill ${l}" style="width:${pct}%"></div></div>
        <div class="carga-level ${l}">${c.level || "—"}</div>
      </div>`;
  }).join("");
}

function renderMetrics(data) {
  const grid = $("metricsGrid");
  const fmt = (v, dec=1) => (v != null && isFinite(v)) ? (+v).toFixed(dec) : "—";

  const art  = data.artifact_percent;
  const artCls = art == null ? "" : art < 10 ? "ok" : art < 25 ? "warn" : "bad";

  const items = [
    { k: "FC media",    v: fmt(data.hr_mean,  0), u: "bpm", cls: "" },
    { k: "FC max",      v: fmt(data.hr_max,   0), u: "bpm", cls: "" },
    { k: "RMSSD",       v: fmt(data.rmssd,    1), u: "ms",  cls: "" },
    { k: "RMSSD corr",  v: fmt(data.rmssd_corr,1),u:"ms",  cls: "" },
    { k: "SDNN",        v: fmt(data.sdnn,     1), u: "ms",  cls: "" },
    { k: "Calidad señal",v: fmt(data.quality_score,0), u: "%", cls: "" },
    { k: "Artefactos",  v: fmt(art, 1),           u: "%",  cls: artCls },
    { k: "N° RR",       v: data.n_rr ?? "—",      u: "",   cls: "" },
  ];

  grid.innerHTML = items.map(i =>
    `<div class="metric-mini ${i.cls}">
       <div class="metric-mini-key">${i.k}</div>
       <div class="metric-mini-val">${i.v}</div>
       <div class="metric-mini-unit">${i.u}</div>
     </div>`
  ).join("");
}

function renderBioTable(biomarkers) {
  const wrap = $("bioTableWrap");
  if (!biomarkers || !biomarkers.length) return;

  const fmt = v => (v != null && isFinite(v)) ? (+v).toFixed(2) : "—";

  const rows = biomarkers.map(b => {
    const state = b.state || "informativo";
    const stateLabel = {
      alto:"Alto", medio:"Normal", bajo:"Bajo",
      informativo:"—", insuficiente:"Insuf."
    }[state] || state;

    return `<tr>
      <td class="bio-name">${b.name}</td>
      <td class="bio-val">${fmt(b.value)} <span class="bio-unit">${b.unit || ""}</span></td>
      <td><span class="badge-state ${state}">${stateLabel}</span></td>
      <td class="bio-detail">${b.detail || ""}</td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `
    <table class="bio-table">
      <thead><tr>
        <th>Biomarcador</th>
        <th>Valor</th>
        <th>Estado</th>
        <th>Referencia / Nota</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderPlan(plan) {
  const list = $("planList");
  if (!plan || !plan.length) return;

  list.innerHTML = `<div class="plan-list">` +
    plan.map(p => `
      <div class="plan-item">
        <span class="plan-label">${p.item}</span>
        <div class="plan-pct-wrap">
          <div class="plan-track">
            <div class="plan-fill" style="width:${p.pct}%"></div>
          </div>
          <span class="plan-pct-label">${p.pct}%</span>
        </div>
      </div>`
    ).join("") + `</div>`;
}

// ── Guardar sesión ────────────────────────────────────────────────
async function saveSession() {
  if (!G.lastMetrics) return;

  const payload = {
    patient_id    : $("patientId").value     || "",
    age           : $("age").value           || null,
    sex           : $("sex").value           || null,
    comorbidities : $("comorbidities").value || "",
    notes         : $("notes").value         || "",
    metrics       : G.lastMetrics,
  };

  setStatus("Guardando…", "warn");
  try {
    const res  = await fetch("/api/save", {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.ok) {
      setStatus("Guardado ✓", "ok");
    } else {
      setStatus("Error al guardar", "bad");
    }
  } catch (err) {
    setStatus("Sin conexión", "bad");
    console.error(err);
  }
}

// ── RR file preview ───────────────────────────────────────────────
$("rrFile").addEventListener("change", async () => {
  try {
    await loadRRFile();
    setStatus(`RR cargado (${G.rrBuffer.length})`, "ok");
    updateQuality(null);
  } catch (err) {
    alert(`Error al leer archivo: ${err.message}`);
  }
});

// ── Torch toggle label ────────────────────────────────────────────
$("torchToggle").addEventListener("change", () => {
  $("torchLabel").textContent = $("torchToggle").checked ? "AUTO" : "OFF";
});

// ── Init ──────────────────────────────────────────────────────────
buildChart();
G.rafHandle = requestAnimationFrame(renderChart);
$("sensorType").dispatchEvent(new Event("change"));
setStatus("Listo");
console.log("HBA v2.0 iniciado");
