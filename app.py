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


def _nan_to_none(x):
    # JSON-safe: NaN/inf -> None
    if isinstance(x, (float, np.floating)):
        if not np.isfinite(x):
            return None
        return float(x)
    if isinstance(x, (int, np.integer)):
        return int(x)
    return x


def sanitize_for_json(obj):
    if isinstance(obj, dict):
        return {k: sanitize_for_json(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [sanitize_for_json(v) for v in obj]
    return _nan_to_none(obj)


# ============================
# Calidad RR + Corrección
# ============================

def clean_rri_ms(rri_ms: np.ndarray):
    """
    Limpieza/corrección RR (ms):
    - Rechazo fisiológico: 300–2000 ms
    - Outliers robustos (MAD)
    - Corrección por interpolación lineal
    Devuelve: rri_clean, artifact_percent, mask_artifact
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


def rri_to_hr_stats(rri_ms: np.ndarray):
    rri_ms = _finite_array(rri_ms)
    if len(rri_ms) < 3:
        return np.nan, np.nan, np.nan
    hr = 60000.0 / rri_ms
    return float(np.mean(hr)), float(np.min(hr)), float(np.max(hr))


def estimate_resp_rate_from_hrv_freq(hrv_freq_df):
    """
    Estimación simple de FR (rpm) a partir del pico HF (si existe).
    NO es clínica; sirve como biomarcador aproximado.
    """
    try:
        hf_peak = _as_float(hrv_freq_df.get("HRV_HF_Peak", pd.Series([np.nan])).iloc[0])
        if np.isfinite(hf_peak) and hf_peak > 0:
            # Hz -> rpm
            return float(hf_peak * 60.0)
    except Exception:
        pass
    return np.nan


def recovery_score(lnrmssd, hr_mean_bpm, artifact_percent):
    """
    Score operativo 0-100:
    - lnRMSSD alto -> mejor
    - HR mean alto -> peor (ligero)
    - artefactos altos -> penaliza
    """
    if not np.isfinite(lnrmssd):
        return np.nan
    # lnRMSSD típico reposo ~2.5–4.5
    x = (lnrmssd - 3.2) / 0.6  # normalización suave
    score = 50 + 20 * np.tanh(x)  # 30..70 aprox

    if np.isfinite(hr_mean_bpm):
        score -= 0.12 * max(0.0, hr_mean_bpm - 65)  # penaliza si HR>65

    if np.isfinite(artifact_percent):
        # fuerte penalización si artefactos altos
        if artifact_percent > 5:
            score -= (artifact_percent - 5) * 1.2

    return float(np.clip(score, 0, 100))


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

    hr_mean, hr_min, hr_max = rri_to_hr_stats(rri_clean)
    resp_rpm = estimate_resp_rate_from_hrv_freq(hrv_freq)
    rec = recovery_score(lnrmssd, hr_mean, artifact_percent)

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
        "hr_mean_bpm": hr_mean,
        "hr_min_bpm": hr_min,
        "hr_max_bpm": hr_max,
        "resp_rate_rpm": resp_rpm,
        "recovery_score": rec,
        "freq_warning": freq_warning
    }


def compute_hrv_from_ppg(ppg: np.ndarray, sampling_rate: float, duration_minutes=None):
    ppg = _finite_array(ppg)
    if sampling_rate is None or not np.isfinite(sampling_rate) or sampling_rate <= 1:
        return {"error": "sampling_rate inválido."}

    min_seconds = 60
    if len(ppg) < int(sampling_rate * min_seconds):
        return {"error": f"PPG insuficiente (mínimo {min_seconds}s). Recomendado 3–5 min."}

    # Normalización robusta para PPG (reduce valores locos)
    med = np.median(ppg)
    mad = np.median(np.abs(ppg - med)) + 1e-9
    ppg_z = (ppg - med) / mad

    # Bandpass para rango cardíaco (aprox 0.7–4 Hz)
    try:
        ppg_f = nk.signal_filter(ppg_z, sampling_rate=sampling_rate, lowcut=0.7, highcut=4.0, method="butterworth", order=3)
    except Exception:
        ppg_f = ppg_z

    # Peaks (robusto)
    try:
        signals, info = nk.ppg_process(ppg_f, sampling_rate=sampling_rate)
        peaks = info.get("PPG_Peaks", None)
        if peaks is None:
            peaks, _ = nk.ppg_peaks(ppg_f, sampling_rate=sampling_rate)
    except Exception as e:
        return {"error": f"Fallo en procesamiento PPG: {str(e)}"}

    # RR desde picos
    try:
        # peaks binario -> índices
        idx = np.where(np.asarray(peaks) == 1)[0]
        if len(idx) < 20:
            return {"error": "Pocos picos detectados en PPG. Probá reubicar el dedo y repetir.", "artifact_percent": np.nan}

        rri_ms = np.diff(idx) / float(sampling_rate) * 1000.0
        rri_clean, artifact_percent, _mask = clean_rri_ms(rri_ms)

        # Quality gate suave: si artefactos altísimos, avisar pero NO bloquear todo
        ppg_quality = "ok"
        if np.isfinite(artifact_percent):
            if artifact_percent <= 8:
                ppg_quality = "good"
            elif artifact_percent <= 18:
                ppg_quality = "moderate"
            else:
                ppg_quality = "poor"
    except Exception as e:
        return {"error": f"No se pudo derivar RR desde PPG: {str(e)}"}

    # HRV desde RR limpio (mismo pipeline que Polar)
    out = compute_hrv_from_rri(rri_clean, duration_minutes=duration_minutes)
    if "error" in out:
        # si falla HRV, al menos devolvemos HR stats y calidad
        hr_mean, hr_min, hr_max = rri_to_hr_stats(rri_clean)
        return {
            "error": out["error"],
            "artifact_percent": artifact_percent,
            "hr_mean_bpm": hr_mean,
            "hr_min_bpm": hr_min,
            "hr_max_bpm": hr_max,
            "ppg_quality": ppg_quality,
            "ppg_valid": False
        }

    out["ppg_quality"] = ppg_quality
    out["ppg_valid"] = (ppg_quality != "poor")
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
    "hr_mean_bpm",
    "hr_min_bpm",
    "hr_max_bpm",
    "resp_rate_rpm",
    "recovery_score",
    "ppg_quality",
    "ppg_valid",
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
        return jsonify(sanitize_for_json(result))

    if sensor_type == "camera_ppg":
        ppg = payload.get("ppg", [])
        sampling_rate = payload.get("sampling_rate", 30)
        result = compute_hrv_from_ppg(np.array(ppg, dtype=float), float(sampling_rate), duration_minutes=duration_minutes)
        result["sensor_type"] = "camera_ppg"
        result["duration_minutes"] = duration_minutes
        return jsonify(sanitize_for_json(result))

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
        "hr_mean_bpm": metrics.get("hr_mean_bpm", ""),
        "hr_min_bpm": metrics.get("hr_min_bpm", ""),
        "hr_max_bpm": metrics.get("hr_max_bpm", ""),
        "resp_rate_rpm": metrics.get("resp_rate_rpm", ""),
        "recovery_score": metrics.get("recovery_score", ""),
        "ppg_quality": metrics.get("ppg_quality", ""),
        "ppg_valid": metrics.get("ppg_valid", ""),
        "freq_warning": metrics.get("freq_warning", ""),
        "notes": notes,
    }

    append_to_dataset(sanitize_for_json(row))
    return jsonify({"ok": True, "file": DATASET_FILE})


@app.route("/api/history", methods=["GET"])
def api_history():
    student_id = (request.args.get("student_id") or "").strip()
    if not student_id:
        return jsonify({"error": "student_id requerido"}), 400

    if not os.path.exists(DATASET_FILE):
        return jsonify({"rows": []})

    df = pd.read_csv(DATASET_FILE)
    if "student_id" not in df.columns:
        return jsonify({"rows": []})

    df = df[df["student_id"].astype(str).str.strip() == student_id].copy()
    if df.empty:
        return jsonify({"rows": []})

    if "timestamp_utc" in df.columns:
        df["timestamp_utc"] = df["timestamp_utc"].astype(str)
        df = df.sort_values("timestamp_utc")

    cols = [c for c in ["timestamp_utc", "rmssd", "lnrmssd", "hr_mean_bpm", "artifact_percent", "sensor_type"] if c in df.columns]
    rows = df[cols].tail(50).to_dict(orient="records")
    return jsonify({"rows": sanitize_for_json(rows)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
