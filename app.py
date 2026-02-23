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


# ============================
# Calidad RR + Corrección
# ============================

def clean_rri_ms(rri_ms: np.ndarray):
    """
    Limpieza/corrección de RR (ms) para estudio:
    - Rechazo fisiológico: 300–2000 ms
    - Outliers robustos (MAD) para ectopias/ruido
    - Corrección por interpolación lineal sobre índices (manteniendo longitud)
    Devuelve: rri_clean, artifact_percent, mask_artifact
    """
    rri_ms = _finite_array(rri_ms)

    if len(rri_ms) < 10:
        return rri_ms, np.nan, np.zeros(len(rri_ms), dtype=bool)

    # Rango fisiológico
    bad = (rri_ms < 300) | (rri_ms > 2000)

    # Outliers robustos con MAD
    base = rri_ms[~bad] if np.any(~bad) else rri_ms
    med = np.median(base)
    mad = np.median(np.abs(base - med)) + 1e-9

    robust_z = 0.6745 * (rri_ms - med) / mad
    bad = bad | (np.abs(robust_z) > 3.5)

    artifact_percent = 100.0 * (np.sum(bad) / len(rri_ms))

    if not np.any(bad):
        return rri_ms, artifact_percent, bad

    # Si quedan muy pocos puntos buenos, no corregir
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
    """
    Convierte RR (ms) a tren de picos (0/1) a sampling_rate (Hz).
    Útil para aprovechar funciones de NeuroKit2 que trabajan con picos.
    """
    rri_ms = _finite_array(rri_ms)
    if len(rri_ms) < 3:
        return None

    peak_times_s = np.cumsum(rri_ms) / 1000.0
    peak_samples = np.unique(np.round(peak_times_s * sampling_rate).astype(int))
    if len(peak_samples) < 3:
        return None

    length = int(peak_samples[-1] + sampling_rate)  # 1s extra
    peaks = np.zeros(length, dtype=int)
    peaks[peak_samples] = 1
    return peaks


# ============================
# HRV Backend
# ============================

def compute_hrv_from_rri(rri_ms: np.ndarray, duration_minutes=None):
    """
    HRV desde RR (ms) - Polar H10.
    Time: RMSSD, SDNN, lnRMSSD, pNN50, Mean RR
    Freq: LF, HF, LF/HF, Total Power
    Calidad: % artefactos detectados/corregidos
    """
    rri_ms = _finite_array(rri_ms)

    if len(rri_ms) < 20:
        return {
            "error": "Insuficientes intervalos RR (mínimo recomendado: 20).",
            "artifact_percent": np.nan
        }

    rri_clean, artifact_percent, mask_art = clean_rri_ms(rri_ms)

    # NeuroKit2 (try directo con rri=..., fallback a peaks)
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

    # Bandera de estabilidad espectral (por duración)
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
        "freq_warning": freq_warning
    }


def compute_hrv_from_ppg(ppg: np.ndarray, sampling_rate: float, duration_minutes=None):
    """
    HRV desde PPG (cámara): procesa señal y detecta picos, corrige picos y reporta artefactos.
    """
    ppg = _finite_array(ppg)
    if sampling_rate is None or not np.isfinite(sampling_rate) or sampling_rate <= 1:
        return {"error": "sampling_rate inválido."}

    # Recomendación: para HRV y especialmente frecuencia, ideal 3-5 min.
    min_seconds = 60  # mínimo absoluto (evitar resultados sin base)
    if len(ppg) < int(sampling_rate * min_seconds):
        return {"error": f"PPG insuficiente (mínimo {min_seconds}s). Recomendado 3–5 min."}

    try:
        signals, info = nk.ppg_process(ppg, sampling_rate=sampling_rate)
        peaks = info.get("PPG_Peaks", None)

        # Normalizamos a array binario si viniera distinto
        if peaks is None:
            peaks, _ = nk.ppg_peaks(ppg, sampling_rate=sampling_rate)
    except Exception as e:
        return {"error": f"Fallo en procesamiento PPG: {str(e)}"}

    # Corrección de picos con NK (más robusto que “contar picos”)
    try:
        fixed = nk.signal_fixpeaks(peaks, sampling_rate=sampling_rate, iterative=True, show=False)
        peaks_fixed = fixed["Peaks"]
        # Estimar % artefactos en base a correcciones:
        # contamos los índices de picos (antes/después) y tomamos dif simétrica
        idx_before = np.where(np.asarray(peaks) == 1)[0]
        idx_after = np.where(np.asarray(peaks_fixed) == 1)[0]
        # Diferencia tipo Jaccard para "cambios"
        if len(idx_before) == 0:
            artifact_percent = np.nan
        else:
            set_b = set(idx_before.tolist())
            set_a = set(idx_after.tolist())
            changed = len(set_b.symmetric_difference(set_a))
            artifact_percent = 100.0 * (changed / max(len(set_b), 1))
        peaks_for_hrv = peaks_fixed
    except Exception:
        artifact_percent = np.nan
        peaks_for_hrv = peaks

    # HRV
    try:
        hrv_time = nk.hrv_time(peaks_for_hrv, sampling_rate=sampling_rate, show=False)
        hrv_freq = nk.hrv_frequency(peaks_for_hrv, sampling_rate=sampling_rate, show=False)
    except Exception as e:
        return {"error": f"Fallo calculando HRV desde picos: {str(e)}"}

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
        "n_samples": int(len(ppg)),
        "sampling_rate": float(sampling_rate),
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
    "freq_warning",
    "notes",
]


def append_to_dataset(row: dict):
    df_row = pd.DataFrame([{c: row.get(c, "") for c in CSV_COLUMNS}])

    if os.path.exists(DATASET_FILE):
        df = pd.read_csv(DATASET_FILE)
        # asegurar columnas
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
        return jsonify(result)

    if sensor_type == "camera_ppg":
        ppg = payload.get("ppg", [])
        sampling_rate = payload.get("sampling_rate", 30)
        result = compute_hrv_from_ppg(np.array(ppg, dtype=float), float(sampling_rate), duration_minutes=duration_minutes)
        result["sensor_type"] = "camera_ppg"
        result["duration_minutes"] = duration_minutes
        return jsonify(result)

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
        "notes": notes,
    }

    append_to_dataset(row)
    return jsonify({"ok": True, "file": DATASET_FILE})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)