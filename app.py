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
    """Evita NaN/inf en JSON (causa 'Unexpected token N')."""
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
    Limpieza/corrección de RR (ms):
    - Rechazo fisiológico: 300–2000 ms
    - Outliers robustos (MAD)
    - Corrección por interpolación lineal
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


# ============================
# HRV Backend
# ============================
def _hr_from_rri(rri_ms: np.ndarray):
    rri_ms = _finite_array(rri_ms)
    if len(rri_ms) < 3:
        return np.nan, np.nan
    hr = 60000.0 / rri_ms
    hr_mean = float(np.nanmean(hr)) if len(hr) else np.nan
    hr_max = float(np.nanmax(hr)) if len(hr) else np.nan
    return hr_mean, hr_max


def _hrv_score_from_lnrmssd(lnrmssd: float):
    # Escala 0-100 tipo app (índice visual, NO diagnóstico)
    if lnrmssd is None or not np.isfinite(lnrmssd):
        return np.nan
    score = 10 + (np.clip((float(lnrmssd) - 2.5) / (5.0 - 2.5), 0, 1) * 85)
    return float(score)


def compute_hrv_from_rri(rri_ms: np.ndarray, duration_minutes=None):
    """
    HRV desde RR (ms).
    Time: RMSSD, SDNN, lnRMSSD, pNN50, Mean RR
    Freq: LF, HF, LF/HF, Total Power
    + HR mean / HR max
    + HRV score (visual)
    """
    rri_ms = _finite_array(rri_ms)

    if len(rri_ms) < 20:
        return {
            "error": "Insuficientes intervalos RR (mínimo recomendado: 20).",
            "artifact_percent": np.nan
        }

    rri_clean, artifact_percent, _mask_art = clean_rri_ms(rri_ms)

    hr_mean, hr_max = _hr_from_rri(rri_clean)

    try:
        hrv_time = nk.hrv_time(rri=rri_clean, show=False)
        hrv_freq = nk.hrv_frequency(rri=rri_clean, show=False)
    except Exception:
        peaks = rri_to_peaks(rri_clean, sampling_rate=1000)
        if peaks is None:
            return {
                "error": "No se pudo construir tren de picos desde RR.",
                "artifact_percent": artifact_percent
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

    freq_warning = None
    if duration_minutes is not None:
        try:
            dm = float(duration_minutes)
            if dm < 5:
                freq_warning = "Segmento < 5 min: LF/HF y potencia espectral pueden ser menos estables."
        except Exception:
            pass

    hrv_score = _hrv_score_from_lnrmssd(lnrmssd)

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
        "hrv_score": hrv_score,
        "freq_warning": freq_warning
    }


def compute_hrv_from_ppg(ppg: np.ndarray, sampling_rate: float, duration_minutes=None):
    """
    Cámara PPG -> FILTRO + PICOS + RR -> usa el MISMO motor RR que Polar.
    Así HR y HRV quedan coherentes (no delirantes).
    """
    ppg = _finite_array(ppg)
    if sampling_rate is None or not np.isfinite(sampling_rate) or sampling_rate <= 5:
        return {"error": "sampling_rate inválido."}

    min_seconds = 60
    if len(ppg) < int(sampling_rate * min_seconds):
        return {"error": f"PPG insuficiente (mínimo {min_seconds}s). Recomendado 3–5 min."}

    # Filtrado banda cardíaca
    try:
        ppg = ppg - np.median(ppg)
        ppg = nk.signal_filter(
            ppg,
            sampling_rate=sampling_rate,
            lowcut=0.7,
            highcut=4.0,
            method="butterworth",
            order=2
        )
    except Exception as e:
        return {"error": f"Fallo filtrando PPG: {str(e)}"}

    # Picos robustos
    try:
        min_distance = int(0.35 * sampling_rate)  # ~170 bpm
        peaks_dict, _ = nk.signal_findpeaks(ppg, sampling_rate=sampling_rate, distance=min_distance)
        peaks_idx = np.array(peaks_dict.get("Peaks", []), dtype=int)
    except Exception as e:
        return {"error": f"Fallo detectando picos PPG: {str(e)}"}

    if peaks_idx.size < 10:
        return {"error": "No se detectaron suficientes latidos. Evitá movimiento y asegurá buena presión/dedo."}

    # RR desde picos
    rr_s = np.diff(peaks_idx) / float(sampling_rate)
    rri_ms = rr_s * 1000.0

    # Pasamos por motor RR (misma limpieza + hrv)
    out = compute_hrv_from_rri(rri_ms, duration_minutes=duration_minutes)
    out["n_beats"] = int(peaks_idx.size)
    out["n_samples"] = int(len(ppg))
    out["sampling_rate"] = float(sampling_rate)
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


def load_history(student_id: str):
    if not os.path.exists(DATASET_FILE):
        return []
    df = pd.read_csv(DATASET_FILE)
    if "student_id" not in df.columns:
        return []
    df = df[df["student_id"].astype(str) == str(student_id)]
    if df.empty:
        return []
    # ordenar por fecha
    if "timestamp_utc" in df.columns:
        df["timestamp_utc"] = df["timestamp_utc"].astype(str)
    df = df.sort_values(by="timestamp_utc", ascending=True)

    # devolver últimos 60
    df = df.tail(60)
    out = []
    for _, r in df.iterrows():
        out.append({
            "t": str(r.get("timestamp_utc", "")),
            "rmssd": _as_float(r.get("rmssd", np.nan)),
            "hr_mean": _as_float(r.get("hr_mean", np.nan)),
            "hrv_score": _as_float(r.get("hrv_score", np.nan)),
            "artifact_percent": _as_float(r.get("artifact_percent", np.nan)),
            "sensor_type": str(r.get("sensor_type", "")),
        })
    return out


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
        "hf_power": metrics.get("hf_hf", "") if False else metrics.get("hf_power", ""),
        "lf_hf": metrics.get("lf_hf", ""),
        "total_power": metrics.get("total_power", ""),
        "artifact_percent": metrics.get("artifact_percent", ""),
        "freq_warning": metrics.get("freq_warning", ""),
        "notes": notes,
    }

    append_to_dataset(row)
    return jsonify({"ok": True, "file": os.path.basename(DATASET_FILE)})


@app.route("/api/history", methods=["GET"])
def api_history():
    student_id = str(request.args.get("student_id", "")).strip()
    if not student_id:
        return jsonify({"error": "student_id requerido"}), 400
    hist = load_history(student_id)
    return jsonify(json_safe({"ok": True, "items": hist}))


if __name__ == "__main__":
    # local
    app.run(host="0.0.0.0", port=5000, debug=True)
