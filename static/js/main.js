/* static/js/main.js  (REEMPLAZAR COMPLETO)
   Mantiene:
   - /api/compute y /api/save
   - Polar BLE
   - Cámara dedo PPG (AC-only + rAF scheduler)
   Agrega (SIN ROMPER UI / SIN TOCAR CSS):
   - Sensor: Rostro rPPG (1 min) (FaceDetector si existe + fallback ROI centrado)
   - Sensor: Vibración SCG (1 min) (DeviceMotionEvent iOS/Android)
   - Sensor: RR por archivo (CSV/JSON) estilo Kubios
   - Guía + countdown + wake lock + beep final
*/

let selectedDurationMin = 3;
let measuring = false;
let sensorType = "camera_ppg";

let timerInterval = null;
let startedAt = null;

// Cámara (reuso del mismo video/canvas)
let mediaStream = null;
let videoEl = null;
let frameCanvas = null;
let frameCtx = null;

let ppgSamples = [];
let ppgTimestamps = [];

let targetFps = 30;
let rafId = null;

// Torch (solo dedo)
let trackRef = null;
let torchAvailable = false;
let torchEnabled = false;
let torchMode = "auto"; // "auto" | "off"

// Polar H10 BLE
let bleDevice = null;
let bleChar = null;
let rrIntervalsMs = [];
let lastMetrics = null;

// Vibración
let motionListening = false;
let vibSamples = [];
let vibTimestamps = [];
let vibLastGravity = {x:0,y:0,z:0};

// Wake lock
let wakeLockSentinel = null;

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

function setGuide(text){
  const el = document.getElementById("guideText");
  if(el) el.textContent = text;
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

  const map = {
    camera_ppg: "Sensor: Cámara (Dedo PPG)",
    face_rppg: "Sensor: Cámara (Rostro rPPG)",
    vibration_scg: "Sensor: Vibración (SCG)",
    polar_h10: "Sensor: Polar H10 (BLE)",
    rr_upload: "Sensor: RR por Archivo"
  };
  chip.textContent = map[sensorType] || "Sensor";
}

function enableControls(){
  const s = document.getElementById("btnStart");
  const t = document.getElementById("btnStop");
  const v = document.getElementById("btnSave");
  if(s) s.disabled = measuring;
  if(t) t.disabled = !measuring;
  if(v) v.disabled = measuring || !lastMetrics || !!lastMetrics.error;
}

/* ========================= Sonido (beep) ========================= */
function beep(ms=200, freq=880){
  try{
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => {
      o.stop();
      ctx.close();
    }, ms);
  }catch(_e){}
}

/* ========================= Wake Lock ========================= */
async function acquireWakeLock(){
  try{
    if("wakeLock" in navigator){
      wakeLockSentinel = await navigator.wakeLock.request("screen");
      wakeLockSentinel.addEventListener("release", () => {});
    } else {
      // no disponible, avisamos suave
    }
  }catch(_e){}
}
async function releaseWakeLock(){
  try{
    if(wakeLockSentinel){
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    }
  }catch(_e){}
}

/* ========================= Countdown Overlay ========================= */
async function runCountdown({title, text, hint, seconds=3}){
  const ov = document.getElementById("countdownOverlay");
  const t = document.getElementById("countdownTitle");
  const tx = document.getElementById("countdownText");
  const n = document.getElementById("countdownNumber");
  const h = document.getElementById("countdownHint");

  if(!ov || !t || !tx || !n || !h) return;

  t.textContent = title || "Preparación";
  tx.textContent = text || "—";
  h.textContent = hint || "—";

  ov.style.display = "flex";

  for(let i=seconds; i>=1; i--){
    n.textContent = String(i);
    beep(80, 740);
    await new Promise(r => setTimeout(r, 900));
  }

  n.textContent = "¡YA!";
  beep(160, 990);
  await new Promise(r => setTimeout(r, 350));

  ov.style.display = "none";
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

/* ========================= Chart ECG ========================= */
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
  const canvas = document.getElementById("signalChart");
  if(!canvas) return;

  chart = new Chart(canvas, {
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

/* ========================= UI setup ========================= */
function setupDurationButtons(){
  const b1 = document.getElementById("dur1");
  const b3 = document.getElementById("dur3");
  const b5 = document.getElementById("dur5");
  if(!b3 || !b5) return;

  function setActive(min){
    selectedDurationMin = min;
    if(b1) b1.classList.toggle("active", min === 1);
    b3.classList.toggle("active", min === 3);
    b5.classList.toggle("active", min === 5);
  }

  if(b1) b1.addEventListener("click", () => setActive(1));
  b3.addEventListener("click", () => setActive(3));
  b5.addEventListener("click", () => setActive(5));
}

function updateUIForSensor(){
  // hints
  const sensorHint = document.getElementById("sensorHint");
  const durHint = document.getElementById("durHint");
  const torchField = document.getElementById("torchField");
  const rrUploadField = document.getElementById("rrUploadField");

  const b1 = document.getElementById("dur1");
  const b3 = document.getElementById("dur3");
  const b5 = document.getElementById("dur5");

  // media labels
  const mediaTitle = document.getElementById("mediaTitle");
  const mediaSub = document.getElementById("mediaSub");
  const mediaNote = document.getElementById("mediaNote");
  const reticleText = document.getElementById("reticleText");

  function show1min(yes){
    if(b1) b1.style.display = yes ? "inline-flex" : "none";
  }

  if(sensorType === "camera_ppg"){
    if(sensorHint) sensorHint.textContent = "Dedo firme sobre lente. Ideal cámara trasera. Torch AUTO disponible si el dispositivo lo soporta.";
    if(durHint) durHint.textContent = "5 min recomendado para espectral (LF/HF) más estable.";
    if(torchField) torchField.style.display = "";
    if(rrUploadField) rrUploadField.style.display = "none";
    show1min(false);

    if(mediaTitle) mediaTitle.textContent = "Cámara PPG (Dedo)";
    if(mediaSub) mediaSub.textContent = "Colocá el dedo firme sobre el lente";
    if(reticleText) reticleText.textContent = "Mantener estable";
    if(mediaNote) mediaNote.textContent = "Consejo: apoyá el codo, evitá movimiento, cubrí bien el lente.";

    setGuide("Dedo firme, presión constante (sin apretar de más). Iluminación estable. Si cambia a rojo saturado, aflojá un poco.");
    // duration default to 3/5
    if(selectedDurationMin === 1) selectedDurationMin = 3;
    if(b3) b3.classList.add("active");
    if(b5) b5.classList.remove("active");
  }
  else if(sensorType === "face_rppg"){
    if(sensorHint) sensorHint.textContent = "Rostro rPPG: 1 minuto. Recomendado buena luz frontal, sin movimiento.";
    if(durHint) durHint.textContent = "Rostro usa 1 min fijo.";
    if(torchField) torchField.style.display = "none";
    if(rrUploadField) rrUploadField.style.display = "none";
    show1min(true);

    selectedDurationMin = 1;
    if(b1) b1.classList.add("active");
    if(b3) b3.classList.remove("active");
    if(b5) b5.classList.remove("active");

    if(mediaTitle) mediaTitle.textContent = "Cámara (Rostro rPPG)";
    if(mediaSub) mediaSub.textContent = "Mirada al frente • luz pareja • sin hablar";
    if(reticleText) reticleText.textContent = "Rostro centrado";
    if(mediaNote) mediaNote.textContent = "Consejo: sentate, apoyá espalda, respiración tranquila. Evitá mover cabeza y cejas.";
    setGuide("Rostro: buena luz frontal (no contraluz). No hables. No muevas la cabeza. Respiración natural.");
  }
  else if(sensorType === "vibration_scg"){
    if(sensorHint) sensorHint.textContent = "Vibración SCG: 1 minuto. Apoyá el celular en el esternón o pecho (según protocolo).";
    if(durHint) durHint.textContent = "Vibración usa 1 min fijo.";
    if(torchField) torchField.style.display = "none";
    if(rrUploadField) rrUploadField.style.display = "none";
    show1min(true);

    selectedDurationMin = 1;
    if(b1) b1.classList.add("active");
    if(b3) b3.classList.remove("active");
    if(b5) b5.classList.remove("active");

    if(mediaTitle) mediaTitle.textContent = "Vibración (SCG)";
    if(mediaSub) mediaSub.textContent = "Celular estable • sin hablar • respiración suave";
    if(reticleText) reticleText.textContent = "Sin movimiento";
    if(mediaNote) mediaNote.textContent = "Consejo: apoyá el celular firme. Evitá toser, hablar o moverte durante el minuto.";
    setGuide("Vibración: sentate cómodo. Apoyá el celular firme (sin mano temblando). No hables. Respirá suave.");
  }
  else if(sensorType === "polar_h10"){
    if(sensorHint) sensorHint.textContent = "Polar H10 requiere Web Bluetooth (Chrome/Edge) y HTTPS o localhost.";
    if(durHint) durHint.textContent = "5 min recomendado para espectral (LF/HF) más estable.";
    if(torchField) torchField.style.display = "none";
    if(rrUploadField) rrUploadField.style.display = "none";
    show1min(false);

    if(mediaTitle) mediaTitle.textContent = "Polar H10 (BLE)";
    if(mediaSub) mediaSub.textContent = "Conectá la banda y quedate quieto";
    if(reticleText) reticleText.textContent = "Estable";
    if(mediaNote) mediaNote.textContent = "Consejo: postura estable. No hables ni te muevas. Señal RR limpia = HRV mejor.";
    setGuide("Polar: colocación correcta de banda y humedad en electrodos. Quedate quieto durante toda la medición.");
    if(selectedDurationMin === 1) selectedDurationMin = 3;
  }
  else if(sensorType === "rr_upload"){
    if(sensorHint) sensorHint.textContent = "Subí RR (ms) desde archivo. Luego se calcula HRV igual que Kubios (sin streaming).";
    if(durHint) durHint.textContent = "La duración se infiere del total de RR.";
    if(torchField) torchField.style.display = "none";
    if(rrUploadField) rrUploadField.style.display = "";
    show1min(false);

    if(mediaTitle) mediaTitle.textContent = "RR por Archivo";
    if(mediaSub) mediaSub.textContent = "Cargá el archivo y luego Iniciar";
    if(reticleText) reticleText.textContent = "—";
    if(mediaNote) mediaNote.textContent = "Formato: CSV 1 columna o JSON con rri_ms.";
    setGuide("RR por archivo: elegí un CSV/JSON. Luego presioná Iniciar para calcular HRV y dashboard.");
    if(selectedDurationMin === 1) selectedDurationMin = 3;
  }

  setSensorChip();
  enableControls();
}

function setupSensorSelector(){
  const sel = document.getElementById("sensorType");
  if(!sel) return;
  sel.addEventListener("change", () => {
    sensorType = sel.value;
    setStatus("Listo", "idle");
    updateUIForSensor();
  });
}

/* ========================= Cards: métricas base ========================= */
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
    c.innerHTML = `<div class="k">Error</div><div class="v">${metrics.error}</div><div class="u">Revisá señal / permisos / iluminación</div>`;
    cards.appendChild(c);
    return;
  }

  const items = [
    {k:"HR Media", v: metrics.hr_mean, u:"bpm"},
    {k:"HR Máx", v: metrics.hr_max, u:"bpm"},
    {k:"HR Mín", v: metrics.hr_min, u:"bpm"},
    {k:"HRV (RMSSD)", v: metrics.rmssd, u:"ms"},
    {k:"SDNN", v: metrics.sdnn, u:"ms"},
    {k:"lnRMSSD", v: metrics.lnrmssd, u:""},
    {k:"pNN50", v: metrics.pnn50, u:"%"},
    {k:"Mean RR", v: metrics.mean_rr, u:"ms"},
    {k:"LF Power", v: metrics.lf_power, u:"ms²"},
    {k:"HF Power", v: metrics.hf_power, u:"ms²"},
    {k:"LF/HF", v: metrics.lf_hf, u:"ratio"},
    {k:"Total Power", v: metrics.total_power, u:"ms²"},
    {k:"Artefactos", v: metrics.artifact_percent, u:"%"},
    {k:"Resp (estim.)", v: metrics.resp_rate_rpm, u:"rpm"},
  ];

  items.forEach(it => {
    const num = typeof it.v === "number" ? it.v : Number(it.v);
    const isNum = Number.isFinite(num);
    const val =
      !isNum ? "—" :
      (it.k.startsWith("HR ") ? num.toFixed(0) :
      (it.k === "Artefactos" ? num.toFixed(1) :
      (it.k === "Resp (estim.)" ? num.toFixed(1) : num.toFixed(3))));

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

/* ========================= HBA Dashboard (ya lo tenías) ========================= */
function _stateToCardClass(state){
  const s = String(state || "").toLowerCase();
  if(s === "alto" || s === "ok" || s === "verde") return "good";
  if(s === "medio" || s === "amarillo" || s === "warn") return "warn";
  if(s === "bajo" || s === "rojo" || s === "bad") return "bad";
  return "";
}

function _fmtValue(v){
  const num = (typeof v === "number") ? v : Number(v);
  if(!Number.isFinite(num)) return "—";
  return num.toFixed(2);
}

function buildDashTiles(metrics){
  const grid = document.getElementById("dashGrid");
  if(!grid) return;
  grid.innerHTML = "";

  if(!metrics || metrics.error){
    const h = document.createElement("div");
    h.className = "hint";
    h.textContent = "Aún no hay métricas calculadas.";
    grid.appendChild(h);
    return;
  }

  const dash = metrics.hba_dashboard;
  const rm = dash?.norms?.rmssd_state || "—";
  const sem = dash?.semaphore?.color || "gris";
  const art = Number(metrics.artifact_percent);

  const hr = Number(metrics.hr_mean);
  const rmssd = Number(metrics.rmssd);

  const tile = document.createElement("div");
  tile.className = "dashTile glass neon";
  tile.innerHTML = `
    <div class="tileTop">
      <div class="tileName">Paciente</div>
      <div class="tileBadge ${art<=8 ? "ok" : (art<=18 ? "warn" : "warn")}" style="${art>18 ? "border-color: rgba(251,113,133,0.22); box-shadow: 0 0 18px rgba(251,113,133,0.10);" : ""}">
        ${metrics.error ? "Error" : "Listo"}
      </div>
    </div>

    <div class="tileMid">
      <div class="miniStat"><span>HR</span><strong>${Number.isFinite(hr) ? hr.toFixed(0) : "—"}</strong></div>
      <div class="miniStat"><span>RMSSD</span><strong>${Number.isFinite(rmssd) ? rmssd.toFixed(0) : "—"}</strong></div>
      <div class="miniStat"><span>Artef.</span><strong>${Number.isFinite(art) ? art.toFixed(0) : "—"}</strong></div>
    </div>

    <div class="miniStat" style="margin-top:2px;">
      <span>Semáforo</span>
      <strong style="text-transform:uppercase">${String(sem)}</strong>
    </div>

    <div class="miniStat">
      <span>HRV estado (edad)</span>
      <strong style="text-transform:uppercase">${String(rm)}</strong>
    </div>

    <div class="tileBar"><span class="tileBarFill" style="width:${Number.isFinite(art)? Math.max(5, Math.min(100, 100-art)) : 35}%;"></span></div>
  `;
  grid.appendChild(tile);
}

function buildHBADashboard(metrics){
  const bio = document.getElementById("bioCards");
  const meaning = document.getElementById("meaningCards");
  const norms = document.getElementById("normsCards");
  const sema = document.getElementById("semaforoCards");

  if(bio) bio.innerHTML = "";
  if(meaning) meaning.innerHTML = "";
  if(norms) norms.innerHTML = "";
  if(sema) sema.innerHTML = "";

  if(!metrics || metrics.error){
    if(bio){
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = "Aún no hay biomarcadores.";
      bio.appendChild(h);
    }
    return;
  }

  const dash = metrics.hba_dashboard;
  if(!dash){
    if(bio){
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = "Dashboard HBA no disponible (backend no lo devolvió).";
      bio.appendChild(h);
    }
    return;
  }

  const list = Array.isArray(dash.biomarkers) ? dash.biomarkers : [];
  if(bio){
    if(!list.length){
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = "No hay biomarcadores para mostrar.";
      bio.appendChild(h);
    } else {
      list.forEach(bm => {
        const cls = _stateToCardClass(bm.state);
        const c = document.createElement("div");
        c.className = `card ${cls}`;
        const val = _fmtValue(bm.value);
        const unit = bm.unit ? String(bm.unit) : "";
        const st = bm.state ? String(bm.state).toUpperCase() : "—";
        const detail = bm.detail ? String(bm.detail) : "";

        c.innerHTML = `
          <div class="k">${bm.name}</div>
          <div class="v">${val}</div>
          <div class="u">${unit} • Estado: <b>${st}</b>${detail ? " • " + detail : ""}</div>
        `;
        bio.appendChild(c);
      });
    }
  }

  const meanings = Array.isArray(dash.interpretation) ? dash.interpretation : [];
  if(meaning){
    if(!meanings.length){
      const h = document.createElement("div");
      h.className = "hint";
      h.textContent = "Sin definiciones.";
      meaning.appendChild(h);
    } else {
      meanings.forEach(m => {
        const c = document.createElement("div");
        c.className = "card";
        c.innerHTML = `
          <div class="k">${m.biomarker}</div>
          <div class="v" style="font-size: clamp(16px, 1.8vw, 20px);">Guía</div>
          <div class="u">${m.meaning}</div>
        `;
        meaning.appendChild(c);
      });
    }
  }

  if(norms){
    const n = dash.norms || {};
    const low = Number(n.rmssd_low);
    const high = Number(n.rmssd_high);
    const state = String(n.rmssd_state || "—").toUpperCase();
    const age = n.age ?? "—";
    const sex = n.sex ?? "—";

    const c = document.createElement("div");
    c.className = `card ${_stateToCardClass(String(n.rmssd_state||""))}`;
    c.innerHTML = `
      <div class="k">Referencia RMSSD (edad/sexo)</div>
      <div class="v">${Number.isFinite(low) ? low.toFixed(0) : "—"} – ${Number.isFinite(high) ? high.toFixed(0) : "—"}</div>
      <div class="u">Edad: <b>${age}</b> • Sexo: <b>${sex}</b> • Estado: <b>${state}</b></div>
    `;
    norms.appendChild(c);
  }

  if(sema){
    const s = dash.semaphore || {};
    const color = String(s.color || "gris").toUpperCase();
    const plan = Array.isArray(s.plan) ? s.plan : [];

    const cls = _stateToCardClass(String(dash.norms?.rmssd_state || ""));
    const c = document.createElement("div");
    c.className = `card ${cls}`;
    const itemsHtml = plan.map(p => {
      const pct = Number(p.pct);
      return `<div class="u" style="margin-top:6px;">• <b>${Number.isFinite(pct) ? pct : "—"}%</b> ${p.item}</div>`;
    }).join("");

    c.innerHTML = `
      <div class="k">Semáforo HBA</div>
      <div class="v" style="text-transform:uppercase">${color}</div>
      <div class="u">Plan según RMSSD (edad/sexo):</div>
      ${itemsHtml || `<div class="u">—</div>`}
      <div class="u" style="margin-top:10px;"><b>Diferenciador:</b> ${dash.differentiator?.what_distinguishes || "Semáforo HBA"}</div>
    `;
    sema.appendChild(c);
  }
}

/* ========================= Torch helpers (solo dedo) ========================= */
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

/* ========================= ROI channel mean ========================= */
function meanChannelROI(img, channelIndex /*0=R,1=G,2=B*/){
  let sum = 0;
  for(let i=0; i<img.length; i+=4) sum += img[i + channelIndex];
  return sum / (img.length / 4);
}

/* ========================= Robust preprocesado (reuso) ========================= */
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
   Cámara dedo PPG (como estaba)
========================================================== */
async function startCameraFingerPPG(){
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

  setStatus("Cámara activa • recolectando PPG (dedo)", "ok");

  // ---------- estados de filtro en vivo ----------
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
      const meanR = meanChannelROI(img, 0);

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

      let acSig = meanR - baseline;
      let norm = 0;
      if(baseline > 12) norm = acSig / baseline;

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
            let vv = 0;
            for(const x of rr) vv += (x-m)*(x-m);
            const sd = Math.sqrt(vv/rr.length);
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

async function stopCamera(){
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
}

/* ==========================================================
   Rostro rPPG (1 min)
   - FaceDetector si existe (Chrome/Android)
   - Fallback ROI centrado (parte superior/central del frame)
   - Extrae canal VERDE (mejor SNR típico en rPPG)
========================================================== */
async function startFaceRPPG(){
  videoEl = document.getElementById("video");
  frameCanvas = document.getElementById("frameCanvas");
  if(!videoEl || !frameCanvas) throw new Error("Faltan elementos de cámara en el DOM.");

  frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });

  ppgSamples = [];
  ppgTimestamps = [];
  setQuality(null);

  setStatus("Solicitando permiso de cámara (frontal)…", "warn");

  try{
    mediaStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "user" },
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

  // ROI dinámico: intentamos FaceDetector
  let faceDetector = null;
  if("FaceDetector" in window){
    try{
      faceDetector = new window.FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
    }catch(_e){
      faceDetector = null;
    }
  }

  // canvas del ROI (tamaño fijo chico)
  const roiW = 80, roiH = 80;
  frameCanvas.width = roiW;
  frameCanvas.height = roiH;

  setStatus("Cámara frontal activa • recolectando rPPG", "ok");

  // filtro simple en vivo
  let baseline = null;
  const dcAlpha = 0.02;
  let hpState = 0;
  let prevNorm = null;
  const hpAlpha = 0.96;
  let lpState = 0;
  const lpAlpha = 0.20;

  const framePeriod = 1000 / targetFps;
  let lastTick = performance.now();
  let acc = 0;

  const loop = async (now) => {
    if(!measuring) return;

    acc += (now - lastTick);
    lastTick = now;

    let steps = 0;
    while(acc >= framePeriod && steps < 2){
      acc -= framePeriod;
      steps++;

      const vw = videoEl.videoWidth;
      const vh = videoEl.videoHeight;

      // ROI por defecto (fallback): centro superior (mejores mejillas/frente)
      let sx = (vw / 2) - (roiW / 2);
      let sy = (vh * 0.30) - (roiH / 2);

      // si FaceDetector existe, intentamos localizar cara y usar frente/mejillas
      if(faceDetector){
        try{
          const tmpCanvas = document.createElement("canvas");
          tmpCanvas.width = vw;
          tmpCanvas.height = vh;
          const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });
          tmpCtx.drawImage(videoEl, 0, 0, vw, vh);
          const faces = await faceDetector.detect(tmpCanvas);
          if(faces && faces.length){
            const box = faces[0].boundingBox;
            // ROI: región superior-central de la cara (frente)
            sx = box.x + box.width * 0.30;
            sy = box.y + box.height * 0.18;
          }
        }catch(_e){}
      }

      // clamp para no salir del frame
      sx = Math.max(0, Math.min(vw - roiW, sx));
      sy = Math.max(0, Math.min(vh - roiH, sy));

      frameCtx.drawImage(videoEl, sx, sy, roiW, roiH, 0, 0, roiW, roiH);
      const img = frameCtx.getImageData(0, 0, roiW, roiH).data;

      // canal VERDE
      const meanG = meanChannelROI(img, 1);

      if(baseline === null) baseline = meanG;
      baseline = (1 - dcAlpha) * baseline + dcAlpha * meanG;

      let acSig = meanG - baseline;
      let norm = 0;
      if(baseline > 12) norm = acSig / baseline;

      if(prevNorm === null) prevNorm = norm;
      hpState = hpAlpha * (hpState + norm - prevNorm);
      prevNorm = norm;

      lpState = lpState + lpAlpha * (hpState - lpState);

      let clean = lpState;
      if(clean > 0.08) clean = 0.08;
      if(clean < -0.08) clean = -0.08;

      ppgTimestamps.push(performance.now());
      ppgSamples.push(clean);

      pushChartPoint(clean * 220);

      // calidad simple por amplitud local
      if(ppgSamples.length > 60){
        const w = ppgSamples.slice(-60);
        let mn = Infinity, mx = -Infinity;
        for(const v of w){ if(v < mn) mn=v; if(v > mx) mx=v; }
        const p2p = mx - mn;
        const score = 100 * Math.max(0, Math.min(1, (p2p - 0.0025) / 0.012));
        setQuality(score);

        if(score < 35){
          setStatus("Señal baja • más luz frontal • no muevas la cabeza", "warn");
        } else if(score < 70){
          setStatus("Señal media • quedate quieto • no hables", "warn");
        } else {
          setStatus("Señal estable • excelente", "ok");
        }
      }
    }

    rafId = requestAnimationFrame(loop);
  };

  rafId = requestAnimationFrame(loop);
}

/* ==========================================================
   Vibración SCG (1 min) - DeviceMotionEvent
========================================================== */
async function requestMotionPermissionIfNeeded(){
  // iOS requiere gesto usuario + requestPermission
  if(typeof DeviceMotionEvent !== "undefined" && typeof DeviceMotionEvent.requestPermission === "function"){
    const res = await DeviceMotionEvent.requestPermission();
    if(res !== "granted"){
      throw new Error("Permiso de movimiento denegado. Activá 'Movimiento y orientación' y reintentá.");
    }
  }
}

function startVibration(){
  vibSamples = [];
  vibTimestamps = [];
  motionListening = true;

  const handler = (ev) => {
    if(!measuring || !motionListening) return;

    const a = ev.acceleration || ev.accelerationIncludingGravity;

    // si viene null, abort suave
    if(!a) return;

    // magnitud (robusta al eje)
    const ax = Number(a.x) || 0;
    const ay = Number(a.y) || 0;
    const az = Number(a.z) || 0;
    const mag = Math.sqrt(ax*ax + ay*ay + az*az);

    vibTimestamps.push(performance.now());
    vibSamples.push(mag);

    // chart (escala)
    pushChartPoint(mag * 18);
  };

  window.addEventListener("devicemotion", handler, { passive: true });

  // guardamos para poder remover
  startVibration._handler = handler;

  setStatus("Vibración activa • recolectando acelerómetro", "ok");
  setQuality(null);
}

function stopVibration(){
  motionListening = false;
  const handler = startVibration._handler;
  if(handler){
    window.removeEventListener("devicemotion", handler);
    startVibration._handler = null;
  }
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

/* ========================= RR Upload ========================= */
function parseCSVtoNumbers(text){
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const nums = [];
  for(const ln of lines){
    // separadores comunes
    const parts = ln.split(/[;, \t]+/).filter(Boolean);
    if(!parts.length) continue;
    const v = Number(parts[0]);
    if(Number.isFinite(v)) nums.push(v);
  }
  return nums;
}

async function loadRRFromFile(file){
  const txt = await file.text();
  const name = (file.name || "").toLowerCase();

  // JSON
  if(name.endsWith(".json") || file.type.includes("json")){
    let obj = null;
    try{ obj = JSON.parse(txt); }catch(_e){ throw new Error("JSON inválido."); }

    if(Array.isArray(obj)){
      return obj.map(Number).filter(Number.isFinite);
    }
    if(obj && Array.isArray(obj.rri_ms)){
      return obj.rri_ms.map(Number).filter(Number.isFinite);
    }
    if(obj && Array.isArray(obj.rr)){
      return obj.rr.map(Number).filter(Number.isFinite);
    }
    throw new Error("JSON: se espera array o {rri_ms:[...] }.");
  }

  // CSV
  const nums = parseCSVtoNumbers(txt);
  if(!nums.length) throw new Error("CSV vacío o sin números.");

  return nums;
}

function normalizeRRUnits(rr){
  // si parece segundos (valores típicos 0.3–2.2), pasamos a ms
  const med = rr.slice().sort((a,b)=>a-b)[Math.floor(rr.length/2)];
  if(med > 0 && med < 10) return rr.map(v => v * 1000.0);
  return rr;
}

/* ========================= Measurement ========================= */
async function startMeasurement(){
  lastMetrics = null;

  buildCards(null);
  buildDashTiles(null);
  buildHBADashboard(null);

  measuring = true;
  startedAt = Date.now();
  enableControls();
  setSensorChip();

  if(chart){
    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.update("none");
  }

  // anti-lock screen si se puede
  await acquireWakeLock();

  // countdown según sensor
  if(sensorType === "face_rppg"){
    selectedDurationMin = 1;
    await runCountdown({
      title: "Rostro rPPG",
      text: "Sentate • mirá al frente • no hables • no muevas la cabeza.",
      hint: "Luz frontal pareja. Evitá contraluz.",
      seconds: 3
    });
  }
  if(sensorType === "vibration_scg"){
    selectedDurationMin = 1;
    await runCountdown({
      title: "Vibración SCG",
      text: "Celular estable • postura cómoda • respiración suave.",
      hint: "Desactivá bloqueo automático si tu navegador no soporta Wake Lock.",
      seconds: 3
    });
  }

  if(timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(async () => {
    setTimerText();
    const elapsedSec = Math.floor((Date.now() - startedAt)/1000);
    if(elapsedSec >= selectedDurationMin * 60){
      await stopMeasurement(true);
    }
  }, 250);

  if(sensorType === "camera_ppg"){
    await startCameraFingerPPG();
    return;
  }

  if(sensorType === "face_rppg"){
    await startFaceRPPG();
    return;
  }

  if(sensorType === "vibration_scg"){
    await requestMotionPermissionIfNeeded();
    startVibration();
    return;
  }

  if(sensorType === "polar_h10"){
    await startPolarH10();
    return;
  }

  if(sensorType === "rr_upload"){
    // modo “sin streaming”: calcula directo
    await computeFromRRUpload();
    // no se mide en vivo
    await stopMeasurement(false, {skipStopSensors:true, skipBeep:true, alreadyStopped:true});
    return;
  }
}

async function stopMeasurement(autoStop=false, opts={}){
  if(!measuring && !opts.alreadyStopped) return;

  // cortamos timer
  if(timerInterval){
    clearInterval(timerInterval);
    timerInterval = null;
  }
  setTimerText();

  // detener sensores (salvo rr_upload)
  if(!opts.skipStopSensors){
    if(sensorType === "camera_ppg" || sensorType === "face_rppg"){
      await stopCamera();
    } else if(sensorType === "vibration_scg"){
      stopVibration();
    } else if(sensorType === "polar_h10"){
      await stopPolarH10();
    }
  }

  // estado
  if(!opts.alreadyStopped){
    measuring = false;
    enableControls();
  }

  // release wakelock
  await releaseWakeLock();

  // beep fin si fue automático por tiempo
  if(autoStop && !opts.skipBeep){
    beep(240, 880);
    setTimeout(() => beep(240, 660), 260);
  }

  // si rr_upload ya calculó, no recalculamos
  if(sensorType === "rr_upload"){
    measuring = false;
    enableControls();
    return;
  }

  setStatus("Procesando HRV…", "warn");

  const payload = {
    sensor_type: sensorType,
    duration_minutes: selectedDurationMin,
    age: document.getElementById("age")?.value || ""
  };

  if(sensorType === "camera_ppg" || sensorType === "face_rppg"){
    // sampling rate estimado desde timestamps
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
  }
  else if(sensorType === "vibration_scg"){
    // sampling rate desde timestamps
    let fs = 60;
    if(vibTimestamps.length > 10){
      const diffs = [];
      for(let i=1; i<vibTimestamps.length; i++){
        diffs.push((vibTimestamps[i] - vibTimestamps[i-1]) / 1000.0);
      }
      const meanDt = diffs.reduce((a,b)=>a+b,0) / diffs.length;
      if(meanDt > 0) fs = 1.0 / meanDt;
    }
    payload.accel_mag = vibSamples;
    payload.sampling_rate = fs;
  }
  else if(sensorType === "polar_h10"){
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
    buildDashTiles(metrics);
    buildHBADashboard(metrics);

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
    buildDashTiles(lastMetrics);
    buildHBADashboard(lastMetrics);
    setStatus("Fallo comunicando con servidor", "bad");
  }

  measuring = false;
  enableControls();
}

async function computeFromRRUpload(){
  const fileInput = document.getElementById("rrFile");
  const file = fileInput?.files?.[0];
  if(!file) throw new Error("Elegí un archivo CSV/JSON con RR.");

  setStatus("Leyendo RR del archivo…", "warn");

  let rr = await loadRRFromFile(file);
  rr = rr.map(Number).filter(Number.isFinite);
  rr = normalizeRRUnits(rr);

  if(rr.length < 12){
    throw new Error("RR insuficientes en el archivo (mínimo recomendado: 12).");
  }

  // duración inferida por suma RR
  const totalMs = rr.reduce((a,b)=>a+b,0);
  const inferredMin = totalMs / 60000.0;

  const payload = {
    sensor_type: "rr_upload",
    duration_minutes: inferredMin,
    rri_ms: rr,
    age: document.getElementById("age")?.value || ""
  };

  try{
    const res = await fetch("/api/compute", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const metrics = await res.json();
    lastMetrics = metrics;

    buildCards(metrics);
    buildDashTiles(metrics);
    buildHBADashboard(metrics);

    if(metrics.error){
      setStatus("Error en cálculo (archivo RR)", "bad");
    } else {
      setStatus("Cálculo OK (archivo RR)", "ok");
      beep(200, 880);
    }
  }catch(e){
    lastMetrics = { error: e.message || String(e) };
    buildCards(lastMetrics);
    buildDashTiles(lastMetrics);
    buildHBADashboard(lastMetrics);
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
  buildCards(null);
  buildDashTiles(null);
  buildHBADashboard(null);
  setQuality(null);
  setTimerText();
  setStatus("Listo", "idle");

  // torch toggle
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
  }

  // RR file hint immediate
  const rrFile = document.getElementById("rrFile");
  if(rrFile){
    rrFile.addEventListener("change", () => {
      if(rrFile.files && rrFile.files[0]){
        setStatus("Archivo RR listo. Presioná Iniciar.", "ok");
      }
    });
  }

  // sensor UI initial
  updateUIForSensor();

  document.getElementById("btnStart").addEventListener("click", async () => {
    if(measuring) return;
    try{
      await startMeasurement();
    }catch(e){
      measuring = false;
      enableControls();
      await releaseWakeLock();
      setStatus(e.message || String(e), "bad");
    }
  });

  document.getElementById("btnStop").addEventListener("click", async () => {
    await stopMeasurement(false);
  });

  document.getElementById("btnSave").addEventListener("click", async () => {
    await saveResult();
  });
});
