"""
preparar_termica_polvo.py  -  Analisis termico y de polvo de la superficie para
la zona del mapa de elevacion. Se corre UNA sola vez:

    py preparar_termica_polvo.py

1) INERCIA TERMICA (THEMIS, ~100 m/pixel) -> TIPO DE SUELO
   La inercia termica dice cuanto le cuesta al suelo cambiar de temperatura
   entre el dia y la noche. Polvo y arena fina se calientan y enfrian rapido
   (inercia baja); la roca y el suelo cementado guardan el calor (inercia alta).
   Fuente: Edwards y Buz (2021), "THEMIS-derived Thermal Inertia of Jezero
   Crater, Mars", Zenodo 10.5281/zenodo.4931348.
   Archivo: datos/crudos/inercia_termica/Jezero_Thermal_Inertia_v1.tiff

2) INDICE DE COBERTURA DE POLVO (TES, ~3,5 km/pixel)
   Emisividad media entre 1350 y 1400 cm-1: cuanto mas baja, mas polvo fino
   cubre la superficie. Solo se publica como imagen en color (cada color es un
   rango de emisividad), asi que se decodifica por el tono. Es un dato
   REGIONAL: todo el mapa de elevacion ocupa 2 x 3 pixeles de este mapa.
   Fuente: Ruff y Christensen (2002), JGR 107, 10.1029/2001JE001580.
   Archivo: datos/crudos/polvo_tes/tes_ruffdust.png  (mars.asu.edu/data/tes_ruffdust)

Salida: datos/procesados/suelo.json con la inercia termica remuestreada a una
rejilla de 50 m en el MISMO marco que el mapa de elevacion (metros desde la
esquina superior izquierda, x = este, y = sur), las clases de suelo y el
resumen de polvo. El visor lo lleva a su rejilla al arrancar (Rutes/suelo.py).

Necesita numpy y Pillow (Pillow ya viene con matplotlib).
"""

import colorsys
import json
import math
import os
import sys

import numpy as np
from PIL import Image

from preparar_geologia import DEM_DEFECTO, MVP, leer_georef

TI_DEFECTO = os.path.join(MVP, "datos", "crudos", "inercia_termica", "Jezero_Thermal_Inertia_v1.tiff")
DCI_DEFECTO = os.path.join(MVP, "datos", "crudos", "polvo_tes", "tes_ruffdust.png")
SALIDA = os.path.join(MVP, "datos", "procesados", "suelo.json")

CELDA_SALIDA = 50.0       # m; la fuente es de 100 m, no hace falta mas
RADIO_POLVO_KM = 15       # zona alrededor del mapa usada para el indice de polvo

# Clases de suelo por inercia termica (J m-2 K-1 s-1/2). Los limites son una
# simplificacion para la demo: con pixeles de 100 m cada valor es una MEZCLA
# de materiales, y la inercia tiene ~20 % de incertidumbre.
CLASES = [
    dict(id=1, clave="fino", nombre="material fino suelto", hasta=150,
         color=[0.98, 0.86, 0.35], riesgo="alto",
         descripcion="Polvo o arena muy fina sin compactar: las botas se hunden y se levanta polvo."),
    dict(id=2, clave="arena", nombre="arena", hasta=250,
         color=[0.95, 0.60, 0.30], riesgo="medio",
         descripcion="Arena suelta o poco compactada: se camina bien pero con más esfuerzo."),
    dict(id=3, clave="compacto", nombre="suelo compacto con grava", hasta=350,
         color=[0.45, 0.70, 0.95], riesgo="bajo",
         descripcion="Arena gruesa, grava o suelo algo cementado: buen apoyo."),
    dict(id=4, clave="roca", nombre="suelo rocoso o cementado", hasta=None,
         color=[0.70, 0.50, 0.95], riesgo="bajo",
         descripcion="Bloques, afloramientos o costras cementadas: apoyo firme e interés científico."),
]

# TES Dust Cover Index: tono del color -> emisividad (centro de cada banda de la leyenda)
BANDAS_DCI = [(0, 0.925), (30, 0.935), (60, 0.945), (120, 0.955), (180, 0.965),
              (240, 0.975), (300, 0.99)]


# --------------------------------------------------------------- GeoTIFF
def leer_geotiff_simple_cilindrico(ruta):
    """Lee un GeoTIFF de 1 banda en proyeccion cilindrica simple (equirectangular)
    sobre esfera. Devuelve (matriz, georef) con las etiquetas GeoTIFF basicas."""
    im = Image.open(ruta)
    t = im.tag_v2
    escala, punto = t[33550], t[33922]            # ModelPixelScale, ModelTiepoint
    claves, dobles = t[34735], t.get(34736, ())
    geo = {}
    for i in range(1, claves[3] + 1):
        k, donde, _, val = claves[4 * i: 4 * i + 4]
        geo[k] = dobles[val] if donde == 34736 else val
    if (1, 0) != (geo.get(1024), geo.get(1025, 1) - 1):
        raise SystemExit(f"{ruta}: se esperaba un GeoTIFF proyectado con pixeles como area.")
    datos = np.array(im, dtype=np.float32)
    return datos, dict(
        radio=float(geo.get(2057, 3396190.0)),
        lon0=float(geo.get(3088, 0.0)), lat_ts=float(geo.get(3078, 0.0)),
        x0=punto[3] - punto[0] * escala[0], y0=punto[4] + punto[1] * escala[1],
        dx=escala[0], dy=escala[1])


def bilineal(mat, f, c):
    """Interpola `mat` en filas/columnas fraccionarias (NaN fuera o sin dato)."""
    nf, nc = mat.shape
    f0, c0 = np.floor(f).astype(int), np.floor(c).astype(int)
    ff, fc = f - f0, c - c0
    ok = (f0 >= 0) & (c0 >= 0) & (f0 < nf - 1) & (c0 < nc - 1)
    f0, c0 = np.clip(f0, 0, nf - 2), np.clip(c0, 0, nc - 2)
    a, b = mat[f0, c0], mat[f0, c0 + 1]
    d, e = mat[f0 + 1, c0], mat[f0 + 1, c0 + 1]
    v = (a * (1 - fc) + b * fc) * (1 - ff) + (d * (1 - fc) + e * fc) * ff
    return np.where(ok, v, np.nan)


# ------------------------------------------------------------ analisis
def inercia_en_mapa(ruta_ti, g):
    """Inercia termica remuestreada a la rejilla de salida en el marco del mapa."""
    ti, t = leer_geotiff_simple_cilindrico(ruta_ti)
    ti[~(ti > 0)] = np.nan                        # 0 = sin dato
    nc = int(math.ceil(g["ancho"] / CELDA_SALIDA))
    nf = int(math.ceil(g["alto"] / CELDA_SALIDA))
    y, x = np.mgrid[0:nf, 0:nc]
    x = (x + 0.5) * CELDA_SALIDA                  # m desde la esquina sup. izq. del mapa
    y = (y + 0.5) * CELDA_SALIDA
    # mapa -> lon/lat (proyeccion del DTM) -> pixel del GeoTIFF
    lon = g["lon0"] + np.degrees((g["x_izq"] + x) / (g["radio"] * math.cos(math.radians(g["lat1"]))))
    lat = np.degrees((g["y_sup"] - y) / g["radio"])
    k = t["radio"] * math.pi / 180
    px = (lon - t["lon0"]) * k * math.cos(math.radians(t["lat_ts"]))
    py = lat * k
    col = (px - t["x0"]) / t["dx"] - 0.5
    fil = (t["y0"] - py) / t["dy"] - 0.5
    return bilineal(ti, fil, col), nf, nc


def polvo_regional(ruta_dci, g):
    """Mediana del indice de polvo de TES en un circulo alrededor del mapa."""
    im = Image.open(ruta_dci).convert("RGB")
    ancho, alto = im.size
    ppd = ancho / 360.0
    # centro del mapa de elevacion en lon/lat
    lon_c = g["lon0"] + math.degrees((g["x_izq"] + g["ancho"] / 2) /
                                     (g["radio"] * math.cos(math.radians(g["lat1"]))))
    lat_c = math.degrees((g["y_sup"] - g["alto"] / 2) / g["radio"])
    rad_deg = RADIO_POLVO_KM * 1000 / (g["radio"] * math.pi / 180)
    m = int(math.ceil(rad_deg * ppd / max(0.2, math.cos(math.radians(lat_c))))) + 1
    cc, fc = (lon_c + 180) * ppd, (90 - lat_c) * ppd
    caja = (int(cc) - m, int(fc) - m, int(cc) + m + 1, int(fc) + m + 1)
    rgb = np.asarray(im.crop(caja), dtype=np.float32) / 255
    emis = []
    for f in range(rgb.shape[0]):
        for c in range(rgb.shape[1]):
            lon = (caja[0] + c + 0.5) / ppd - 180
            lat = 90 - (caja[1] + f + 0.5) / ppd
            dist = math.hypot((lon - lon_c) * math.cos(math.radians(lat_c)), lat - lat_c)
            if dist > rad_deg:
                continue
            h, s, v = colorsys.rgb_to_hsv(*rgb[f, c])
            if s < 0.35 or v < 0.25:              # gris = sin dato (o solo sombreado)
                continue
            tono = h * 360
            emis.append(min(BANDAS_DCI, key=lambda b: min(abs(tono - b[0]), 360 - abs(tono - b[0])))[1])
    if not emis:
        return None
    emis = np.array(emis)
    med = float(np.median(emis))
    if med >= 0.96:
        nivel, texto = "bajo", "la superficie expone su material real, no una capa de polvo"
    elif med >= 0.94:
        nivel, texto = "moderado", "hay algo de polvo fino sobre el suelo"
    else:
        nivel, texto = "alto", "el suelo está cubierto de polvo fino; la inercia baja puede ser solo polvo"
    reparto = {f"{e:.3f}": round(100 * float(np.mean(emis == e)), 1) for e in sorted(set(emis.tolist()))}
    return dict(emisividad_mediana=round(med, 3), nivel=nivel, texto=texto,
                radio_km=RADIO_POLVO_KM, pixeles=int(emis.size), reparto_pct=reparto,
                lon=round(lon_c, 3), lat=round(lat_c, 3))


# ----------------------------------------------------------------- main
def main():
    ruta_ti = sys.argv[1] if len(sys.argv) > 1 else TI_DEFECTO
    ruta_dci = sys.argv[2] if len(sys.argv) > 2 else DCI_DEFECTO
    ruta_dem = sys.argv[3] if len(sys.argv) > 3 else DEM_DEFECTO
    for ruta in (ruta_ti, ruta_dem):
        if not os.path.exists(ruta):
            raise SystemExit(f"NO ENCUENTRO EL ARCHIVO: {ruta}")
    g = leer_georef(ruta_dem)

    ti, nf, nc = inercia_en_mapa(ruta_ti, g)
    validos = ti[~np.isnan(ti)]
    if validos.size == 0:
        raise SystemExit("La inercia termica no cubre el mapa de elevacion.")
    print(f"Inercia termica en el mapa ({nc} x {nf} celdas de {CELDA_SALIDA:g} m): "
          f"min {validos.min():.0f}, mediana {np.median(validos):.0f}, max {validos.max():.0f} "
          f"J m-2 K-1 s-1/2  ({100 * validos.size / ti.size:.0f} % con dato)")
    lim = -np.inf
    for cl in CLASES:
        alto = np.inf if cl["hasta"] is None else cl["hasta"]
        cl["desde"] = None if lim == -np.inf else lim
        cl["pct"] = round(100 * float(np.mean((validos >= lim) & (validos < alto))), 1)
        print(f"  {cl['nombre']:28s} {cl['pct']:5.1f} %")
        lim = alto

    if os.path.exists(ruta_dci):
        polvo = polvo_regional(ruta_dci, g)
        if polvo:
            print(f"\nPolvo superficial (TES, radio {RADIO_POLVO_KM} km, {polvo['pixeles']} pixeles): "
                  f"emisividad {polvo['emisividad_mediana']} -> nivel {polvo['nivel']}")
    else:
        polvo = None
        print(f"\n(No encontre {ruta_dci}: se omite el indice de polvo.)")

    os.makedirs(os.path.dirname(SALIDA), exist_ok=True)
    valores = np.where(np.isnan(ti), -1, np.round(ti)).astype(int).ravel().tolist()
    with open(SALIDA, "w", encoding="utf-8") as f:
        json.dump(dict(
            fuente_ti="THEMIS, inercia térmica de Jezero (Edwards y Buz, 2021, Zenodo 4931348), ~100 m/píxel",
            fuente_polvo="MGS TES, índice de cobertura de polvo (Ruff y Christensen, 2002), ~3,5 km/píxel",
            nota="Inercia ±20 %; cada píxel de 100 m mezcla materiales. El polvo es un valor regional.",
            unidades_ti="J m-2 K-1 s-1/2",
            origen="esquina superior izquierda del mapa de elevacion; x = este (m), y = sur (m)",
            celda=CELDA_SALIDA, nf=nf, nc=nc, ti=valores,
            clases=CLASES, polvo=polvo), f, ensure_ascii=False, separators=(",", ":"))
    print(f"\nGuardado: {SALIDA}  ({os.path.getsize(SALIDA) / 1024:.0f} KB)")
    print('Abre el visor (py visor_rutas.py) y marca la casilla "Tipo de suelo".')


if __name__ == "__main__":
    main()
