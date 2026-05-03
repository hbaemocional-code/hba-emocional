# HBA v2.0 — Heart Beat Autonomic

Análisis de HRV con semáforo clínico, cargas diferenciadas y múltiples sensores.

---

## Stack

| Capa       | Tecnología |
|------------|-----------|
| Backend    | Python 3.11 · Flask · NeuroKit2 · NumPy / SciPy |
| Frontend   | HTML5 · CSS3 · JavaScript vanilla · Chart.js |
| Base de datos | Supabase (PostgreSQL gratuito y persistente) |
| Deploy     | Railway (free tier — sin sleep, sin límite de 1 mes) |

---

## Deploy en Railway (5 minutos)

1. **Fork o subí este repo a GitHub**

2. **Creá cuenta en [railway.app](https://railway.app)**

3. **New Project → Deploy from GitHub repo → elegí tu repo**

4. **Variables de entorno** (en Railway > Variables):
   ```
   SUPABASE_URL       = https://xxxxxxxxxxxx.supabase.co
   SUPABASE_ANON_KEY  = eyJxxxx...
   ```

5. Railway detecta el `Procfile` automáticamente y hace deploy.

6. **Dominio**: Railway asigna un dominio HTTPS gratuito (ej: `hba-production.up.railway.app`).  
   Web Bluetooth (Polar H10) requiere HTTPS — Railway lo provee por defecto. ✓

---

## Configuración de Supabase

1. Creá cuenta en [supabase.com](https://supabase.com)
2. Nuevo proyecto → anotá la URL y la `anon key`
3. Ve a **SQL Editor** y pegá el contenido de `supabase_schema.sql`
4. Ejecutá → tabla `hba_sessions` creada

---

## Sensores disponibles

| Sensor | Precisión | Notas |
|--------|-----------|-------|
| **Polar H10 (BLE)** | ★★★★★ | Requiere Chrome/Edge + HTTPS |
| **Cámara PPG (dedo)** | ★★★★☆ | El más accesible, buena señal |
| **rPPG (rostro)** | ★★☆☆☆ | Orientativo, muy sensible a luz y movimiento |
| **Vibración SCG** | ★★★☆☆ | Requiere celular sobre esternón, 1 min |
| **Importar RR (CSV/JSON)** | ★★★★★ | Compatible con Polar App, Kubios, Garmin |

---

## Semáforo clínico

| Estado | Color | Significado |
|--------|-------|-------------|
| **Óptimo** | 🟢 Verde | SNA altamente flexible, máxima capacidad adaptativa |
| **Funcional** | 🔵 Azul | HRV normal, leve activación simpática, bien compensado |
| **Comprometido** | 🟡 Ámbar | HRV reducida, requiere recuperación y técnicas vagales |
| **Crítico** | 🔴 Rojo | HRV muy baja o patológica, intervención prioritaria |

---

## Cargas diferenciadas

- **Carga autonómica**: balance simpático/parasimpático (RMSSD + LF/HF + Baevsky)
- **Carga emocional**: tono vagal y regulación emocional (RMSSD + pNN50 + SD1)
- **Carga física**: fatiga neuromuscular (SDNN + FC + DFA α1)
- **Estrés**: activación simpática aguda (Baevsky + LF/HF + FC)

Todas en escala 0–100 (0 = sin carga, 100 = máxima carga).

---

## Variables de entorno

```env
SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
SUPABASE_ANON_KEY=eyJxxxx...
```

Si no se configuran, los datos se guardan en `dataset_hba_fallback.csv` (efímero en Railway).

---

## Desarrollo local

```bash
pip install -r requirements.txt
python app.py
# → http://localhost:5000
```

Para Polar H10 en local necesitás HTTPS. Usá ngrok:
```bash
ngrok http 5000
```

---

## Licencia

Uso científico / rehabilitación. No reemplaza diagnóstico médico profesional.
