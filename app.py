import os
from datetime import datetime

import numpy as np
import pandas as pd
from flask import Flask, render_template, request, jsonify
import neurokit2 as nk
from scipy import interpolate

app = Flask(__name__)

DATASET_FILE = "dataset_hba.csv"

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


def _sanitize_for_json(obj):
    """Evita NaN/Inf en JSON (rompen JSON y generan 'Unexpected token N')."""
    if obj is None:
        return None
    if isinstance(obj, (np.floating, float)):
        v = float(obj)
        return v if np.isfinite(v) else None
    if isinstance(obj, (np.integer, int)):
        return int(obj)
    if isinstance(obj, dict):
        return {k: _sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize_for_json(v) for v in obj]
    return obj


# ============================
# Calidad RR + Corrección
# ============================

def clean_rri_ms(rri_ms: np.ndarray):
    """
    Limpieza/corrección de RR (ms):
    - Rechazo fisiológico: 300–2000 ms
    - Outliers robustos (MAD)
    - Corrección por interpolación
    """
    rri_ms = _finite_array(rri_ms)

    if len(rri_ms) < 10:
        return rri_ms, np.nan, np.zeros(len(rri_ms), dtype=bool)

    bad = (rri_ms < 300) | (rri_ms > 2000)

    base = rri_ms[~bad] if np.any(~bad) else rri_ms
    med = np.median(base)
    mad = np.median(np.abs(base - med)) + 1e-9

    robust_z = 0.6745 * (rri_ms - med) / mad
    bad = bad | (np.abs(robust_z) > 4.5)  # más tolerante que 3.5

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

def compute_hrv_from_rri(rri_ms: np.ndarray, duration_minutes=None):
    rri_ms = _finite_array(rri_ms)

    if len(rri_ms) < 20:
        return {
            "error": "Insuficientes intervalos RR (mínimo recomendado: 20).",
            "artifact_percent": np.nan
        }

    rri_clean, artifact_percent, _mask = clean_rri_ms(rri_ms)

    # HR básicos
    hr_series = 60000.0 / rri_clean
    hr_mean = float(np.nanmean(hr_series)) if len(hr_series) else np.nan
    hr_max = float(np.nanmax(hr_series)) if len(hr_series) else np.nan
    hr_min = float(np.nanmin(hr_series)) if len(hr_series) else np.nan

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
        "hr_min": hr_min,
        "freq_warning": freq_warning
    }


def _resp_rate_from_ppg_fft(ppg: np.ndarray, sampling_rate: float):
    """
    Estimación simple y conservadora de FR (respiración) desde modulación lenta del PPG.
    Devuelve respiraciones/min (rpm). Si no es estable, devuelve NaN.
    """
    try:
        # banda típica respiración 0.1–0.4 Hz (6–24 rpm)
        rsp = nk.signal_filter(ppg, sampling_rate=sampling_rate, lowcut=0.1, highcut=0.4, method="butterworth", order=3)
        rsp = np.asarray(rsp, dtype=float)
        rsp = rsp - np.nanmean(rsp)

        n = len(rsp)
        if n < int(sampling_rate * 60):  # mínimo 60s para FFT con algo de sentido
            return np.nan

        freqs = np.fft.rfftfreq(n, d=1.0 / sampling_rate)
        spec = np.abs(np.fft.rfft(rsp)) ** 2

        mask = (freqs >= 0.1) & (freqs <= 0.4)
        if not np.any(mask):
            return np.nan

        f0 = freqs[mask][int(np.argmax(spec[mask]))]
        rpm = float(f0 * 60.0)
        return rpm if np.isfinite(rpm) else np.nan
    except Exception:
        return np.nan


def compute_hrv_from_ppg(ppg: np.ndarray, sampling_rate: float, duration_minutes=None):
    """
    HRV desde PPG (cámara):
    - Filtrado tolerante (0.5–8.0 Hz)
    - Detección de picos robusta: elgendi
    - Fixpeaks + artefactos más tolerantes
    - HR mean/max/min + estimación FR (opcional)
    """
    ppg = _finite_array(ppg)
    if sampling_rate is None or not np.isfinite(sampling_rate) or sampling_rate <= 1:
        return {"error": "sampling_rate inválido."}

    # mínimo absoluto más tolerante
    min_seconds = 45
    if len(ppg) < int(sampling_rate * min_seconds):
        return {"error": f"PPG insuficiente (mínimo {min_seconds}s). Recomendado 3–5 min."}

    # normalizar suave
    ppg = np.asarray(ppg, dtype=float)
    ppg = ppg - np.nanmean(ppg)
    std = np.nanstd(ppg) + 1e-9
    ppg = ppg / std

    # filtro tolerante (pedidos: lowcut=0.5, highcut=8.0)
    try:
        ppg_f = nk.signal_filter(
            ppg,
            sampling_rate=sampling_rate,
            lowcut=0.5,
            highcut=8.0,
            method="butterworth",
            order=3
        )
    except Exception:
        ppg_f = ppg

    # peaks elgendi
    try:
        _peaks, info = nk.ppg_peaks(ppg_f, sampling_rate=sampling_rate, method="elgendi")
        peaks_idx = info.get("PPG_Peaks", None)
        if peaks_idx is None:
            # fallback si viene en otra clave/estructura
            peaks_idx = info.get("peaks", None)

        if peaks_idx is None:
            return {"error": "Fallo detectando picos PPG (elgendi): no se encontraron picos."}

        peaks_idx = np.asarray(peaks_idx, dtype=int)
        peaks_idx = peaks_idx[(peaks_idx > 0) & (peaks_idx < len(ppg_f))]
        if len(peaks_idx) < 10:
            return {"error": "Fallo detectando picos PPG (elgendi): picos insuficientes."}

    except Exception as e:
        return {"error": f"Fallo detectando picos PPG (elgendi): {str(e)}"}

    # Fixpeaks (más tolerante) + % cambios
    artifact_percent = np.nan
    try:
        fixed = nk.signal_fixpeaks(peaks_idx, sampling_rate=sampling_rate, iterative=True, show=False)
        fixed_idx = np.asarray(fixed.get("Peaks", peaks_idx), dtype=int)
        fixed_idx = fixed_idx[(fixed_idx > 0) & (fixed_idx < len(ppg_f))]
        if len(fixed_idx) >= 10:
            set_b = set(peaks_idx.tolist())
            set_a = set(fixed_idx.tolist())
            changed = len(set_b.symmetric_difference(set_a))
            # más tolerante: cambios relativos vs total picos
            artifact_percent = 100.0 * (changed / max(len(set_b), 1))
            peaks_idx_used = fixed_idx
        else:
            peaks_idx_used = peaks_idx
    except Exception:
        peaks_idx_used = peaks_idx

    # RR + HR
    rr_ms = np.diff(peaks_idx_used) / sampling_rate * 1000.0
    rr_ms = rr_ms[np.isfinite(rr_ms)]
    rr_ms = rr_ms[(rr_ms >= 300) & (rr_ms <= 2000)]  # tolerante pero fisiológico
    if len(rr_ms) < 20:
        return {"error": "PPG con RR insuficientes/ruidosos. Probá apoyar mejor el dedo y reducir movimiento.", "artifact_percent": artifact_percent}

    hr_series = 60000.0 / rr_ms
    hr_mean = float(np.nanmean(hr_series)) if len(hr_series) else np.nan
    hr_max = float(np.nanmax(hr_series)) if len(hr_series) else np.nan
    hr_min = float(np.nanmin(hr_series)) if len(hr_series) else np.nan

    # HRV con RR directo (más estable que peaks binarios en cámara)
    rr_clean, rr_art, _mask = clean_rri_ms(rr_ms)
    # “artefactos” final: combinar cambios de fixpeaks + limpieza RR (más realista)
    if np.isfinite(artifact_percent) and np.isfinite(rr_art):
        artifact_final = float(0.6 * rr_art + 0.4 * artifact_percent)
    elif np.isfinite(rr_art):
        artifact_final = float(rr_art)
    else:
        artifact_final = float(artifact_percent) if np.isfinite(artifact_percent) else np.nan

    try:
        hrv_time = nk.hrv_time(rri=rr_clean, show=False)
        hrv_freq = nk.hrv_frequency(rri=rr_clean, show=False)
    except Exception as e:
        return {"error": f"Fallo calculando HRV desde RR (PPG): {str(e)}", "artifact_percent": artifact_final}

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

    # Estimación FR (conservadora)
    resp_rpm = _resp_rate_from_ppg_fft(ppg_f, sampling_rate)

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
        "artifact_percent": artifact_final,
        "n_samples": int(len(ppg)),
        "sampling_rate": float(sampling_rate),
        "hr_mean": hr_mean,
        "hr_max": hr_max,
        "hr_min": hr_min,
        "resp_rate_rpm": resp_rpm,
        "freq_warning": freq_warning
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
    "hr_mean",
    "hr_max",
    "hr_min",
    "resp_rate_rpm",
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
        return jsonify(_sanitize_for_json(result))

    if sensor_type == "camera_ppg":
        ppg = payload.get("ppg", [])
        sampling_rate = payload.get("sampling_rate", 30)
        result = compute_hrv_from_ppg(np.array(ppg, dtype=float), float(sampling_rate), duration_minutes=duration_minutes)
        result["sensor_type"] = "camera_ppg"
        result["duration_minutes"] = duration_minutes
        return jsonify(_sanitize_for_json(result))

    return jsonify(_sanitize_for_json({"error": "sensor_type inválido. Use 'camera_ppg' o 'polar_h10'."})), 400


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
        "hr_mean": metrics.get("hr_mean", ""),
        "hr_max": metrics.get("hr_max", ""),
        "hr_min": metrics.get("hr_min", ""),
        "resp_rate_rpm": metrics.get("resp_rate_rpm", ""),
        "freq_warning": metrics.get("freq_warning", ""),
        "notes": notes,
    }

    append_to_dataset(row)
    return jsonify({"ok": True, "file": DATASET_FILE})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
