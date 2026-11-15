"""
geologia.py  -  Capa geologica OPCIONAL para el visor de rutas.

Lee datos/procesados/geologia.json (lo genera pipeline/preparar_geologia.py a
partir del mapa geologico global USGS SIM 3292) y lo convierte a la misma
rejilla que usa el visor: un numero por celda que dice en que unidad
geologica cae (0 = sin dato).

Si el archivo no existe o falla algo, cargar() devuelve None y el visor
funciona exactamente igual que sin esta capa. No afecta al calculo de rutas.
"""

import json
import os

import numpy as np

RUTA_DEFECTO = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "datos", "procesados", "geologia.json"))


def rasterizar(anillos, nf, nc, celda):
    """Celdas cuyo centro cae dentro del poligono (regla par-impar, asi los
    huecos se descuentan solos). Los anillos estan en metros desde la esquina
    superior izquierda (x = este, y = sur). Devuelve una matriz booleana."""
    cambios = np.zeros((nf, nc + 1), dtype=np.int32)
    for anillo in anillos:
        p = np.asarray(anillo, dtype=np.float64)
        q = np.roll(p, -1, axis=0)
        for (x1, y1), (x2, y2) in zip(p, q):
            if y1 == y2:
                continue
            ya, yb = min(y1, y2), max(y1, y2)
            # filas cuyo centro queda entre los dos extremos del lado
            r0 = max(0, int(np.ceil(ya / celda - 0.5)))
            r1 = min(nf, int(np.ceil(yb / celda - 0.5)))
            if r1 <= r0:
                continue
            filas = np.arange(r0, r1)
            xi = x1 + ((filas + 0.5) * celda - y1) * (x2 - x1) / (y2 - y1)
            # primera columna cuyo centro queda a la derecha del cruce
            cols = np.clip(np.floor(xi / celda - 0.5).astype(np.int64) + 1, 0, nc)
            np.add.at(cambios, (filas, cols), 1)
    return (np.cumsum(cambios[:, :nc], axis=1) % 2).astype(bool)


def cargar(z, celda, ruta_json=RUTA_DEFECTO):
    """Prepara la capa para un terreno `z` (matriz de alturas, NaN = sin datos)
    con celdas de `celda` metros. Devuelve dict(meta=..., celdas=bytes) o None."""
    if not os.path.exists(ruta_json):
        return None
    try:
        with open(ruta_json, "r", encoding="utf-8") as f:
            datos = json.load(f)
        nf, nc = z.shape
        capa = np.zeros((nf, nc), dtype=np.uint8)
        for k, u in enumerate(datos["unidades"][:255]):
            for anillos in u["poligonos"]:
                capa[rasterizar(anillos, nf, nc, celda)] = k + 1
        capa[np.isnan(z)] = 0
        con_dato = max(1, int(np.count_nonzero(~np.isnan(z))))
        unidades = []
        for k, u in enumerate(datos["unidades"][:255]):
            unidades.append(dict(
                id=k + 1, codigo=u["codigo"], descripcion=u.get("descripcion", ""),
                nombre=u.get("nombre", u["codigo"]), edad=u.get("edad", ""),
                interes=u.get("interes", ""), color=u.get("color", [0.5, 0.8, 0.7]),
                pct=round(100 * int(np.count_nonzero(capa == k + 1)) / con_dato, 1)))
        meta = dict(disponible=True, fuente=datos.get("fuente", ""),
                    nota=datos.get("nota", ""), unidades=unidades)
        return dict(meta=meta, celdas=capa.tobytes())
    except Exception as e:           # la capa es opcional: nunca debe tumbar el visor
        print(f"(No se pudo cargar la capa geologica: {e}. El visor sigue sin ella.)")
        return None
