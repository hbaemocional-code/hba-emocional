import os
from datetime import datetime

import numpy as np
import pandas as pd
from flask import Flask, render_template, request, jsonify
import neurokit2 as nk
from scipy import interpolate
from scipy.signal import butter, filtfilt

app = Flask(__name__)

# ============================
# Persistencia CSV (Render-safe)
# ============================
DATASET_DIR = os.environ.get("DATASET_DIR", "").strip()
if DATASET_DIR:
    os.makedirs(DATASET_DIR, exist_ok=True)
DATASET_FILE = os.path.join(DATASET_DIR, "dataset_hba.csv") if DATASET_DIR else "dataset_hba.csv"

# ============================
# Utilidades
# ============================

def _as_float(x):
    try:
        if x is None or x == "":
            return np.nan
        return float(x)
    except Exception:
        return np.nan


def _finite_array(x):
    x = np.asarray(x, dtype=float)
    return x[np.isfinite(x)]


def sanitize_for_json(obj):
    """JSON no permite NaN/Inf. Convertimos a None (null)."""
    if obj is None:
        return None

    if isinstance(obj, (np.generic,)):
        obj = obj.item()

    if isinstance(obj, float):
        if not np.isfinite(obj):
            return None
        return obj

    if isinstance(obj, (int, bool, str)):
        return obj

    if isinstance(obj, dict):
        return {str(k): sanitize_for_json(v) for k, v in obj.items()}

    if isinstance(obj, (list, tuple)):
        return [sanitize_for_json(v) for v in obj]

    try:
        if pd.isna(obj):
            return None
    except Exception:
        pass

    return obj


# ============================
# Calidad RR + Corrección
# ============================

def clean_rri_ms(rri_ms: np.ndarray):
    """
    Limpieza/corrección RR (ms):
    - Rango fisiológico 300–2000
    - Outliers MAD
    - Interpolación lineal para corregir
    """
    rri_ms = _finite_array(rri_ms)

    if len(rri_ms) < 10:
        return rri_ms, np.nan, np.zeros(len(rri_ms), dtype=bool)

    bad = (rri_ms < 300) | (rri_ms > 2000)

    base = rri_ms[~bad] if np.any(~bad) else rri_ms
    med = np.median(base)
    mad = np.median(np.abs(base - med)) + 1e-9

    robust_z = 0.6745 * (rri_ms - med) / mad
    bad = bad | (np.abs(robust_z) > 3.5)

    artifact_percent = 100.0 * (np.sum(bad) / len(rri_ms))

    if not np.any(bad):
        return rri_ms, artifact_percent, bad

    idx = np.arange(len(rri_ms))
    good_idx = idx[~bad]
    if len(good_idx) < 3:
        return rri_ms, artifact_percent, bad

    f = interpolate.interp1d(
        good_idx, rri_ms[~bad], kind="linear",
        fill_value="extrapolate", bounds_error=False
    )
    rri_clean = rri_ms.copy()
    rri_clean[bad] = f(idx[bad])

    return rri_clean, artifact_percent, bad


def rri_to_peaks(rri_ms: np.ndarray, sampling_rate=1000):
    rri_ms = _finite_array(rri_ms)
    if len(rri_ms) < 3:
        return None

    peak_times_s = np.cumsum(rri_ms) / 1000.0
    peak_samples = np.unique(np.round(peak_times_s * sampling_rate).astype(int))
    if len(peak_samples) < 3:
        return None

    length = int(peak_samples[-1] + sampling_rate)
    peaks = np.zeros(length, dtype=int)
    peaks[peak_samples] = 1
    return peaks


def peaks_to_rri_ms(peaks: np.ndarray, sampling_rate: float):
    peaks = np.asarray(peaks)
    idx = np.where(peaks == 1)[0]
    if len(idx) < 3:
        return np.array([], dtype=float)
    rri_s = np.diff(idx) / float(sampling_rate)
    return rri_s * 1000.0


def hrv_score_from_lnrmssd(lnrmssd: float):
    """Score 0–100 SOLO para Polar (heurístico)."""
    if lnrmssd is None or not np.isfinite(lnrmssd):
        return np.nan
    score = (lnrmssd - 2.5) / (5.0 - 2.5) * 100.0
    return float(np.clip(score, 0.0, 100.0))


def resp_rate_from_hf_peak(hrv_freq_df: pd.DataFrame):
    try:
        if "HRV_HF_Peak" in hrv_freq_df.columns:
            hf_peak_hz = _as_float(hrv_freq_df["HRV_HF_Peak"].iloc[0])
            if np.isfinite(hf_peak_hz) and hf_peak_hz > 0:
                return hf_peak_hz * 60.0
    except Exception:
        pass
    return np.nan


# ============================
# HRV Core (RR limpio)
# ============================

def _compute_hrv_from_clean_rri(rri_clean: np.ndarray, artifact_percent: float, duration_minutes=None):
    try:
        hrv_time = nk.hrv_time(rri=rri_clean, show=False)
        hrv_freq = nk.hrv_frequency(rri=rri_clean, show=False)
    except Exception:
        peaks = rri_to_peaks(rri_clean, sampling_rate=1000)
        if peaks is None:
            return {
                "error": "No se pudo construir tren de picos desde RR limpio.",
                "artifact_percent": artifact_percent,
                "n_rr": int(len(rri_clean)),
            }
        hrv_time = nk.hrv_time(peaks, sampling_rate=1000, show=False)
        hrv_freq = nk.hrv_frequency(peaks, sampling_rate=1000, show=False)

    def g(df, key):
        try:
            return _as_float(df[key].iloc[0])
        except Exception:
            return np.nan

    rmssd = g(hrv_time, "HRV_RMSSD")
    sdnn = g(hrv_time, "HRV_SDNN")
    pnn50 = g(hrv_time, "HRV_pNN50")
    mean_rr = g(hrv_time, "HRV_MeanNN")
    lnrmssd = np.log(rmssd) if np.isfinite(rmssd) and rmssd > 0 else np.nan

    lf = g(hrv_freq, "HRV_LF")
    hf = g(hrv_freq, "HRV_HF")
    tp = g(hrv_freq, "HRV_TP")
    lfhf = (lf / hf) if np.isfinite(lf) and np.isfinite(hf) and hf > 0 else np.nan

    hr_series = 60000.0 / rri_clean
    hr_series = hr_series[np.isfinite(hr_series)]
    hr_mean_bpm = float(np.mean(hr_series)) if len(hr_series) else np.nan
    hr_min_bpm = float(np.min(hr_series)) if len(hr_series) else np.nan
    hr_max_bpm = float(np.max(hr_series)) if len(hr_series) else np.nan

    resp_rate_rpm = resp_rate_from_hf_peak(hrv_freq)

    freq_warning = None
    if duration_minutes is not None:
        try:
            dm = float(duration_minutes)
            if dm < 5:
                freq_warning = "Segmento < 5 min: LF/HF y potencia espectral pueden ser menos estables."
        except Exception:
            pass

    return {
        "rmssd": rmssd,
        "sdnn": sdnn,
        "lnrmssd": lnrmssd,
        "pnn50": pnn50,
        "mean_rr": mean_rr,
        "lf_power": lf,
        "hf_power": hf,
        "lf_hf": lfhf,
        "total_power": tp,
        "artifact_percent": artifact_percent,
        "n_rr": int(len(rri_clean)),
        "freq_warning": freq_warning,
        "hr_mean_bpm": hr_mean_bpm,
        "hr_min_bpm": hr_min_bpm,
        "hr_max_bpm": hr_max_bpm,
        "resp_rate_rpm": resp_rate_rpm,
    }


# ============================
# HRV por sensor
# ============================

def compute_hrv_from_rri_polar(rri_ms: np.ndarray, duration_minutes=None):
    rri_ms = _finite_array(rri_ms)
    if len(rri_ms) < 20:
        return {"error": "Polar: Insuficientes RR (mínimo recomendado: 20).", "artifact_percent": np.nan, "n_rr": 0}

    rri_clean, artifact_percent, _ = clean_rri_ms(rri_ms)
    out = _compute_hrv_from_clean_rri(rri_clean, artifact_percent, duration_minutes=duration_minutes)

    out["hrv_score"] = hrv_score_from_lnrmssd(out.get("lnrmssd", np.nan))
    out["ppg_valid"] = None
    out["ppg_quality"] = None
    return out


def compute_hrv_from_rri_garmin(rri_ms: np.ndarray, duration_minutes=None):
    rri_ms = _finite_array(rri_ms)
    if len(rri_ms) < 20:
        return {"error": "Garmin: Insuficientes RR (mínimo recomendado: 20).", "artifact_percent": np.nan, "n_rr": 0}

    rri_clean, artifact_percent, _ = clean_rri_ms(rri_ms)

    # Garmin separado: hoy mismo cleaning, mañana lo ajustás sin tocar Polar.
    if np.isfinite(artifact_percent) and artifact_percent > 30.0:
        return {
            "error": "Garmin: Calidad RR baja (artefactos > 30%). Ajustá banda/posición y repetí.",
            "artifact_percent": artifact_percent,
            "n_rr": int(len(rri_clean)),
            "hrv_score": None,
            "ppg_valid": None,
            "ppg_quality": None
        }

    out = _compute_hrv_from_clean_rri(rri_clean, artifact_percent, duration_minutes=duration_minutes)
    out["hrv_score"] = None
    out["ppg_valid"] = None
    out["ppg_quality"] = None
    return out


def _bandpass_ppg(x, fs, low=0.7, high=4.0, order=3):
    """
    Banda típica PPG: 0.7–4.0 Hz (~42–240 bpm).
    """
    x = np.asarray(x, dtype=float)
    if len(x) < int(fs * 10):
        return x
    nyq = 0.5 * fs
    lowc = max(low / nyq, 1e-4)
    highc = min(high / nyq, 0.999)
    if highc <= lowc:
        return x
    b, a = butter(order, [lowc, highc], btype="band")
    return filtfilt(b, a, x)


def compute_hrv_from_ppg(ppg: np.ndarray, sampling_rate: float, duration_minutes=None):
    """
    NUEVO (robusto, menos rígido):
    - Preprocesa: detrend/normaliza + bandpass 0.7–4 Hz
    - Detecta picos de forma más robusta
    - Construye RR y SIEMPRE devuelve FC si hay RR suficiente
    - HRV SOLO si calidad aceptable, pero sin bloquear la toma
    """
    ppg = _finite_array(ppg)

    if sampling_rate is None or not np.isfinite(sampling_rate) or sampling_rate <= 5:
        return {"error": "sampling_rate inválido.", "ppg_valid": False, "ppg_quality": None, "n_rr": 0}

    # cámara: mínimo razonable para poder sacar FC (no HRV espectral estable)
    if len(ppg) < int(sampling_rate * 20):
        return {"error": "PPG insuficiente (<20s).", "ppg_valid": False, "ppg_quality": None, "n_rr": 0}

    # Normalización robusta (evita que la señal “chica” parezca plana)
    ppg = ppg - np.nanmedian(ppg)
    mad = np.nanmedian(np.abs(ppg - np.nanmedian(ppg))) + 1e-9
    ppg = ppg / mad

    # Filtrado banda cardíaca
    try:
        ppg_f = _bandpass_ppg(ppg, sampling_rate, low=0.7, high=4.0, order=3)
    except Exception:
        ppg_f = ppg

    # Detectar picos (más tolerante)
    peaks = None
    try:
        _, info = nk.ppg_process(ppg_f, sampling_rate=sampling_rate)
        peaks = info.get("PPG_Peaks", None)
    except Exception:
        peaks = None

    if peaks is None:
        try:
            peaks, _ = nk.ppg_peaks(ppg_f, sampling_rate=sampling_rate)
        except Exception:
            # fallback más genérico
            try:
                peaks, _ = nk.signal_findpeaks(ppg_f, sampling_rate=sampling_rate, method="nabian2018")
                peaks = peaks.get("Peaks", None)
            except Exception:
                peaks = None

    if peaks is None:
        return {"error": "PPG: no se detectaron picos. Probá dedo más firme y torch.", "ppg_valid": False, "ppg_quality": None, "n_rr": 0}

    # Fix peaks (si se puede)
    try:
        fixed = nk.signal_fixpeaks(peaks, sampling_rate=sampling_rate, iterative=True, show=False)
        peaks = np.asarray(fixed["Peaks"])
    except Exception:
        peaks = np.asarray(peaks)

    # Peaks -> RR
    rri_est = peaks_to_rri_ms(peaks, sampling_rate=float(sampling_rate))
    rri_est = _finite_array(rri_est)

    if len(rri_est) < 10:
        return {"error": "PPG: RR insuficiente. Ajustá dedo/torch y repetí.", "ppg_valid": False, "ppg_quality": None, "n_rr": int(len(rri_est))}

    # Clean RR
    rri_clean, artifact_percent, _ = clean_rri_ms(rri_est)

    # Siempre devolver FC si hay RR
    hr_series = 60000.0 / rri_clean
    hr_series = hr_series[np.isfinite(hr_series)]
    hr_mean_bpm = float(np.mean(hr_series)) if len(hr_series) else np.nan
    hr_min_bpm = float(np.min(hr_series)) if len(hr_series) else np.nan
    hr_max_bpm = float(np.max(hr_series)) if len(hr_series) else np.nan

    # Quality / validez (MUCHO menos rígido)
    # - antes cortábamos en 20%: ahora dejamos 35% para HRV básica
    ppg_quality = None
    if np.isfinite(artifact_percent):
        ppg_quality = float(np.clip(100.0 - artifact_percent, 0.0, 100.0))

    ppg_valid = True
    if np.isfinite(artifact_percent) and artifact_percent > 35.0:
        ppg_valid = False

    # Si FC es absurda, no damos HRV (pero sí devolvemos FC y el motivo)
    if np.isfinite(hr_mean_bpm) and (hr_mean_bpm < 35.0 or hr_mean_bpm > 180.0):
        return {
            "error": "PPG: FC fuera de rango → picos inestables. Repetí con dedo fijo.",
            "artifact_percent": artifact_percent,
            "n_rr": int(len(rri_clean)),
            "hr_mean_bpm": hr_mean_bpm,
            "hr_min_bpm": hr_min_bpm,
            "hr_max_bpm": hr_max_bpm,
            "ppg_valid": False,
            "ppg_quality": ppg_quality,
            "hrv_score": None,
            "resp_rate_rpm": None,
            "freq_warning": "PPG no confiable para HRV."
        }

    # Si no es válido, devolvemos FC + calidad, pero NO HRV
    if not ppg_valid:
        return {
            "error": "PPG: señal ruidosa (artefactos altos). Se reporta FC pero HRV no confiable.",
            "artifact_percent": artifact_percent,
            "n_rr": int(len(rri_clean)),
            "hr_mean_bpm": hr_mean_bpm,
            "hr_min_bpm": hr_min_bpm,
            "hr_max_bpm": hr_max_bpm,
            "ppg_valid": False,
            "ppg_quality": ppg_quality,
            "hrv_score": None,
            "resp_rate_rpm": None,
            "freq_warning": "PPG ruidosa: HRV bloqueado por calidad."
        }

    # Si es válido: HRV completo
    out = _compute_hrv_from_clean_rri(rri_clean, artifact_percent, duration_minutes=duration_minutes)
    out["ppg_valid"] = True
    out["ppg_quality"] = ppg_quality
    out["hrv_score"] = None
    return out


# ============================
# Persistencia CSV
# ============================

CSV_COLUMNS = [
    "timestamp_utc",
    "student_id",
    "age",
    "comorbidities",
    "sensor_type",
    "rr_source",
    "device_name",
    "duration_minutes",

    "rmssd",
    "sdnn",
    "lnrmssd",
    "pnn50",
    "mean_rr",
    "lf_power",
    "hf_power",
    "lf_hf",
    "total_power",
    "artifact_percent",
    "n_rr",
    "freq_warning",

    "hr_mean_bpm",
    "hr_min_bpm",
    "hr_max_bpm",
    "hrv_score",
    "resp_rate_rpm",

    "ppg_valid",
    "ppg_quality",

    "notes",
]


def append_to_dataset(row: dict):
    df_row = pd.DataFrame([{c: row.get(c, "") for c in CSV_COLUMNS}])

    if os.path.exists(DATASET_FILE):
        df = pd.read_csv(DATASET_FILE)
        for c in CSV_COLUMNS:
            if c not in df.columns:
                df[c] = ""
        df = df[CSV_COLUMNS]
        df = pd.concat([df, df_row], ignore_index=True)
    else:
        df = df_row

    df.to_csv(DATASET_FILE, index=False)


# ============================
# Flask
# ============================

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/compute", methods=["POST"])
def api_compute():
    payload = request.get_json(force=True) or {}

    sensor_type = str(payload.get("sensor_type", "")).strip()
    duration_minutes = payload.get("duration_minutes", None)
    device_name = str(payload.get("device_name", "")).strip()

    if sensor_type == "polar_h10":
        rri_ms = payload.get("rri_ms", [])
        result = compute_hrv_from_rri_polar(np.array(rri_ms, dtype=float), duration_minutes=duration_minutes)
        result["sensor_type"] = "polar_h10"
        result["rr_source"] = "polar"
        result["device_name"] = device_name or "Polar H10"
        result["duration_minutes"] = duration_minutes
        return jsonify(sanitize_for_json(result))

    if sensor_type == "garmin_hrm":
        rri_ms = payload.get("rri_ms", [])
        result = compute_hrv_from_rri_garmin(np.array(rri_ms, dtype=float), duration_minutes=duration_minutes)
        result["sensor_type"] = "garmin_hrm"
        result["rr_source"] = "garmin"
        result["device_name"] = device_name or "Garmin HRM"
        result["duration_minutes"] = duration_minutes
        return jsonify(sanitize_for_json(result))

    if sensor_type == "camera_ppg":
        ppg = payload.get("ppg", [])
        sampling_rate = payload.get("sampling_rate", 30)
        result = compute_hrv_from_ppg(np.array(ppg, dtype=float), float(sampling_rate), duration_minutes=duration_minutes)
        result["sensor_type"] = "camera_ppg"
        result["rr_source"] = "ppg"
        result["device_name"] = device_name or "Camera PPG"
        result["duration_minutes"] = duration_minutes
        return jsonify(sanitize_for_json(result))

    return jsonify({"error": "sensor_type inválido. Use 'camera_ppg', 'polar_h10' o 'garmin_hrm'."}), 400


@app.route("/api/save", methods=["POST"])
def api_save():
    payload = request.get_json(force=True) or {}

    student_id = str(payload.get("student_id", "")).strip()
    age = payload.get("age", "")
    comorbidities = str(payload.get("comorbidities", "")).strip()
    notes = str(payload.get("notes", "")).strip()

    metrics = sanitize_for_json(payload.get("metrics", {}) or {})

    row = {c: "" for c in CSV_COLUMNS}
    row.update({
        "timestamp_utc": datetime.utcnow().isoformat() + "Z",
        "student_id": student_id,
        "age": age,
        "comorbidities": comorbidities,
        "sensor_type": metrics.get("sensor_type", ""),
        "rr_source": metrics.get("rr_source", ""),
        "device_name": metrics.get("device_name", ""),
        "duration_minutes": metrics.get("duration_minutes", ""),

        "rmssd": metrics.get("rmssd", ""),
        "sdnn": metrics.get("sdnn", ""),
        "lnrmssd": metrics.get("lnrmssd", ""),
        "pnn50": metrics.get("pnn50", ""),
        "mean_rr": metrics.get("mean_rr", ""),
        "lf_power": metrics.get("lf_power", ""),
        "hf_power": metrics.get("hf_power", ""),
        "lf_hf": metrics.get("lf_hf", ""),
        "total_power": metrics.get("total_power", ""),
        "artifact_percent": metrics.get("artifact_percent", ""),
        "n_rr": metrics.get("n_rr", ""),
        "freq_warning": metrics.get("freq_warning", ""),

        "hr_mean_bpm": metrics.get("hr_mean_bpm", ""),
        "hr_min_bpm": metrics.get("hr_min_bpm", ""),
        "hr_max_bpm": metrics.get("hr_max_bpm", ""),
        "hrv_score": metrics.get("hrv_score", ""),
        "resp_rate_rpm": metrics.get("resp_rate_rpm", ""),

        "ppg_valid": metrics.get("ppg_valid", ""),
        "ppg_quality": metrics.get("ppg_quality", ""),

        "notes": notes,
    })

    append_to_dataset(row)
    return jsonify({"ok": True, "file": DATASET_FILE})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
