# app.py  (COMPLETO)
import os
from datetime import datetime

import numpy as np
import pandas as pd
from flask import Flask, render_template, request, jsonify
import neurokit2 as nk
from scipy import interpolate

app = Flask(__name__)

# ============================
# Persistencia (Render Disk)
# ============================
DATASET_DIR = os.getenv("DATASET_DIR", ".")
os.makedirs(DATASET_DIR, exist_ok=True)
DATASET_FILE = os.path.join(DATASET_DIR, "dataset_hba.csv")

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


def json_safe(d: dict):
    out = {}
    for k, v in (d or {}).items():
        if isinstance(v, (np.floating, float)) and (not np.isfinite(v)):
            out[k] = None
        elif isinstance(v, (np.integer, int)):
            out[k] = int(v)
        else:
            out[k] = v
    return out


# ============================
# Calidad RR + Corrección
# ============================
def clean_rri_ms(rri_ms: np.ndarray):
    """
    Limpieza/corrección RR (ms) estándar:
    - Rango fisiológico: 300–2000 ms
    - Outliers robustos (MAD z>3.5)
    - Interpolación lineal
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


def clean_rri_ms_relaxed(rri_ms: np.ndarray):
    """
    Limpieza/corrección RR (ms) RELAJADA (para PPG cámara / mayores):
    - Rango fisiológico: 250–2200 ms (más tolerante)
    - Outliers robustos (MAD z>4.5) (más tolerante)
    - Interpolación lineal
    """
    rri_ms = _finite_array(rri_ms)

    if len(rri_ms) < 8:
        return rri_ms, np.nan, np.zeros(len(rri_ms), dtype=bool)

    bad = (rri_ms < 250) | (rri_ms > 2200)

    base = rri_ms[~bad] if np.any(~bad) else rri_ms
    med = np.median(base)
    mad = np.median(np.abs(base - med)) + 1e-9

    robust_z = 0.6745 * (rri_ms - med) / mad
    bad = bad | (np.abs(robust_z) > 4.5)

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


# ============================
# HRV Backend
# ============================
def _hr_from_rri(rri_ms: np.ndarray):
    rri_ms = _finite_array(rri_ms)
    if len(rri_ms) < 3:
        return np.nan, np.nan
    hr = 60000.0 / rri_ms
    return float(np.nanmean(hr)), float(np.nanmax(hr))


def _hrv_score_from_lnrmssd(lnrmssd: float):
    if lnrmssd is None or not np.isfinite(lnrmssd):
        return np.nan
    score = 10 + (np.clip((float(lnrmssd) - 2.5) / (5.0 - 2.5), 0, 1) * 85)
    return float(score)


def compute_hrv_from_rri(rri_ms: np.ndarray, duration_minutes=None):
    rri_ms = _finite_array(rri_ms)

    if len(rri_ms) < 20:
        return {"error": "Insuficientes intervalos RR (mínimo recomendado: 20).", "artifact_percent": np.nan}

    rri_clean, artifact_percent, _ = clean_rri_ms(rri_ms)
    hr_mean, hr_max = _hr_from_rri(rri_clean)

    try:
        hrv_time = nk.hrv_time(rri=rri_clean, show=False)
        hrv_freq = nk.hrv_frequency(rri=rri_clean, show=False)
    except Exception:
        peaks = rri_to_peaks(rri_clean, sampling_rate=1000)
        if peaks is None:
            return {"error": "No se pudo construir tren de picos desde RR.", "artifact_percent": artifact_percent}
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
        "hr_mean": hr_mean,
        "hr_max": hr_max,
        "hrv_score": _hrv_score_from_lnrmssd(lnrmssd),
        "freq_warning": freq_warning
    }


def compute_hrv_from_ppg(ppg: np.ndarray, sampling_rate: float, duration_minutes=None):
    """
    Cámara PPG (OPTIMIZADO):
    - filtro más tolerante: lowcut=0.5, highcut=8.0
    - picos: nk.ppg_peaks(method='elgendi') (robusto)
    - RR limpio con umbrales RELAJADOS
    - NO descarta fácil: devuelve warning de calidad si hay muchos artefactos
    """
    ppg = _finite_array(ppg)
    if sampling_rate is None or not np.isfinite(sampling_rate) or sampling_rate <= 5:
        return {"error": "sampling_rate inválido."}

    min_seconds = 45  # más tolerante que 60
    if len(ppg) < int(sampling_rate * min_seconds):
        return {"error": f"PPG insuficiente (mínimo {min_seconds}s). Recomendado 3–5 min."}

    # Preprocesado + filtro (más ancho)
    try:
        ppg = ppg - np.median(ppg)
        ppg = nk.signal_filter(
            ppg,
            sampling_rate=sampling_rate,
            lowcut=0.5,
            highcut=8.0,
            method="butterworth",
            order=2
        )
    except Exception as e:
        return {"error": f"Fallo filtrando PPG: {str(e)}"}

    # Peaks robustos (Elgendi)
    try:
        peaks_obj, info = nk.ppg_peaks(ppg, sampling_rate=sampling_rate, method="elgendi")
        peaks_idx = None

        if isinstance(peaks_obj, dict):
            peaks_idx = peaks_obj.get("PPG_Peaks", None) or peaks_obj.get("Peaks", None)
        if peaks_idx is None and isinstance(info, dict):
            peaks_idx = info.get("PPG_Peaks", None) or info.get("Peaks", None)

        if peaks_idx is None:
            # fallback: si viniera binario
            peaks_idx = np.where(np.asarray(peaks_obj) == 1)[0]

        peaks_idx = np.asarray(peaks_idx, dtype=int)

    except Exception as e:
        return {"error": f"Fallo detectando picos PPG (elgendi): {str(e)}"}

    if peaks_idx.size < 8:
        return {"error": "No se detectaron suficientes latidos. Evitá movimiento y asegurá buen contacto."}

    # RR ms
    rr_s = np.diff(peaks_idx) / float(sampling_rate)
    rri_ms = rr_s * 1000.0

    # Limpieza relajada
    rri_clean, artifact_percent, _ = clean_rri_ms_relaxed(rri_ms)

    # Si aún así quedan pocos RR, no descartar fácil: devolver error solo si es muy poco
    if len(rri_clean) < 12:
        return {"error": "RR insuficientes tras limpieza. Probá con menos movimiento y más presión en el lente."}

    # HR básicos
    hr_mean, hr_max = _hr_from_rri(rri_clean)

    # HRV: si hay >=20 RR, calcular freq; si no, solo time (sin fallar)
    freq_warning = None
    try:
        hrv_time = nk.hrv_time(rri=rri_clean, show=False)
    except Exception as e:
        return {"error": f"Fallo HRV time (PPG): {str(e)}"}

    lf = hf = tp = lfhf = np.nan
    if len(rri_clean) >= 20:
        try:
            hrv_freq = nk.hrv_frequency(rri=rri_clean, show=False)
            lf = _as_float(hrv_freq.get("HRV_LF", [np.nan])[0]) if hasattr(hrv_freq, "get") else _as_float(hrv_freq["HRV_LF"].iloc[0])
            hf = _as_float(hrv_freq.get("HRV_HF", [np.nan])[0]) if hasattr(hrv_freq, "get") else _as_float(hrv_freq["HRV_HF"].iloc[0])
            tp = _as_float(hrv_freq.get("HRV_TP", [np.nan])[0]) if hasattr(hrv_freq, "get") else _as_float(hrv_freq["HRV_TP"].iloc[0])
            lfhf = (lf / hf) if np.isfinite(lf) and np.isfinite(hf) and hf > 0 else np.nan
        except Exception:
            freq_warning = "No se pudo estimar espectral con estabilidad (PPG). Se reporta Time Domain."

    # Time metrics
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

    # Warning por duración
    if duration_minutes is not None:
        try:
            dm = float(duration_minutes)
            if dm < 5:
                freq_warning = freq_warning or "Segmento < 5 min: LF/HF y potencia espectral pueden ser menos estables."
        except Exception:
            pass

    # Warning por artefactos (sin descartar)
    quality_warning = None
    if np.isfinite(artifact_percent):
        if artifact_percent > 20:
            quality_warning = "Calidad baja: mucho movimiento/ruido. Repetir si se necesita precisión."
        elif artifact_percent > 12:
            quality_warning = "Calidad moderada: mantener dedo firme y sin movimiento."

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
        "n_beats": int(peaks_idx.size),
        "sampling_rate": float(sampling_rate),
        "hr_mean": hr_mean,
        "hr_max": hr_max,
        "hrv_score": _hrv_score_from_lnrmssd(lnrmssd),
        "freq_warning": freq_warning,
        "quality_warning": quality_warning
    }


# ============================
# Persistencia CSV
# ============================
CSV_COLUMNS = [
    "timestamp_utc",
    "student_id",
    "age",
    "comorbidities",
    "sensor_type",
    "duration_minutes",
    "hr_mean",
    "hr_max",
    "hrv_score",
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
    "freq_warning",
    "quality_warning",
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

    if sensor_type == "polar_h10":
        rri_ms = payload.get("rri_ms", [])
        result = compute_hrv_from_rri(np.array(rri_ms, dtype=float), duration_minutes=duration_minutes)
        result["sensor_type"] = "polar_h10"
        result["duration_minutes"] = duration_minutes
        return jsonify(json_safe(result))

    if sensor_type == "camera_ppg":
        ppg = payload.get("ppg", [])
        sampling_rate = payload.get("sampling_rate", 30)
        result = compute_hrv_from_ppg(np.array(ppg, dtype=float), float(sampling_rate), duration_minutes=duration_minutes)
        result["sensor_type"] = "camera_ppg"
        result["duration_minutes"] = duration_minutes
        return jsonify(json_safe(result))

    return jsonify({"error": "sensor_type inválido. Use 'camera_ppg' o 'polar_h10'."}), 400


@app.route("/api/save", methods=["POST"])
def api_save():
    payload = request.get_json(force=True) or {}

    student_id = str(payload.get("student_id", "")).strip()
    age = payload.get("age", "")
    comorbidities = str(payload.get("comorbidities", "")).strip()
    notes = str(payload.get("notes", "")).strip()

    metrics = payload.get("metrics", {}) or {}

    row = {
        "timestamp_utc": datetime.utcnow().isoformat() + "Z",
        "student_id": student_id,
        "age": age,
        "comorbidities": comorbidities,
        "sensor_type": metrics.get("sensor_type", ""),
        "duration_minutes": metrics.get("duration_minutes", ""),
        "hr_mean": metrics.get("hr_mean", ""),
        "hr_max": metrics.get("hr_max", ""),
        "hrv_score": metrics.get("hrv_score", ""),
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
        "freq_warning": metrics.get("freq_warning", ""),
        "quality_warning": metrics.get("quality_warning", ""),
        "notes": notes,
    }

    append_to_dataset(row)
    return jsonify({"ok": True, "file": os.path.basename(DATASET_FILE)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
