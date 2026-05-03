"""
HBA — Heart Beat Autonomic  |  v2.0
Backend Flask refactorizado:
  - Semáforo 4 niveles con nomenclatura clínica
  - Cargas autonómica / emocional / física diferenciadas
  - Índices no lineales: SD1, SD2, DFA α1 aproximado
  - Supabase (PostgreSQL) como base de datos persistente
  - Corrección de RMSSD por duración del test (1/3/5 min)
  - Campo sexo en todos los flujos
  - Baevsky para todos los tipos de sensor
"""

import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd
from flask import Flask, render_template, request, jsonify
import neurokit2 as nk
from scipy import interpolate, signal

app = Flask(__name__)

# ─────────────────────────────────────────
# Supabase (opcional — si no hay env var, CSV fallback)
# ─────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
SUPABASE_TABLE = "hba_sessions"
CSV_FALLBACK = "dataset_hba_fallback.csv"

_supabase_client = None

def get_supabase():
    global _supabase_client
    if _supabase_client is not None:
        return _supabase_client
    if SUPABASE_URL and SUPABASE_KEY:
        try:
            from supabase import create_client
            _supabase_client = create_client(SUPABASE_URL, SUPABASE_KEY)
        except Exception:
            _supabase_client = None
    return _supabase_client


# ─────────────────────────────────────────
# Utilidades numéricas
# ─────────────────────────────────────────

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


# ─────────────────────────────────────────
# Limpieza y corrección de RR
# ─────────────────────────────────────────

def _kubios_like_artifact_mask(rr_ms: np.ndarray, win=11):
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
    bad = (rel_dev > 0.20) | (drr > 0.25)
    bad = bad | (rr < 300) | (rr > 2000)
    return bad


def _interpolate_bad(rr_ms: np.ndarray, bad_mask: np.ndarray):
    rr = np.asarray(rr_ms, dtype=float)
    bad = np.asarray(bad_mask, dtype=bool)
    n = rr.size
    if n < 3 or not np.any(bad):
        return rr
    idx = np.arange(n)
    good_idx = idx[~bad]
    if good_idx.size < 3:
        return rr
    f = interpolate.interp1d(good_idx, rr[~bad], kind="linear",
                             fill_value="extrapolate", bounds_error=False)
    out = rr.copy()
    out[bad] = f(idx[bad])
    return out


def clean_rri_ms(rri_ms: np.ndarray):
    rri_ms = _finite_array(rri_ms)
    if len(rri_ms) < 10:
        return rri_ms, np.nan, np.zeros(len(rri_ms), dtype=bool)

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

    f = interpolate.interp1d(good_idx, rri_ms[~bad], kind="linear",
                             fill_value="extrapolate", bounds_error=False)
    rri_clean = rri_ms.copy()
    rri_clean[bad] = f(idx[bad])
    return rri_clean, artifact_percent, bad


def _windowed_rr_salvage(rr_ms: np.ndarray, window_beats=40, step_beats=20, max_artifact_pct=25.0):
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
            qualities.append(100.0 - art)

    if not segments:
        bad_all = _kubios_like_artifact_mask(rr)
        rr_clean = _interpolate_bad(rr, bad_all)
        art = 100.0 * bad_all.mean()
        usable_ratio = max(0.0, 1.0 - art / 100.0)
        return rr_clean, usable_ratio, art

    order = np.argsort(qualities)[::-1]
    segments = [segments[i] for i in order]
    rr_rescued = np.concatenate(segments)[:n]

    bad_all = _kubios_like_artifact_mask(rr)
    art_global = 100.0 * bad_all.mean()
    usable_ratio = min(1.0, max(0.0, len(rr_rescued) / max(1, n)))
    return rr_rescued, usable_ratio, art_global


# ─────────────────────────────────────────
# Métricas no lineales
# ─────────────────────────────────────────

def compute_poincare(rr_ms: np.ndarray):
    """SD1, SD2 y ratio SD1/SD2 del diagrama de Poincaré."""
    rr = _finite_array(rr_ms)
    if rr.size < 10:
        return np.nan, np.nan, np.nan
    d = np.diff(rr)
    sd1 = float(np.sqrt(0.5 * np.var(d, ddof=1))) if len(d) > 1 else np.nan
    sd2 = float(np.sqrt(max(0, 2 * np.var(rr, ddof=1) - 0.5 * np.var(d, ddof=1)))) if len(d) > 1 else np.nan
    ratio = (sd1 / sd2) if (np.isfinite(sd1) and np.isfinite(sd2) and sd2 > 0) else np.nan
    return sd1, sd2, ratio


def compute_dfa_alpha1_approx(rr_ms: np.ndarray):
    """
    DFA α1 aproximado (escala corta 4-16 latidos).
    Valor normal en reposo: ~1.0–1.5. Bajo (<0.75) indica desregulación.
    """
    rr = _finite_array(rr_ms)
    n = rr.size
    if n < 32:
        return np.nan

    y = np.cumsum(rr - np.mean(rr))
    scales = [4, 6, 8, 10, 12, 16]
    fn = []
    for s in scales:
        if n < s * 2:
            continue
        segments = n // s
        f2_list = []
        for k in range(segments):
            seg = y[k*s:(k+1)*s]
            x = np.arange(s)
            p = np.polyfit(x, seg, 1)
            trend = np.polyval(p, x)
            f2_list.append(np.mean((seg - trend) ** 2))
        if f2_list:
            fn.append(np.sqrt(np.mean(f2_list)))

    if len(fn) < 3:
        return np.nan

    log_s = np.log(scales[:len(fn)])
    log_f = np.log(np.array(fn) + 1e-12)
    try:
        alpha, _ = np.polyfit(log_s, log_f, 1)
        return float(alpha) if np.isfinite(alpha) else np.nan
    except Exception:
        return np.nan


# ─────────────────────────────────────────
# HRV core
# ─────────────────────────────────────────

def _hr_basic_from_rr(rr_ms: np.ndarray):
    rr = _finite_array(rr_ms)
    if rr.size < 3:
        return np.nan, np.nan, np.nan
    hr = 60000.0 / rr
    return float(np.nanmean(hr)), float(np.nanmax(hr)), float(np.nanmin(hr))


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


# Factor de corrección RMSSD por duración del test
# Los valores normativos son para 5 min; tests más cortos tienden a sub-estimar RMSSD
_DURATION_CORRECTION = {1: 1.22, 3: 1.08, 5: 1.00}


def _duration_correction_factor(duration_minutes):
    if duration_minutes is None:
        return 1.0
    try:
        dm = float(duration_minutes)
        if dm <= 1.5:
            return _DURATION_CORRECTION[1]
        if dm <= 4.0:
            return _DURATION_CORRECTION[3]
        return _DURATION_CORRECTION[5]
    except Exception:
        return 1.0


def compute_hrv_from_rri(rri_ms: np.ndarray, duration_minutes=None):
    rri_ms = _finite_array(rri_ms)
    if len(rri_ms) < 12:
        return {"error": "Insuficientes intervalos RR (mínimo recomendado: 12).", "artifact_percent": np.nan}

    rr_rescued, usable_ratio, art_global = _windowed_rr_salvage(rri_ms, window_beats=45, step_beats=20, max_artifact_pct=25.0)
    rr_clean, art_mad, _mask = clean_rri_ms(rr_rescued)

    artifact_percent = float(
        0.65 * art_global + 0.35 * art_mad
        if np.isfinite(art_global) and np.isfinite(art_mad)
        else (art_global if np.isfinite(art_global) else (art_mad if np.isfinite(art_mad) else np.nan))
    )

    hr_mean, hr_max, hr_min = _hr_basic_from_rr(rr_clean)
    sd1, sd2, sd_ratio = compute_poincare(rr_clean)
    dfa1 = compute_dfa_alpha1_approx(rr_clean)

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
    sdnn  = g(hrv_time, "HRV_SDNN")
    pnn50 = g(hrv_time, "HRV_pNN50")
    mean_rr = g(hrv_time, "HRV_MeanNN")

    # Aplicar corrección por duración
    corr = _duration_correction_factor(duration_minutes)
    rmssd_corr = rmssd * corr if np.isfinite(rmssd) else np.nan

    lnrmssd = np.log(rmssd_corr) if np.isfinite(rmssd_corr) and rmssd_corr > 0 else np.nan

    lf  = g(hrv_freq, "HRV_LF")
    hf  = g(hrv_freq, "HRV_HF")
    tp  = g(hrv_freq, "HRV_TP")
    lfhf = (lf / hf) if (np.isfinite(lf) and np.isfinite(hf) and hf > 0) else np.nan

    freq_warning = None
    if duration_minutes is not None:
        try:
            if float(duration_minutes) < 5:
                freq_warning = "Test < 5 min: LF/HF y potencia espectral son orientativos."
        except Exception:
            pass

    quality_score = float(np.clip(100.0 - artifact_percent, 0.0, 100.0)) if np.isfinite(artifact_percent) else np.nan

    return {
        "rmssd": rmssd,
        "rmssd_corr": rmssd_corr,
        "sdnn": sdnn,
        "lnrmssd": lnrmssd,
        "pnn50": pnn50,
        "mean_rr": mean_rr,
        "lf_power": lf,
        "hf_power": hf,
        "lf_hf": lfhf,
        "total_power": tp,
        "sd1": sd1,
        "sd2": sd2,
        "sd1_sd2_ratio": sd_ratio,
        "dfa_alpha1": dfa1,
        "artifact_percent": artifact_percent,
        "usable_ratio": float(usable_ratio) if np.isfinite(usable_ratio) else None,
        "quality_score": quality_score,
        "n_rr": int(len(rr_clean)),
        "hr_mean": hr_mean,
        "hr_max": hr_max,
        "hr_min": hr_min,
        "freq_warning": freq_warning,
        "hrv_mode": hrv_mode,
        "duration_correction": corr,
    }


def _resp_rate_from_ppg_fft(ppg: np.ndarray, sampling_rate: float):
    try:
        rsp = nk.signal_filter(ppg, sampling_rate=sampling_rate, lowcut=0.1, highcut=0.4,
                               method="butterworth", order=3)
        rsp = np.asarray(rsp, dtype=float) - np.nanmean(rsp)
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
    p = np.asarray(ppg_f, dtype=float)
    n = p.size
    if n < int(sampling_rate * 10):
        return None

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

    min_dist = max(1, int(0.33 * sampling_rate))
    amp = np.percentile(p, 95) - np.percentile(p, 5)
    prom = max(0.10, 0.15 * amp)
    peaks, _ = signal.find_peaks(p, distance=min_dist, prominence=prom)
    peaks = np.asarray(peaks, dtype=int)
    peaks = peaks[(peaks > 0) & (peaks < n)]
    return peaks if peaks.size >= 12 else None


def compute_hrv_from_ppg(ppg: np.ndarray, sampling_rate: float, duration_minutes=None):
    ppg = _finite_array(ppg)
    if not (np.isfinite(sampling_rate) and sampling_rate > 1):
        return {"error": "sampling_rate inválido."}

    min_seconds = 45
    if len(ppg) < int(sampling_rate * min_seconds):
        return {"error": f"PPG insuficiente (mínimo {min_seconds}s). Recomendado 3–5 min."}

    ppg = np.asarray(ppg, dtype=float)
    ppg = (ppg - np.nanmean(ppg)) / (np.nanstd(ppg) + 1e-9)

    try:
        ppg_f = nk.signal_filter(ppg, sampling_rate=sampling_rate, lowcut=0.7, highcut=5.0,
                                 method="butterworth", order=3)
    except Exception:
        ppg_f = ppg

    peaks_idx = _ppg_peaks_robust(ppg_f, sampling_rate)
    if peaks_idx is None or len(peaks_idx) < 12:
        return {"error": "No se pudieron detectar picos PPG confiables (señal ruidosa o mal iluminada)."}

    rr_ms = np.diff(peaks_idx) / sampling_rate * 1000.0
    rr_ms = rr_ms[np.isfinite(rr_ms)]
    if len(rr_ms) < 12:
        return {"error": "PPG con RR insuficientes."}

    rr_rescued, usable_ratio, art_global = _windowed_rr_salvage(rr_ms, window_beats=45, step_beats=20, max_artifact_pct=28.0)
    rr_clean, art_mad, _mask = clean_rri_ms(rr_rescued)

    artifact_final = float(
        0.65 * art_global + 0.35 * art_mad
        if np.isfinite(art_global) and np.isfinite(art_mad)
        else (art_global if np.isfinite(art_global) else (art_mad if np.isfinite(art_mad) else np.nan))
    )

    hr_mean, hr_max, hr_min = _hr_basic_from_rr(rr_clean)
    sd1, sd2, sd_ratio = compute_poincare(rr_clean)
    dfa1 = compute_dfa_alpha1_approx(rr_clean)

    hrv_mode = "rri"
    try:
        hrv_time = nk.hrv_time(rri=rr_clean, show=False)
        hrv_freq = nk.hrv_frequency(rri=rr_clean, show=False)
    except Exception as e:
        peaks_bin = rri_to_peaks(rr_clean, sampling_rate=1000)
        if peaks_bin is None:
            return {"error": f"Fallo HRV desde RR (PPG): {str(e)}", "artifact_percent": artifact_final}
        hrv_mode = "peaks"
        try:
            hrv_time = nk.hrv_time(peaks_bin, sampling_rate=1000, show=False)
            hrv_freq = nk.hrv_frequency(peaks_bin, sampling_rate=1000, show=False)
        except Exception as e2:
            return {"error": f"Fallo HRV desde peaks (PPG): {str(e2)}", "artifact_percent": artifact_final}

    def g(df, key):
        try:
            return _as_float(df[key].iloc[0])
        except Exception:
            return np.nan

    rmssd = g(hrv_time, "HRV_RMSSD")
    sdnn  = g(hrv_time, "HRV_SDNN")
    pnn50 = g(hrv_time, "HRV_pNN50")
    mean_rr = g(hrv_time, "HRV_MeanNN")

    corr = _duration_correction_factor(duration_minutes)
    rmssd_corr = rmssd * corr if np.isfinite(rmssd) else np.nan
    lnrmssd = np.log(rmssd_corr) if np.isfinite(rmssd_corr) and rmssd_corr > 0 else np.nan

    lf  = g(hrv_freq, "HRV_LF")
    hf  = g(hrv_freq, "HRV_HF")
    tp  = g(hrv_freq, "HRV_TP")
    lfhf = (lf / hf) if (np.isfinite(lf) and np.isfinite(hf) and hf > 0) else np.nan

    resp_rpm = _resp_rate_from_ppg_fft(ppg_f, sampling_rate)

    freq_warning = None
    if duration_minutes is not None:
        try:
            if float(duration_minutes) < 5:
                freq_warning = "Test < 5 min: LF/HF y potencia espectral son orientativos."
        except Exception:
            pass

    quality_score = float(np.clip(100.0 - artifact_final, 0.0, 100.0)) if np.isfinite(artifact_final) else np.nan

    return {
        "rmssd": rmssd,
        "rmssd_corr": rmssd_corr,
        "sdnn": sdnn,
        "lnrmssd": lnrmssd,
        "pnn50": pnn50,
        "mean_rr": mean_rr,
        "lf_power": lf,
        "hf_power": hf,
        "lf_hf": lfhf,
        "total_power": tp,
        "sd1": sd1,
        "sd2": sd2,
        "sd1_sd2_ratio": sd_ratio,
        "dfa_alpha1": dfa1,
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
        "n_peaks": int(len(peaks_idx)),
        "duration_correction": corr,
    }


# ─────────────────────────────────────────
# HBA Dashboard — semáforo y diagnóstico
# ─────────────────────────────────────────

def baevsky_index(nn_ms: np.ndarray):
    nn_ms = _finite_array(nn_ms)
    if nn_ms.size < 30:
        return np.nan
    hist, edges = np.histogram(nn_ms, bins=50)
    mode_idx = int(np.argmax(hist))
    Mo  = float((edges[mode_idx] + edges[mode_idx + 1]) / 2.0)
    AMo = float(hist[mode_idx] / nn_ms.size * 100.0)
    MxDMn = float(np.max(nn_ms) - np.min(nn_ms))
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
    s = str(sex).upper().strip() if sex else "X"

    if not np.isfinite(a):
        return 25.0, 55.0

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


# ─── Semáforo clínico de 4 niveles ───────────────────────────────────────────
#
# Nomenclatura: los nombres evocan el estado del SNA y tienen sentido clínico.
#
#   ÓPTIMO       → HRV alta, sistema autonómico flexible y resiliente
#   FUNCIONAL    → HRV normal, leve activación simpática, bien compensado
#   COMPROMETIDO → HRV baja, carga autonómica elevada, requiere atención
#   CRÍTICO      → HRV muy baja o patológica, intervención prioritaria
#
# El corte entre niveles se calcula con la referencia normalizada por edad/sexo
# y un score compuesto (auto_score 0-100 donde 100 = máxima carga autonómica).
# ─────────────────────────────────────────────────────────────────────────────

SEMAPHORE_LEVELS = {
    "optimo": {
        "label": "Óptimo",
        "color": "#16a34a",       # verde oscuro clínico
        "color_light": "#dcfce7",
        "icon": "▲",
        "description": "Sistema nervioso autónomo altamente flexible. Excelente capacidad de adaptación y recuperación.",
        "plan": [
            {"item": "Carga fascial y miofascial a máxima intensidad", "pct": 100},
            {"item": "Ejercicios biomecánicos funcionales de alta demanda", "pct": 60},
            {"item": "Ejercicios de columna con carga completa", "pct": 40},
            {"item": "Equilibrio SNA (mantenimiento)", "pct": 20},
            {"item": "Relax activo post-sesión", "pct": 10},
        ]
    },
    "funcional": {
        "label": "Funcional",
        "color": "#2563eb",       # azul clínico
        "color_light": "#dbeafe",
        "icon": "●",
        "description": "HRV dentro de rango normal. Leve activación simpática, sistema bien compensado.",
        "plan": [
            {"item": "Tejido miofascial (60–70% tensión e intensidad)", "pct": 70},
            {"item": "Equilibrio SNA (respiración, coherencia)", "pct": 40},
            {"item": "Ejercicios biomecánicos funcionales", "pct": 40},
            {"item": "Ejercicios de columna", "pct": 30},
            {"item": "Relax post-sesión", "pct": 10},
        ]
    },
    "comprometido": {
        "label": "Comprometido",
        "color": "#d97706",       # ámbar clínico
        "color_light": "#fef3c7",
        "icon": "▼",
        "description": "HRV reducida. Carga autonómica elevada. Se recomienda priorizar recuperación y técnicas vagales.",
        "plan": [
            {"item": "Equilibrio SNA / patrón respiratorio / coherencia cardíaca", "pct": 60},
            {"item": "Tejido miofascial (40% tensión, técnicas suaves)", "pct": 40},
            {"item": "Ejercicios de columna (carga baja)", "pct": 20},
            {"item": "Ejercicio biomecánico funcional adaptado", "pct": 20},
            {"item": "Relax profundo", "pct": 20},
        ]
    },
    "critico": {
        "label": "Crítico",
        "color": "#dc2626",       # rojo clínico
        "color_light": "#fee2e2",
        "icon": "⚠",
        "description": "HRV muy baja o patológica. Intervención prioritaria. Derivar si persiste o hay síntomas asociados.",
        "plan": [
            {"item": "Equilibrio SNA intensivo (visualización, respiración 4-7-8)", "pct": 80},
            {"item": "Tejido miofascial muy suave (sin carga)", "pct": 20},
            {"item": "Movilidad articular pasiva", "pct": 15},
            {"item": "Relax profundo / relajación progresiva", "pct": 30},
            {"item": "Evaluación médica si persiste más de 48h", "pct": 0},
        ]
    },
}


def classify_semaphore(rmssd_corr, rmssd_low, rmssd_high, auto_score):
    """
    Determina el nivel del semáforo usando RMSSD corregido + score autonómico.
    El score autonómico pondera la carga (0 = reposo total, 100 = máxima carga).
    """
    rmssd = _as_float(rmssd_corr)
    score = _as_float(auto_score)

    if not np.isfinite(rmssd):
        return "funcional"   # sin datos suficientes, nivel conservador

    # Umbrales extendidos sobre la referencia de edad/sexo
    opt_threshold   = rmssd_high * 1.15  # 15% sobre el límite alto
    crit_threshold  = rmssd_low  * 0.65  # 35% bajo el límite bajo

    if rmssd >= opt_threshold or (np.isfinite(score) and score < 20):
        return "optimo"
    if rmssd < crit_threshold or (np.isfinite(score) and score > 75):
        return "critico"
    if rmssd >= rmssd_low:
        return "funcional"
    return "comprometido"


# ─── Cargas diferenciadas ────────────────────────────────────────────────────
#
# Carga autonómica  → balance simpático/parasimpático (LF/HF + Baevsky + RMSSD)
# Carga emocional   → tono vagal y capacidad de regulación emocional (RMSSD + pNN50 + SD1)
# Carga física      → fatiga neuromuscular y metabólica (SDNN + HR media + DFA α1)
# Estrés            → activación simpática aguda (Baevsky + LF/HF + HR vs mean_rr)
#
# Todos en escala 0-100 donde 0 = sin carga, 100 = máxima carga.
# ─────────────────────────────────────────────────────────────────────────────

def compute_cargas(rmssd, sdnn, pnn50, lf_hf, hr_mean, baevsky, sd1, dfa_alpha1):

    def _part(val, lo, hi, invert=True):
        """Normaliza val entre lo y hi. invert=True: más alto = más carga."""
        v = _as_float(val)
        if not np.isfinite(v):
            return None
        norm = np.clip((v - lo) / (hi - lo + 1e-9), 0, 1)
        return float(norm if not invert else 1 - norm)

    # ── Carga autonómica ──────────────────────────────────────────────────
    ca_parts = []
    p = _part(rmssd, 15, 80, invert=True)
    if p is not None: ca_parts.append(p * 0.40)

    p_lf = _as_float(lf_hf)
    if np.isfinite(p_lf):
        ca_parts.append(float(np.clip((p_lf - 1.0) / (5.0 - 1.0), 0, 1)) * 0.35)

    p_si = _as_float(baevsky)
    if np.isfinite(p_si):
        ca_parts.append(float(np.clip((p_si - 50) / (500 - 50), 0, 1)) * 0.25)

    carga_autonomica = float(np.sum(ca_parts) / max(sum([
        0.40 if _as_float(rmssd) is not None and np.isfinite(_as_float(rmssd)) else 0,
        0.35 if np.isfinite(_as_float(lf_hf)) else 0,
        0.25 if np.isfinite(_as_float(baevsky)) else 0,
    ]), 1e-9) * 100) if ca_parts else np.nan

    # ── Carga emocional ───────────────────────────────────────────────────
    # Eje vagal: RMSSD (corto plazo), pNN50 (frecuencia de variación rápida), SD1 (Poincaré corto)
    ce_parts = []
    w_total = 0
    for val, lo, hi, w in [
        (rmssd, 15, 70,  0.45),
        (pnn50,  2, 40,  0.30),
        (sd1,    8, 50,  0.25),
    ]:
        v = _as_float(val)
        if np.isfinite(v):
            ce_parts.append(float(np.clip(1 - (v - lo) / (hi - lo + 1e-9), 0, 1)) * w)
            w_total += w

    carga_emocional = float(np.sum(ce_parts) / max(w_total, 1e-9) * 100) if ce_parts else np.nan

    # ── Carga física ──────────────────────────────────────────────────────
    # SDNN refleja variabilidad global (fatiga la reduce), HR media sube con esfuerzo,
    # DFA α1 < 0.75 indica desregulación por fatiga neuromuscular acumulada.
    cf_parts = []
    w_total = 0
    for val, lo, hi, inv, w in [
        (sdnn,       20,  80, True,  0.40),
        (hr_mean,    55,  95, False, 0.35),
        (dfa_alpha1, 0.5, 1.5, True, 0.25),
    ]:
        v = _as_float(val)
        if np.isfinite(v):
            norm = np.clip((v - lo) / (hi - lo + 1e-9), 0, 1)
            cf_parts.append(float(norm if not inv else 1 - norm) * w)
            w_total += w

    carga_fisica = float(np.sum(cf_parts) / max(w_total, 1e-9) * 100) if cf_parts else np.nan

    # ── Estrés ────────────────────────────────────────────────────────────
    # Activación simpática aguda: Baevsky (el más directo), LF/HF, HR vs RR esperado
    es_parts = []
    w_total = 0
    for val, lo, hi, w in [
        (baevsky, 50,  500, 0.50),
        (lf_hf,   1.0, 5.0, 0.30),
        (hr_mean, 55,  95,  0.20),
    ]:
        v = _as_float(val)
        if np.isfinite(v):
            es_parts.append(float(np.clip((v - lo) / (hi - lo + 1e-9), 0, 1)) * w)
            w_total += w

    estres = float(np.sum(es_parts) / max(w_total, 1e-9) * 100) if es_parts else np.nan

    def _level(score):
        if not np.isfinite(score):
            return "insuficiente"
        if score < 30: return "bajo"
        if score < 60: return "moderado"
        if score < 80: return "alto"
        return "muy alto"

    return {
        "carga_autonomica":  {"value": carga_autonomica,  "level": _level(carga_autonomica)},
        "carga_emocional":   {"value": carga_emocional,   "level": _level(carga_emocional)},
        "carga_fisica":      {"value": carga_fisica,       "level": _level(carga_fisica)},
        "estres":            {"value": estres,             "level": _level(estres)},
    }


def enrich_hba_dashboard(result: dict, payload: dict):
    if result.get("error"):
        return result

    age  = payload.get("age", None)
    sex  = payload.get("sex", None)

    rmssd      = _as_float(result.get("rmssd"))
    rmssd_corr = _as_float(result.get("rmssd_corr", result.get("rmssd")))
    sdnn       = _as_float(result.get("sdnn"))
    lnrmssd    = _as_float(result.get("lnrmssd"))
    pnn50      = _as_float(result.get("pnn50"))
    lfhf       = _as_float(result.get("lf_hf"))
    hr_mean    = _as_float(result.get("hr_mean"))
    sd1        = _as_float(result.get("sd1"))
    sd2        = _as_float(result.get("sd2"))
    dfa1       = _as_float(result.get("dfa_alpha1"))

    # Baevsky — calculado para cualquier sensor que tenga RR
    baevsky = np.nan
    rri_source = []

    sensor = str(result.get("sensor_type", "")).strip()
    if sensor in ("polar_h10", "rr_upload"):
        rri_raw = payload.get("rri_ms", [])
        if isinstance(rri_raw, list) and len(rri_raw) >= 12:
            rri_source = rri_raw
    elif sensor == "camera_ppg":
        # reconstruir RR desde peaks si disponible, sino saltar
        pass

    if rri_source:
        rr = _finite_array(np.array(rri_source, dtype=float))
        rr_clean, _ap, _mask = clean_rri_ms(rr)
        baevsky = baevsky_index(rr_clean)

    rm_low, rm_high = rmssd_reference_by_age_sex(age, sex)
    rm_state = classify_hml(rmssd_corr, rm_low, rm_high)

    cargas = compute_cargas(rmssd_corr, sdnn, pnn50, lfhf, hr_mean, baevsky, sd1, dfa1)
    ca_score = cargas["carga_autonomica"]["value"]

    sem_key  = classify_semaphore(rmssd_corr, rm_low, rm_high, ca_score)
    sem_data = SEMAPHORE_LEVELS[sem_key]

    biomarkers = [
        {
            "name": "HRV — RMSSD",
            "value": rmssd,
            "value_corr": rmssd_corr,
            "unit": "ms",
            "state": rm_state,
            "detail": f"Ref edad/sexo: bajo < {rm_low:.0f} / alto > {rm_high:.0f} ms"
        },
        {
            "name": "lnRMSSD",
            "value": lnrmssd,
            "unit": "",
            "state": "informativo",
            "detail": "Logaritmo natural del RMSSD corregido"
        },
        {
            "name": "SDNN",
            "value": sdnn,
            "unit": "ms",
            "state": classify_hml(sdnn, 30.0, 60.0),
            "detail": "Variabilidad global"
        },
        {
            "name": "FC media",
            "value": hr_mean,
            "unit": "bpm",
            "state": classify_hml(hr_mean, 60.0, 85.0),
            "detail": ""
        },
        {
            "name": "LF/HF",
            "value": lfhf,
            "unit": "",
            "state": classify_hml(lfhf, 1.5, 3.0),
            "detail": result.get("freq_warning") or ""
        },
        {
            "name": "Índice de Baevsky (SI)",
            "value": baevsky,
            "unit": "",
            "state": classify_hml(baevsky, 150.0, 300.0),
            "detail": "Alto SI = mayor tensión autonómica"
        },
        {
            "name": "SD1 (Poincaré)",
            "value": sd1,
            "unit": "ms",
            "state": classify_hml(sd1, 10.0, 50.0),
            "detail": "Variabilidad latido a latido (vagal)"
        },
        {
            "name": "SD2 (Poincaré)",
            "value": sd2,
            "unit": "ms",
            "state": classify_hml(sd2, 20.0, 80.0),
            "detail": "Variabilidad a largo plazo"
        },
        {
            "name": "DFA α1",
            "value": dfa1,
            "unit": "",
            "state": classify_hml(dfa1, 0.75, 1.5),
            "detail": "< 0.75 indica desregulación autonómica"
        },
    ]

    result["hba_dashboard"] = {
        "biomarkers": biomarkers,
        "cargas": cargas,
        "norms": {
            "age": age,
            "sex": sex,
            "rmssd_low": rm_low,
            "rmssd_high": rm_high,
            "rmssd_state": rm_state,
        },
        "semaphore": {
            "key": sem_key,
            "label": sem_data["label"],
            "color": sem_data["color"],
            "color_light": sem_data["color_light"],
            "icon": sem_data["icon"],
            "description": sem_data["description"],
            "plan": sem_data["plan"],
        },
    }
    return result


# ─────────────────────────────────────────
# Persistencia — Supabase o CSV fallback
# ─────────────────────────────────────────

DB_COLUMNS = [
    "timestamp_utc", "patient_id", "age", "sex", "comorbidities",
    "sensor_type", "duration_minutes",
    "rmssd", "rmssd_corr", "sdnn", "lnrmssd", "pnn50", "mean_rr",
    "lf_power", "hf_power", "lf_hf", "total_power",
    "sd1", "sd2", "sd1_sd2_ratio", "dfa_alpha1",
    "artifact_percent", "quality_score", "usable_ratio",
    "hr_mean", "hr_max", "hr_min", "resp_rate_rpm",
    "carga_autonomica", "carga_emocional", "carga_fisica", "estres",
    "semaphore_key", "semaphore_label",
    "baevsky", "freq_warning", "notes",
]


def save_session(row: dict):
    sb = get_supabase()
    if sb:
        try:
            sb.table(SUPABASE_TABLE).insert(row).execute()
            return {"backend": "supabase", "ok": True}
        except Exception as e:
            # Fallback a CSV si Supabase falla
            _csv_append(row)
            return {"backend": "csv_fallback", "ok": True, "warning": str(e)}
    else:
        _csv_append(row)
        return {"backend": "csv_local", "ok": True}


def _csv_append(row: dict):
    df_row = pd.DataFrame([{c: row.get(c, "") for c in DB_COLUMNS}])
    if os.path.exists(CSV_FALLBACK):
        df = pd.read_csv(CSV_FALLBACK)
        for c in DB_COLUMNS:
            if c not in df.columns:
                df[c] = ""
        df = pd.concat([df[DB_COLUMNS], df_row], ignore_index=True)
    else:
        df = df_row
    df.to_csv(CSV_FALLBACK, index=False)


# ─────────────────────────────────────────
# Flask routes
# ─────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/compute", methods=["POST"])
def api_compute():
    payload = request.get_json(force=True) or {}
    sensor_type      = str(payload.get("sensor_type", "")).strip()
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

    if sensor_type == "rr_upload":
        rri_ms = payload.get("rri_ms", [])
        result = compute_hrv_from_rri(np.array(rri_ms, dtype=float), duration_minutes=duration_minutes)
        result["sensor_type"] = "rr_upload"
        result["duration_minutes"] = duration_minutes
        result = enrich_hba_dashboard(result, payload)
        return jsonify(_sanitize_for_json(result))

    return jsonify(_sanitize_for_json({
        "error": "sensor_type inválido. Use 'camera_ppg', 'polar_h10' o 'rr_upload'."
    })), 400


@app.route("/api/save", methods=["POST"])
def api_save():
    payload  = request.get_json(force=True) or {}
    metrics  = payload.get("metrics", {}) or {}
    dash     = metrics.get("hba_dashboard", {}) or {}
    cargas   = dash.get("cargas", {}) or {}
    sem      = dash.get("semaphore", {}) or {}

    row = {
        "timestamp_utc":    datetime.now(timezone.utc).isoformat(),
        "patient_id":       str(payload.get("patient_id", "")).strip(),
        "age":              payload.get("age", ""),
        "sex":              str(payload.get("sex", "")).strip().upper(),
        "comorbidities":    str(payload.get("comorbidities", "")).strip(),
        "notes":            str(payload.get("notes", "")).strip(),
        "sensor_type":      metrics.get("sensor_type", ""),
        "duration_minutes": metrics.get("duration_minutes", ""),
        "rmssd":            metrics.get("rmssd", ""),
        "rmssd_corr":       metrics.get("rmssd_corr", ""),
        "sdnn":             metrics.get("sdnn", ""),
        "lnrmssd":          metrics.get("lnrmssd", ""),
        "pnn50":            metrics.get("pnn50", ""),
        "mean_rr":          metrics.get("mean_rr", ""),
        "lf_power":         metrics.get("lf_power", ""),
        "hf_power":         metrics.get("hf_power", ""),
        "lf_hf":            metrics.get("lf_hf", ""),
        "total_power":      metrics.get("total_power", ""),
        "sd1":              metrics.get("sd1", ""),
        "sd2":              metrics.get("sd2", ""),
        "sd1_sd2_ratio":    metrics.get("sd1_sd2_ratio", ""),
        "dfa_alpha1":       metrics.get("dfa_alpha1", ""),
        "artifact_percent": metrics.get("artifact_percent", ""),
        "quality_score":    metrics.get("quality_score", ""),
        "usable_ratio":     metrics.get("usable_ratio", ""),
        "hr_mean":          metrics.get("hr_mean", ""),
        "hr_max":           metrics.get("hr_max", ""),
        "hr_min":           metrics.get("hr_min", ""),
        "resp_rate_rpm":    metrics.get("resp_rate_rpm", ""),
        "carga_autonomica": cargas.get("carga_autonomica", {}).get("value", ""),
        "carga_emocional":  cargas.get("carga_emocional",  {}).get("value", ""),
        "carga_fisica":     cargas.get("carga_fisica",     {}).get("value", ""),
        "estres":           cargas.get("estres",           {}).get("value", ""),
        "semaphore_key":    sem.get("key", ""),
        "semaphore_label":  sem.get("label", ""),
        "baevsky":          next(
            (b.get("value") for b in (dash.get("biomarkers") or []) if "Baevsky" in b.get("name", "")),
            ""
        ),
        "freq_warning":     metrics.get("freq_warning", ""),
    }

    save_result = save_session(row)
    return jsonify({"ok": True, **save_result})


@app.route("/api/history", methods=["GET"])
def api_history():
    """Devuelve las últimas 100 sesiones del paciente (por patient_id)."""
    patient_id = request.args.get("patient_id", "").strip()
    if not patient_id:
        return jsonify({"error": "patient_id requerido"}), 400

    sb = get_supabase()
    if sb:
        try:
            res = (sb.table(SUPABASE_TABLE)
                   .select("*")
                   .eq("patient_id", patient_id)
                   .order("timestamp_utc", desc=True)
                   .limit(100)
                   .execute())
            return jsonify({"data": res.data or []})
        except Exception as e:
            return jsonify({"error": str(e)}), 500
    else:
        if os.path.exists(CSV_FALLBACK):
            df = pd.read_csv(CSV_FALLBACK)
            df = df[df["patient_id"] == patient_id].tail(100)
            return jsonify({"data": df.to_dict(orient="records")})
        return jsonify({"data": []})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
