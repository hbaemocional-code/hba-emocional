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
    - Rechazo fisiológico (más tolerante): 250–2200 ms
    - Outliers robustos (MAD)
    - Corrección por interpolación
    """
    rri_ms = _finite_array(rri_ms)

    if len(rri_ms) < 10:
        return rri_ms, np.nan, np.zeros(len(rri_ms), dtype=bool)

    bad = (rri_ms < 250) | (rri_ms > 2200)

    base = rri_ms[~bad] if np.any(~bad) else rri_ms
    med = np.median(base)
    mad = np.median(np.abs(base - med)) + 1e-9

    robust_z = 0.6745 * (rri_ms - med) / mad
    # tolerante: 4.5
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
    """
    Convierte RR (ms) a un tren binario de picos (0/1) a sampling_rate Hz.
    Útil como fallback para versiones de NeuroKit2 que exigen peaks.
    """
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

    if len(rri_ms) < 12:
        return {
            "error": "Insuficientes intervalos RR (mínimo recomendado: 12).",
            "artifact_percent": np.nan
        }

    rri_clean, artifact_percent, _mask = clean_rri_ms(rri_ms)

    # HR básicos
    hr_series = 60000.0 / rri_clean
    hr_mean = float(np.nanmean(hr_series)) if len(hr_series) else np.nan
    hr_max = float(np.nanmax(hr_series)) if len(hr_series) else np.nan
    hr_min = float(np.nanmin(hr_series)) if len(hr_series) else np.nan

    hrv_mode = "rri"
    try:
        hrv_time = nk.hrv_time(rri=rri_clean, show=False)
        hrv_freq = nk.hrv_frequency(rri=rri_clean, show=False)
    except Exception:
        # fallback a peaks binario para compatibilidad NK2
        peaks = rri_to_peaks(rri_clean, sampling_rate=1000)
        if peaks is None:
            return {"error": "No se pudo construir tren de picos desde RR.", "artifact_percent": artifact_percent}
        hrv_mode = "peaks"
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
        "freq_warning": freq_warning,
        "hrv_mode": hrv_mode
    }


def _resp_rate_from_ppg_fft(ppg: np.ndarray, sampling_rate: float):
    """
    Estimación simple y conservadora de FR (respiración) desde modulación lenta del PPG.
    Devuelve respiraciones/min (rpm). Si no es estable, devuelve NaN.
    """
    try:
        rsp = nk.signal_filter(ppg, sampling_rate=sampling_rate, lowcut=0.1, highcut=0.4, method="butterworth", order=3)
        rsp = np.asarray(rsp, dtype=float)
        rsp = rsp - np.nanmean(rsp)

        n = len(rsp)
        if n < int(sampling_rate * 60):
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
    - Peaks elgendi
    - Fixpeaks + limpieza RR
    - HRV:
        - intenta con rri=...
        - si falla (NK2 exige peaks): fallback a peaks binario construido desde RR
    """
    ppg = _finite_array(ppg)
    if sampling_rate is None or not np.isfinite(sampling_rate) or sampling_rate <= 1:
        return {"error": "sampling_rate inválido."}

    min_seconds = 45
    if len(ppg) < int(sampling_rate * min_seconds):
        return {"error": f"PPG insuficiente (mínimo {min_seconds}s). Recomendado 3–5 min."}

    # normalizar suave
    ppg = np.asarray(ppg, dtype=float)
    ppg = ppg - np.nanmean(ppg)
    std = np.nanstd(ppg) + 1e-9
    ppg = ppg / std

    # filtro tolerante
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
            peaks_idx = info.get("peaks", None)

        if peaks_idx is None:
            return {"error": "Fallo detectando picos PPG (elgendi): no se encontraron picos."}

        peaks_idx = np.asarray(peaks_idx, dtype=int)
        peaks_idx = peaks_idx[(peaks_idx > 0) & (peaks_idx < len(ppg_f))]
        if len(peaks_idx) < 10:
            return {"error": "Fallo detectando picos PPG (elgendi): picos insuficientes."}

    except Exception as e:
        return {"error": f"Fallo detectando picos PPG (elgendi): {str(e)}"}

    # Fixpeaks (tolerante)
    artifact_percent = np.nan
    try:
        fixed = nk.signal_fixpeaks(peaks_idx, sampling_rate=sampling_rate, iterative=True, show=False)
        fixed_idx = np.asarray(fixed.get("Peaks", peaks_idx), dtype=int)
        fixed_idx = fixed_idx[(fixed_idx > 0) & (fixed_idx < len(ppg_f))]
        if len(fixed_idx) >= 10:
            set_b = set(peaks_idx.tolist())
            set_a = set(fixed_idx.tolist())
            changed = len(set_b.symmetric_difference(set_a))
            artifact_percent = 100.0 * (changed / max(len(set_b), 1))
            peaks_idx_used = fixed_idx
        else:
            peaks_idx_used = peaks_idx
    except Exception:
        peaks_idx_used = peaks_idx

    # RR (ms) sin filtrar duro primero: lo limpia clean_rri_ms
    rr_ms = np.diff(peaks_idx_used) / sampling_rate * 1000.0
    rr_ms = rr_ms[np.isfinite(rr_ms)]
    if len(rr_ms) < 12:
        return {"error": "PPG con RR insuficientes/ruidosos (muy pocos intervalos).", "artifact_percent": artifact_percent}

    # Limpieza RR (incluye rango fisiológico y corrección)
    rr_clean, rr_art, _mask = clean_rri_ms(rr_ms)

    # artefactos final
    if np.isfinite(artifact_percent) and np.isfinite(rr_art):
        artifact_final = float(0.6 * rr_art + 0.4 * artifact_percent)
    elif np.isfinite(rr_art):
        artifact_final = float(rr_art)
    else:
        artifact_final = float(artifact_percent) if np.isfinite(artifact_percent) else np.nan

    # HR básicos
    hr_series = 60000.0 / rr_clean
    hr_mean = float(np.nanmean(hr_series)) if len(hr_series) else np.nan
    hr_max = float(np.nanmax(hr_series)) if len(hr_series) else np.nan
    hr_min = float(np.nanmin(hr_series)) if len(hr_series) else np.nan

    # HRV: intentar rri, fallback a peaks si NeuroKit2 lo exige
    hrv_mode = "rri"
    try:
        hrv_time = nk.hrv_time(rri=rr_clean, show=False)
        hrv_freq = nk.hrv_frequency(rri=rr_clean, show=False)
    except Exception as e:
        peaks_bin = rri_to_peaks(rr_clean, sampling_rate=1000)
        if peaks_bin is None:
            return {"error": f"Fallo calculando HRV desde RR (PPG): {str(e)}", "artifact_percent": artifact_final}
        hrv_mode = "peaks"
        try:
            hrv_time = nk.hrv_time(peaks_bin, sampling_rate=1000, show=False)
            hrv_freq = nk.hrv_frequency(peaks_bin, sampling_rate=1000, show=False)
        except Exception as e2:
            return {"error": f"Fallo calculando HRV desde peaks (PPG): {str(e2)}", "artifact_percent": artifact_final}

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
        "freq_warning": freq_warning,
        "hrv_mode": hrv_mode,
        "n_rr": int(len(rr_clean)),
        "n_peaks": int(len(peaks_idx_used))
    }


# ============================
# HBA Dashboard (CUADROS + SEMÁFORO)
# ============================

def baevsky_index(nn_ms: np.ndarray):
    nn_ms = _finite_array(nn_ms)
    if nn_ms.size < 50:
        return np.nan
    hist, edges = np.histogram(nn_ms, bins=50)
    mode_idx = int(np.argmax(hist))
    Mo = float((edges[mode_idx] + edges[mode_idx + 1]) / 2.0)  # ms
    AMo = float(hist[mode_idx] / nn_ms.size * 100.0)           # %
    MxDMn = float(np.max(nn_ms) - np.min(nn_ms))               # ms
    if Mo <= 0 or MxDMn <= 0:
        return np.nan
    SI = AMo / (2.0 * (Mo / 1000.0) * (MxDMn / 1000.0))
    return float(SI) if np.isfinite(SI) else np.nan


def classify_hml(value, low, high):
    v = _as_float(value)
    if not np.isfinite(v):
        return "insuficiente"
    if v < low:
        return "bajo"
    if v > high:
        return "alto"
    return "medio"


def rmssd_reference_by_age_sex(age, sex):
    a = _as_float(age)
    s = (str(sex).upper().strip() if sex is not None else "X")

    if not np.isfinite(a):
        low, high = 25.0, 55.0
        return low, high

    a = int(a)
    if a < 20:
        low, high = 35.0, 80.0
    elif a < 30:
        low, high = 30.0, 70.0
    elif a < 40:
        low, high = 25.0, 60.0
    elif a < 50:
        low, high = 20.0, 50.0
    elif a < 60:
        low, high = 18.0, 45.0
    else:
        low, high = 15.0, 40.0

    # Ajuste mínimo opcional por sexo
    if s == "F":
        high += 2.0

    return float(low), float(high)


def autonomic_score_0_100(rmssd, lfhf, baevsky_si):
    parts = []

    r = _as_float(rmssd)
    if np.isfinite(r):
        x = np.clip((80.0 - r) / (80.0 - 15.0), 0.0, 1.0)
        parts.append(x)

    lf = _as_float(lfhf)
    if np.isfinite(lf):
        x = np.clip((lf - 1.0) / (5.0 - 1.0), 0.0, 1.0)
        parts.append(x)

    si = _as_float(baevsky_si)
    if np.isfinite(si):
        x = np.clip((si - 50.0) / (500.0 - 50.0), 0.0, 1.0)
        parts.append(x)

    if not parts:
        return np.nan
    return float(np.mean(parts) * 100.0)


def fatigue_scores_0_100(rmssd, sdnn, hr_mean):
    rm = _as_float(rmssd)
    sd = _as_float(sdnn)
    hr = _as_float(hr_mean)

    phys_parts = []
    emo_parts = []

    if np.isfinite(sd):
        phys_parts.append(np.clip((80.0 - sd) / (80.0 - 20.0), 0.0, 1.0))
    if np.isfinite(hr):
        phys_parts.append(np.clip((hr - 55.0) / (95.0 - 55.0), 0.0, 1.0))

    if np.isfinite(rm):
        emo_parts.append(np.clip((60.0 - rm) / (60.0 - 15.0), 0.0, 1.0))
    if np.isfinite(hr):
        emo_parts.append(np.clip((hr - 55.0) / (95.0 - 55.0), 0.0, 1.0))

    phys = float(np.mean(phys_parts) * 100.0) if phys_parts else np.nan
    emo = float(np.mean(emo_parts) * 100.0) if emo_parts else np.nan
    return phys, emo


def semaphore_plan(rmssd_state):
    # NO CAMBIAR tu lógica
    if rmssd_state == "bajo":
        return {
            "color": "rojo",
            "plan": [
                {"item": "Equilibrio SNA / patrón respiratorio / visualización", "pct": 60},
                {"item": "Tejido miofascial (40% tensión e intensidad)", "pct": 40},
                {"item": "Ejercicios de columna", "pct": 20},
                {"item": "Ejercicio biomecánico funcional", "pct": 10},
                {"item": "Relax", "pct": 10},
            ],
        }
    if rmssd_state == "medio":
        return {
            "color": "amarillo",
            "plan": [
                {"item": "Equilibrio SNA", "pct": 40},
                {"item": "Tejido miofascial (60% tensión e intensidad)", "pct": 60},
                {"item": "Ejercicios de columna", "pct": 20},
                {"item": "Ejercicios biomecánicos funcionales", "pct": 30},
                {"item": "Relax", "pct": 10},
            ],
        }
    if rmssd_state == "alto":
        return {
            "color": "verde",
            "plan": [
                {"item": "Equilibrio SNA", "pct": 30},
                {"item": "Tejido miofascial (máxima tensión e intensidad)", "pct": 100},
                {"item": "Ejercicios biomecánicos funcionales", "pct": 40},
                {"item": "Ejercicios de columna", "pct": 20},
                {"item": "Relax", "pct": 10},
            ],
        }
    return {"color": "gris", "plan": []}


def biomarker_meanings():
    return [
        {"biomarker": "HRV (RMSSD)", "meaning": "Variabilidad a corto plazo; asociada a modulación parasimpática (vagal) y recuperación."},
        {"biomarker": "lnRMSSD", "meaning": "RMSSD en escala log; más estable para seguimiento."},
        {"biomarker": "SDNN", "meaning": "Variabilidad global; refleja balance autonómico general."},
        {"biomarker": "LF/HF", "meaning": "Indicador aproximado de balance simpático/parasimpático (muy sensible a respiración y duración)."},
        {"biomarker": "Baevsky (SI)", "meaning": "Índice de estrés basado en distribución de RR; alto suele indicar mayor tensión autonómica."},
        {"biomarker": "Score autonómico", "meaning": "Score compuesto (0–100) que resume carga autonómica con RMSSD + LF/HF + Baevsky."},
        {"biomarker": "Fatiga física", "meaning": "Heurístico (0–100) combinando SDNN y FC media."},
        {"biomarker": "Fatiga emocional", "meaning": "Heurístico (0–100) combinando RMSSD y FC media."},
        {"biomarker": "Carga autonómica", "meaning": "Interpretación práctica del score autonómico (bajo/medio/alto)."},
    ]


def enrich_hba_dashboard(result: dict, payload: dict):
    # ✅ Si hay error, no armamos dashboard (evita basura/NaN)
    if result.get("error"):
        return result

    age = payload.get("age", None)
    sex = payload.get("sex", None)

    rmssd = _as_float(result.get("rmssd"))
    sdnn = _as_float(result.get("sdnn"))
    lnrmssd = _as_float(result.get("lnrmssd"))
    lfhf = _as_float(result.get("lf_hf"))
    hr_mean = _as_float(result.get("hr_mean"))

    baevsky = np.nan

    # Polar: usar rri_ms directo
    if str(result.get("sensor_type", "")).strip() == "polar_h10":
        rri_ms = payload.get("rri_ms", [])
        if isinstance(rri_ms, list) and len(rri_ms) >= 12:
            rr = _finite_array(np.array(rri_ms, dtype=float))
            rr_clean, _ap, _mask = clean_rri_ms(rr)
            baevsky = baevsky_index(rr_clean)

    # Cámara: recalcular RR mínimo para Baevsky (sin tocar tu lógica principal)
    if str(result.get("sensor_type", "")).strip() == "camera_ppg":
        ppg = payload.get("ppg", [])
        sr = _as_float(payload.get("sampling_rate", result.get("sampling_rate", 30)))
        try:
            ppg_arr = _finite_array(np.array(ppg, dtype=float))
            if ppg_arr.size > 0 and np.isfinite(sr) and sr > 1:
                p = ppg_arr - np.nanmean(ppg_arr)
                p = p / (np.nanstd(p) + 1e-9)
                try:
                    p = nk.signal_filter(p, sampling_rate=sr, lowcut=0.5, highcut=8.0, method="butterworth", order=3)
                except Exception:
                    pass
                _peaks, info = nk.ppg_peaks(p, sampling_rate=sr, method="elgendi")
                peaks_idx = info.get("PPG_Peaks", info.get("peaks", None))
                if peaks_idx is not None:
                    peaks_idx = np.asarray(peaks_idx, dtype=int)
                    peaks_idx = peaks_idx[(peaks_idx > 0) & (peaks_idx < len(p))]
                    if len(peaks_idx) >= 12:
                        rr_ms = np.diff(peaks_idx) / sr * 1000.0
                        rr_clean, _ap, _mask = clean_rri_ms(rr_ms)
                        baevsky = baevsky_index(rr_clean)
        except Exception:
            pass

    # Normas RMSSD por edad/sexo
    rm_low, rm_high = rmssd_reference_by_age_sex(age, sex)
    rm_state = classify_hml(rmssd, rm_low, rm_high)

    # Score autonómico + carga autonómica
    auto_score = autonomic_score_0_100(rmssd, lfhf, baevsky)
    load_state = classify_hml(auto_score, 35.0, 65.0)

    # Estrés (Baevsky)
    baev_state = classify_hml(baevsky, 150.0, 300.0)

    # Fatigas
    fat_phys, fat_emo = fatigue_scores_0_100(rmssd, sdnn, hr_mean)
    fat_phys_state = classify_hml(fat_phys, 35.0, 65.0)
    fat_emo_state = classify_hml(fat_emo, 35.0, 65.0)

    # Semáforo (tu diferenciador)
    sem = semaphore_plan(rm_state)

    biomarkers = [
        {"name": "HRV (RMSSD)", "value": rmssd, "unit": "ms", "state": rm_state,
         "detail": f"Ref edad/sexo: bajo<{rm_low:.0f} / alto>{rm_high:.0f}"},
        {"name": "lnRMSSD", "value": lnrmssd, "unit": "", "state": "informativo", "detail": ""},
        {"name": "SDNN", "value": sdnn, "unit": "ms", "state": classify_hml(sdnn, 30.0, 60.0), "detail": ""},
        {"name": "FC media", "value": hr_mean, "unit": "bpm", "state": classify_hml(hr_mean, 60.0, 85.0), "detail": ""},
        {"name": "LF/HF", "value": lfhf, "unit": "", "state": classify_hml(lfhf, 1.5, 3.0), "detail": result.get("freq_warning") or ""},
        {"name": "Índice de estrés Baevsky", "value": baevsky, "unit": "", "state": baev_state, "detail": ""},
        {"name": "Score autonómico", "value": auto_score, "unit": "/100", "state": load_state, "detail": "Más alto = más carga autonómica"},
        {"name": "Carga autonómica", "value": auto_score, "unit": "/100", "state": load_state, "detail": ""},
        {"name": "Estrés", "value": auto_score, "unit": "/100", "state": load_state, "detail": ""},
        {"name": "Fatiga física", "value": fat_phys, "unit": "/100", "state": fat_phys_state, "detail": ""},
        {"name": "Fatiga emocional", "value": fat_emo, "unit": "/100", "state": fat_emo_state, "detail": ""},
    ]

    result["hba_dashboard"] = {
        "biomarkers": biomarkers,
        "interpretation": biomarker_meanings(),
        "norms": {
            "age": age,
            "sex": sex,
            "rmssd_low": rm_low,
            "rmssd_high": rm_high,
            "rmssd_state": rm_state,
        },
        "semaphore": sem,
        "differentiator": {
            "what_distinguishes": "Semáforo HBA: traduce tu HRV (RMSSD por edad/sexo) en un plan porcentual de intervención (SNA / miofascial / columna / biomecánico / relax)."
        },
    }

    return result


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
        result = enrich_hba_dashboard(result, payload)
        return jsonify(_sanitize_for_json(result))

    if sensor_type == "camera_ppg":
        ppg = payload.get("ppg", [])
        sampling_rate = payload.get("sampling_rate", 30)
        result = compute_hrv_from_ppg(np.array(ppg, dtype=float), float(sampling_rate), duration_minutes=duration_minutes)
        result["sensor_type"] = "camera_ppg"
        result["duration_minutes"] = duration_minutes
        result = enrich_hba_dashboard(result, payload)
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
