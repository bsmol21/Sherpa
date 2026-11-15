"""
suelo.py  -  Capa OPCIONAL de tipo de suelo (inercia termica THEMIS) y polvo
superficial (TES) para el visor de rutas.

Lee datos/procesados/suelo.json (lo genera pipeline/preparar_termica_polvo.py)
y lleva la inercia termica a la rejilla del visor (interpolacion bilineal).

Si el archivo no existe o falla algo, cargar() devuelve None y el visor
funciona exactamente igual que sin esta capa. No afecta al calculo de rutas.
"""

import json
import os

import numpy as np

RUTA_DEFECTO = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "datos", "procesados", "suelo.json"))


def remuestrear(ti, celda_ti, nf, nc, celda):
    """Interpola la rejilla `ti` (celdas de `celda_ti` m) a nf x nc celdas de
    `celda` m. Ambas empiezan en la esquina superior izquierda del mapa."""
    f = ((np.arange(nf) + 0.5) * celda / celda_ti - 0.5)[:, None]
    c = ((np.arange(nc) + 0.5) * celda / celda_ti - 0.5)[None, :]
    f = np.clip(f, 0, ti.shape[0] - 1)
    c = np.clip(c, 0, ti.shape[1] - 1)
    f0 = np.minimum(np.floor(f).astype(int), ti.shape[0] - 2)
    c0 = np.minimum(np.floor(c).astype(int), ti.shape[1] - 2)
    ff, fc = f - f0, c - c0
    a, b = ti[f0, c0], ti[f0, c0 + 1]
    d, e = ti[f0 + 1, c0], ti[f0 + 1, c0 + 1]
    return (a * (1 - fc) + b * fc) * (1 - ff) + (d * (1 - fc) + e * fc) * ff


def cargar(z, celda, ruta_json=RUTA_DEFECTO):
    """Prepara la capa para un terreno `z` (NaN = sin datos) con celdas de
    `celda` m. Devuelve dict(meta=..., ti=bytes float32, NaN = sin dato) o None."""
    if not os.path.exists(ruta_json):
        return None
    try:
        with open(ruta_json, "r", encoding="utf-8") as f:
            d = json.load(f)
        ti = np.array(d["ti"], dtype=np.float32).reshape(d["nf"], d["nc"])
        ti[ti < 0] = np.nan
        nf, nc = z.shape
        capa = remuestrear(ti, float(d["celda"]), nf, nc, celda).astype(np.float32)
        capa[np.isnan(z)] = np.nan
        validos = capa[~np.isnan(capa)]
        clases, desde = [], -np.inf
        for cl in d["clases"]:
            hasta = np.inf if cl.get("hasta") is None else float(cl["hasta"])
            pct = 100 * float(np.mean((validos >= desde) & (validos < hasta))) if validos.size else 0.0
            clases.append({**cl, "pct": round(pct, 1)})
            desde = hasta
        meta = dict(disponible=True, fuente_ti=d.get("fuente_ti", ""),
                    fuente_polvo=d.get("fuente_polvo", ""), nota=d.get("nota", ""),
                    unidades_ti=d.get("unidades_ti", ""), clases=clases, polvo=d.get("polvo"),
                    ti_min=float(validos.min()) if validos.size else None,
                    ti_max=float(validos.max()) if validos.size else None)
        return dict(meta=meta, ti=capa.astype("<f4").tobytes())
    except Exception as e:           # la capa es opcional: nunca debe tumbar el visor
        print(f"(No se pudo cargar la capa de suelo: {e}. El visor sigue sin ella.)")
        return None
