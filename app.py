import os
from datetime import datetime

import numpy as np
import pandas as pd
from flask import Flask, render_template, request, jsonify
import neurokit2 as nk
from scipy import interpolate, signal

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
# Calidad RR + Corrección (mejorada)
# ============================

def clean_rri_ms(rri_ms: np.ndarray):
    """
    Limpieza/corrección de RR (ms):
    - Rechazo fisiológico tolerante: 300–2000 ms (30–200 bpm)
    - Outliers robustos (MAD)
    - Corrección por interpolación
    """
    rri_ms = _finite_array(rri_ms)

    if len(rri_ms) < 10:
        return rri_ms, np.nan, np.zeros(len(rri_ms), dtype=bool)

    # más realista para humanos (evita HR min 28 / HR max 240 por ruido)
    bad = (rri_ms < 300) | (rri_ms > 2000)

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


def _kubios_like_artifact_mask(rr_ms: np.ndarray, win=11):
    """
    Heurística estilo Kubios:
    - compara cada RR contra mediana local
    - marca artefacto si desviación relativa es alta
    - y/o si el salto dRR es demasiado grande
    """
    rr = _finite_array(rr_ms)
    n = rr.size
    if n < 15:
        return np.zeros(n, dtype=bool)

    w = int(win) if int(win) % 2 == 1 else int(win) + 1
    w = max(7, min(w, 21))
    half = w // 2

    med_local = np.zeros(n)
    for i in range(n):
        a = max(0, i - half)
        b = min(n, i + half + 1)
        med_local[i] = np.median(rr[a:b])

    rel_dev = np.abs(rr - med_local) / (med_local + 1e-9)
    drr = np.abs(np.diff(rr, prepend=rr[0])) / (med_local + 1e-9)

    # thresholds conservadores (no matar test por micro-ruido)
    # rel_dev > 0.20 = 20% fuera de mediana local
    # drr > 0.25 = salto de 25%
    bad = (rel_dev > 0.20) | (drr > 0.25)

    # también fisiológico
    bad = bad | (rr < 300) | (rr > 2000)
    return bad


def _interpolate_bad(rr_ms: np.ndarray, bad_mask: np.ndarray):
    rr = np.asarray(rr_ms, dtype=float)
    bad = np.asarray(bad_mask, dtype=bool)
    n = rr.size
    if n < 3:
        return rr

    if not np.any(bad):
        return rr

    idx = np.arange(n)
    good_idx = idx[~bad]
    if good_idx.size < 3:
        # no se puede interpolar bien
        return rr

    f = interpolate.interp1d(
        good_idx, rr[~bad], kind="linear",
        fill_value="extrapolate", bounds_error=False
    )
    out = rr.copy()
    out[bad] = f(idx[bad])
    return out


def _windowed_rr_salvage(rr_ms: np.ndarray, window_beats=40, step_beats=20, max_artifact_pct=25.0):
    """
    Rescata segmentos de RR de mejor calidad (no rompe test).
    - Trabaja en el dominio de beats (robusto incluso si no hay timestamps).
    - Devuelve rr_rescued, usable_ratio, artifact_percent_global
    """
    rr = _finite_array(rr_ms)
    n = rr.size
    if n < 20:
        return rr, 0.0, np.nan

    w = max(25, int(window_beats))
    s = max(10, int(step_beats))

    segments = []
    qualities = []

    for start in range(0, n - w + 1, s):
        seg = rr[start:start + w]
        bad = _kubios_like_artifact_mask(seg)
        art = 100.0 * bad.mean()
        if art <= max_artifact_pct:
            seg_clean = _interpolate_bad(seg, bad)
            segments.append(seg_clean)
            # score: más alto = mejor
            qualities.append(100.0 - art)

    if not segments:
        # fallback: limpiar todo, pero no tirar error
        bad_all = _kubios_like_artifact_mask(rr)
        rr_clean = _interpolate_bad(rr, bad_all)
        art = 100.0 * bad_all.mean()
        usable_ratio = max(0.0, 1.0 - art / 100.0)
        return rr_clean, usable_ratio, art

    # elegir top segmentos y concatenar (evita zonas malas)
    order = np.argsort(qualities)[::-1]
    segments = [segments[i] for i in order]

    rr_rescued = np.concatenate(segments)
    rr_rescued = rr_rescued[:n]  # no crecer indefinidamente

    # artefactos globales estimados desde rr original
    bad_all = _kubios_like_artifact_mask(rr)
    art_global = 100.0 * bad_all.mean()

    usable_ratio = min(1.0, max(0.0, len(rr_rescued) / max(1, n)))
    return rr_rescued, usable_ratio, art_global


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
# HRV Backend (robusto)
# ============================

def _hr_basic_from_rr(rr_ms: np.ndarray):
    rr = _finite_array(rr_ms)
    if rr.size < 3:
        return np.nan, np.nan, np.nan
    hr = 60000.0 / rr
    return float(np.nanmean(hr)), float(np.nanmax(hr)), float(np.nanmin(hr))


def compute_hrv_from_rri(rri_ms: np.ndarray, duration_minutes=None):
    rri_ms = _finite_array(rri_ms)

    if len(rri_ms) < 12:
        return {"error": "Insuficientes intervalos RR (mínimo recomendado: 12).", "artifact_percent": np.nan}

    # 1) limpieza robusta tipo Kubios + salvataje
    rr_rescued, usable_ratio, art_global = _windowed_rr_salvage(rri_ms, window_beats=45, step_beats=20, max_artifact_pct=25.0)

    # 2) además, clean_rri_ms (fisiológico + MAD) como segunda capa
    rr_clean, art_mad, _mask = clean_rri_ms(rr_rescued)

    # artefact_percent final (mezcla conservadora)
    if np.isfinite(art_global) and np.isfinite(art_mad):
        artifact_percent = float(0.65 * art_global + 0.35 * art_mad)
    elif np.isfinite(art_global):
        artifact_percent = float(art_global)
    else:
        artifact_percent = float(art_mad) if np.isfinite(art_mad) else np.nan

    hr_mean, hr_max, hr_min = _hr_basic_from_rr(rr_clean)

    # 3) HRV con NK2 (rri o fallback peaks)
    hrv_mode = "rri"
    try:
        hrv_time = nk.hrv_time(rri=rr_clean, show=False)
        hrv_freq = nk.hrv_frequency(rri=rr_clean, show=False)
    except Exception:
        peaks = rri_to_peaks(rr_clean, sampling_rate=1000)
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

    # 4) quality_score (0-100) y usable_ratio (0-1)
    # cuanto menos artefacto, más score; usable_ratio rescate real de tramos
    quality_score = np.nan
    if np.isfinite(artifact_percent):
        quality_score = float(np.clip(100.0 - artifact_percent, 0.0, 100.0))

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
        "usable_ratio": float(usable_ratio) if np.isfinite(usable_ratio) else None,
        "quality_score": quality_score,
        "n_rr": int(len(rr_clean)),
        "hr_mean": hr_mean,
        "hr_max": hr_max,
        "hr_min": hr_min,
        "freq_warning": freq_warning,
        "hrv_mode": hrv_mode
    }


def _resp_rate_from_ppg_fft(ppg: np.ndarray, sampling_rate: float):
    try:
        rsp = nk.signal_filter(ppg, sampling_rate=sampling_rate, lowcut=0.1, highcut=0.4,
                              method="butterworth", order=3)
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


def _ppg_peaks_robust(ppg_f: np.ndarray, sampling_rate: float):
    """
    Picos robustos:
    - intenta NK2 elgendi
    - si falla o da pocos picos, fallback a find_peaks con prominencia adaptativa
    """
    p = np.asarray(ppg_f, dtype=float)
    n = p.size
    if n < int(sampling_rate * 10):
        return None

    # 1) intento NK2
    try:
        _peaks, info = nk.ppg_peaks(p, sampling_rate=sampling_rate, method="elgendi")
        peaks_idx = info.get("PPG_Peaks", info.get("peaks", None))
        if peaks_idx is not None:
            peaks_idx = np.asarray(peaks_idx, dtype=int)
            peaks_idx = peaks_idx[(peaks_idx > 0) & (peaks_idx < n)]
            if peaks_idx.size >= 12:
                return peaks_idx
    except Exception:
        pass

    # 2) fallback scipy.find_peaks con parámetros fisiológicos
    # HR 40–180 -> RR 333–1500ms
    min_dist = int((0.33) * sampling_rate)  # 333 ms
    min_dist = max(1, min_dist)

    # prominencia adaptativa por percentiles (evita detección por ruido)
    amp = np.percentile(p, 95) - np.percentile(p, 5)
    prom = max(0.10, 0.15 * amp)  # conservador

    peaks, _ = signal.find_peaks(p, distance=min_dist, prominence=prom)
    peaks = np.asarray(peaks, dtype=int)
    peaks = peaks[(peaks > 0) & (peaks < n)]
    if peaks.size < 12:
        return None
    return peaks


def compute_hrv_from_ppg(ppg: np.ndarray, sampling_rate: float, duration_minutes=None):
    """
    HRV desde PPG (cámara):
    - Filtrado tolerante (0.7–5.0 Hz) para evitar picos fantasmas
    - Peaks robustos (NK2 + fallback find_peaks)
    - RR -> limpieza Kubios-like + salvataje por ventanas
    - HRV en NK2 con fallback
    """
    ppg = _finite_array(ppg)
    if sampling_rate is None or not np.isfinite(sampling_rate) or sampling_rate <= 1:
        return {"error": "sampling_rate inválido."}

    min_seconds = 45
    if len(ppg) < int(sampling_rate * min_seconds):
        return {"error": f"PPG insuficiente (mínimo {min_seconds}s). Recomendado 3–5 min."}

    ppg = np.asarray(ppg, dtype=float)
    ppg = ppg - np.nanmean(ppg)
    std = np.nanstd(ppg) + 1e-9
    ppg = ppg / std

    # filtro más realista para HRV en PPG (reduce ruido alta frecuencia)
    try:
        ppg_f = nk.signal_filter(
            ppg,
            sampling_rate=sampling_rate,
            lowcut=0.7,
            highcut=5.0,
            method="butterworth",
            order=3
        )
    except Exception:
        ppg_f = ppg

    peaks_idx = _ppg_peaks_robust(ppg_f, sampling_rate)
    if peaks_idx is None or len(peaks_idx) < 12:
        return {"error": "No se pudieron detectar picos PPG confiables (señal ruidosa o mal iluminada)."}

    # RR (ms)
    rr_ms = np.diff(peaks_idx) / sampling_rate * 1000.0
    rr_ms = rr_ms[np.isfinite(rr_ms)]
    if len(rr_ms) < 12:
        return {"error": "PPG con RR insuficientes (muy pocos intervalos)."}

    # 1) salvataje tipo Kubios + ventanas
    rr_rescued, usable_ratio, art_global = _windowed_rr_salvage(rr_ms, window_beats=45, step_beats=20, max_artifact_pct=28.0)

    # 2) segunda capa MAD fisiológico
    rr_clean, art_mad, _mask = clean_rri_ms(rr_rescued)

    # artefactos final
    if np.isfinite(art_global) and np.isfinite(art_mad):
        artifact_final = float(0.65 * art_global + 0.35 * art_mad)
    elif np.isfinite(art_global):
        artifact_final = float(art_global)
    else:
        artifact_final = float(art_mad) if np.isfinite(art_mad) else np.nan

    hr_mean, hr_max, hr_min = _hr_basic_from_rr(rr_clean)

    # HRV con NK2 (rri fallback peaks)
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

    quality_score = np.nan
    if np.isfinite(artifact_final):
        quality_score = float(np.clip(100.0 - artifact_final, 0.0, 100.0))

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
        "usable_ratio": float(usable_ratio) if np.isfinite(usable_ratio) else None,
        "quality_score": quality_score,
        "n_samples": int(len(ppg)),
        "sampling_rate": float(sampling_rate),
        "hr_mean": hr_mean,
        "hr_max": hr_max,
        "hr_min": hr_min,
        "resp_rate_rpm": resp_rpm,
        "freq_warning": freq_warning,
        "hrv_mode": hrv_mode,
        "n_rr": int(len(rr_clean)),
        "n_peaks": int(len(peaks_idx))
    }


# ============================
# HBA Dashboard (CUADROS + SEMÁFORO)  (TU CÓDIGO ORIGINAL - intacto)
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
    if rmssd_state == "bajo":
        return {"color": "rojo", "plan": [
            {"item": "Equilibrio SNA / patrón respiratorio / visualización", "pct": 60},
            {"item": "Tejido miofascial (40% tensión e intensidad)", "pct": 40},
            {"item": "Ejercicios de columna", "pct": 20},
            {"item": "Ejercicio biomecánico funcional", "pct": 10},
            {"item": "Relax", "pct": 10},
        ]}
    if rmssd_state == "medio":
        return {"color": "amarillo", "plan": [
            {"item": "Equilibrio SNA", "pct": 40},
            {"item": "Tejido miofascial (60% tensión e intensidad)", "pct": 60},
            {"item": "Ejercicios de columna", "pct": 20},
            {"item": "Ejercicios biomecánicos funcionales", "pct": 30},
            {"item": "Relax", "pct": 10},
        ]}
    if rmssd_state == "alto":
        return {"color": "verde", "plan": [
            {"item": "Equilibrio SNA", "pct": 30},
            {"item": "Tejido miofascial (máxima tensión e intensidad)", "pct": 100},
            {"item": "Ejercicios biomecánicos funcionales", "pct": 40},
            {"item": "Ejercicios de columna", "pct": 20},
            {"item": "Relax", "pct": 10},
        ]}
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

    if str(result.get("sensor_type", "")).strip() == "polar_h10":
        rri_ms = payload.get("rri_ms", [])
        if isinstance(rri_ms, list) and len(rri_ms) >= 12:
            rr = _finite_array(np.array(rri_ms, dtype=float))
            rr_clean, _ap, _mask = clean_rri_ms(rr)
            baevsky = baevsky_index(rr_clean)

    if str(result.get("sensor_type", "")).strip() == "camera_ppg":
        ppg = payload.get("ppg", [])
        sr = _as_float(payload.get("sampling_rate", result.get("sampling_rate", 30)))
        try:
            ppg_arr = _finite_array(np.array(ppg, dtype=float))
            if ppg_arr.size > 0 and np.isfinite(sr) and sr > 1:
                p = ppg_arr - np.nanmean(ppg_arr)
                p = p / (np.nanstd(p) + 1e-9)
                try:
                    p = nk.signal_filter(p, sampling_rate=sr, lowcut=0.7, highcut=5.0,
                                         method="butterworth", order=3)
                except Exception:
                    pass
                peaks_idx = _ppg_peaks_robust(p, sr)
                if peaks_idx is not None and len(peaks_idx) >= 12:
                    rr_ms = np.diff(peaks_idx) / sr * 1000.0
                    rr_clean, _ap, _mask = clean_rri_ms(rr_ms)
                    baevsky = baevsky_index(rr_clean)
        except Exception:
            pass

    rm_low, rm_high = rmssd_reference_by_age_sex(age, sex)
    rm_state = classify_hml(rmssd, rm_low, rm_high)

    auto_score = autonomic_score_0_100(rmssd, lfhf, baevsky)
    load_state = classify_hml(auto_score, 35.0, 65.0)

    baev_state = classify_hml(baevsky, 150.0, 300.0)

    fat_phys, fat_emo = fatigue_scores_0_100(rmssd, sdnn, hr_mean)
    fat_phys_state = classify_hml(fat_phys, 35.0, 65.0)
    fat_emo_state = classify_hml(fat_emo, 35.0, 65.0)

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
        "norms": {"age": age, "sex": sex, "rmssd_low": rm_low, "rmssd_high": rm_high, "rmssd_state": rm_state},
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
    "quality_score",
    "usable_ratio",
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
        "quality_score": metrics.get("quality_score", ""),
        "usable_ratio": metrics.get("usable_ratio", ""),
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
