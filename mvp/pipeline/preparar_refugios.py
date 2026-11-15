"""
preparar_refugios.py  -  Elige los REFUGIOS del mapa con una logica explicable.
Se corre UNA sola vez (o cuando cambie el mapa o las capas):

    py preparar_refugios.py            (5 refugios)
    py preparar_refugios.py 7          (otra cantidad)

LOS REFUGIOS SON FIJOS: el resultado se guarda en refugios.json y el visor
solo lee ese archivo, nunca los recalcula. Ademas el calculo es determinista
(mismos datos y ajustes = mismos refugios). Si refugios.json ya existe, este
script NO lo sobrescribe; para recalcular a proposito:

    py preparar_refugios.py 5 --recalcular

Un refugio es un lugar donde el astronauta puede esperar a que pase una
tormenta de polvo o un evento de radiacion solar. Se elige en dos pasos:

1) PUNTUACION de cada celda (0 a 1), con datos reales:
   - Plano (DTM HiRISE): pendiente local baja para llegar, montar y quedarse.
     Es un filtro: si no es plano, no es candidato.
   - Proteccion (DTM HiRISE): cuanto cielo tapa el relieve alrededor (pared
     de crater, saliente, loma). Tapar cielo frena el viento y reduce la
     radiacion que llega de todas direcciones (la dosis de un campo isotropo
     baja con la fraccion de cielo bloqueada).
   - Suelo firme (THEMIS, inercia termica): roca o suelo compacto, no arena
     fina donde se hunden las botas y se levanta polvo.
   - Muy plano (DTM HiRISE): ademas del filtro, suma puntos cuanto menos
     pendiente tenga (evita quedar justo al pie de la pared).
   - Sin hondonada (DTM HiRISE): no en el fondo de un hoyo, donde de noche se
     acumula el aire frio y el polvo se deposita.

2) REPARTO en el mapa: los refugios se eligen de uno en uno para que, desde
   cualquier punto transitable, haya uno lo mas cerca posible CAMINANDO (no en
   linea recta), con la misma red de pasos y pendiente maxima que usan las
   rutas. Cada nuevo refugio va a la zona peor cubierta, pero solo a un
   candidato con buena puntuacion.

Salida: datos/procesados/refugios.json con cada refugio (posicion en el mismo
marco que las rutas: metros desde la esquina INFERIOR izquierda, y = norte),
su puntuacion desglosada, el motivo en palabras y la cobertura (tiempo a pie
al refugio mas cercano desde cualquier punto).

Necesita solo numpy (y lo que ya usa Rutes/ruta_optima.py).
"""

import heapq
import json
import math
import os
import sys
import time
from array import array

import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
MVP = os.path.dirname(AQUI)
sys.path.insert(0, os.path.join(MVP, "Rutes"))
import ruta_optima as ro   # noqa: E402
import suelo               # noqa: E402

DEM_DEFECTO = os.path.join(MVP, "Rutes", "matriz_elevacion.asc")
SUELO_JSON = os.path.join(MVP, "datos", "procesados", "suelo.json")
SALIDA = os.path.join(MVP, "datos", "procesados", "refugios.json")

# ======================================================================
#                              AJUSTES
# ======================================================================
N_REFUGIOS = 5
CELDA = 10.0               # m, igual que las rutas
VEL_A_PIE = 1.2            # m/s con traje (igual que casco.js)

PEND_LOCAL_MAX = 8.0       # grados: pendiente media en ~30 m para ser candidato
RADIO_PLANO = 15.0         # m, radio para la pendiente media local

RADIO_HORIZONTE = 300.0    # m, hasta donde se busca relieve que proteja
PASO_HORIZONTE = 20.0      # m
N_DIRECCIONES = 16
PARED_GRADOS = 10.0        # una direccion "tiene pared" si el horizonte supera esto

RADIO_HONDONADA = 300.0    # m, para comparar con el entorno
HONDONADA_MAX = 25.0       # m por debajo del entorno = hondonada fuerte

# Puntuacion de suelo segun inercia termica (J m-2 K-1 s-1/2)
SUELO_PUNTOS = [(150, 0.0), (250, 0.45), (350, 0.9), (math.inf, 1.0)]

PESOS = dict(proteccion=0.45, suelo=0.25, sin_hondonada=0.20, plano=0.10)
PUNTUACION_MINIMA = 0.45   # candidatos por debajo de esto no se consideran
SEPARACION_MIN = 500.0     # m entre refugios (en linea recta)
# ======================================================================


def media_caja(a, radio_celdas):
    """Media en una ventana cuadrada de (2r+1)^2 celdas ignorando NaN."""
    r = int(radio_celdas)
    v = np.where(np.isnan(a), 0.0, a).astype(np.float64)
    n = (~np.isnan(a)).astype(np.float64)

    def caja(m):
        p = np.pad(m, ((r + 1, r), (r + 1, r)))
        s = p.cumsum(0).cumsum(1)
        k = 2 * r + 1
        return s[k:, k:] - s[:-k, k:] - s[k:, :-k] + s[:-k, :-k]

    with np.errstate(invalid="ignore", divide="ignore"):
        return caja(v) / caja(n)


def pendiente(z, celda):
    gy, gx = np.gradient(z.astype(np.float64), celda)
    return np.degrees(np.arctan(np.hypot(gx, gy)))


def horizonte(z, celda):
    """Para cada celda y cada direccion, el angulo (grados) del relieve mas
    alto hasta RADIO_HORIZONTE. Devuelve (fraccion_cielo_tapada, fraccion_de_
    direcciones_con_pared, direccion_de_mejor_pared_en_grados)."""
    nf, nc = z.shape
    zf = z.astype(np.float64)
    tapado = np.zeros((nf, nc))
    paredes = np.zeros((nf, nc))
    mejor = np.zeros((nf, nc))
    mejor_dir = np.zeros((nf, nc))
    pasos = np.arange(PASO_HORIZONTE, RADIO_HORIZONTE + 1, PASO_HORIZONTE)
    for k in range(N_DIRECCIONES):
        az = 2 * math.pi * k / N_DIRECCIONES          # 0 = norte, horario
        hmax = np.zeros((nf, nc))
        for d in pasos:
            df = -int(round(d * math.cos(az) / celda))  # filas crecen hacia el sur
            dc = int(round(d * math.sin(az) / celda))
            vec = np.full((nf, nc), np.nan)
            f0, f1 = max(0, -df), min(nf, nf - df)
            c0, c1 = max(0, -dc), min(nc, nc - dc)
            vec[f0:f1, c0:c1] = zf[f0 + df:f1 + df, c0 + dc:c1 + dc]
            dist = celda * math.hypot(df, dc)
            with np.errstate(invalid="ignore"):
                ang = np.degrees(np.arctan((vec - zf) / dist))
            hmax = np.fmax(hmax, np.nan_to_num(ang, nan=0.0))
        tapado += np.sin(np.radians(hmax))   # aproximacion del cielo tapado en ese sector
        paredes += hmax > PARED_GRADOS
        m = hmax > mejor
        mejor[m], mejor_dir[m] = hmax[m], math.degrees(az)
    return tapado / N_DIRECCIONES, paredes / N_DIRECCIONES, mejor_dir, mejor


def puntos_suelo(ti):
    out = np.full(ti.shape, np.nan)
    desde = -math.inf
    for hasta, p in SUELO_PUNTOS:
        out[(ti >= desde) & (ti < hasta)] = p
        desde = hasta
    return out


def dijkstra_multi(costos, nf, nc, fuentes, etiquetas=False):
    """Costo (m equivalentes) desde la fuente mas cercana a todas las celdas.
    Con etiquetas=True devuelve tambien que fuente es la mas cercana (-1 = ninguna)."""
    INF = float("inf")
    dist = array("d", [INF]) * (nf * nc)
    dueno = array("i", [-1]) * (nf * nc)
    desplaz = [dr * nc + dc for dr, dc in ro.VECINOS]
    cola = []
    for k, s in enumerate(fuentes):
        dist[s] = 0.0
        dueno[s] = k
        cola.append((0.0, s))
    heapq.heapify(cola)
    pop, push = heapq.heappop, heapq.heappush
    while cola:
        d, i = pop(cola)
        if d > dist[i]:
            continue
        for k in range(8):
            c = costos[k][i]
            if c == INF:
                continue
            j = i + desplaz[k]
            nd = d + c
            if nd < dist[j]:
                dist[j] = nd
                dueno[j] = dueno[i]
                push(cola, (nd, j))
    D = np.frombuffer(dist, dtype=np.float64).reshape(nf, nc).copy()
    if etiquetas:
        return D, np.frombuffer(dueno, dtype=np.int32).reshape(nf, nc).copy()
    return D


RUMBOS = ["norte", "nor-noreste", "noreste", "este-noreste", "este", "este-sureste",
          "sureste", "sur-sureste", "sur", "sur-suroeste", "suroeste", "oeste-suroeste",
          "oeste", "oeste-noroeste", "noroeste", "nor-noroeste"]


def motivo(r):
    partes = []
    if r["proteccion"] >= 0.6:
        partes.append(f"bien protegido por relieve al {r['pared_hacia']}")
    elif r["proteccion"] >= 0.3:
        partes.append(f"algo de abrigo por relieve al {r['pared_hacia']}")
    else:
        partes.append("poco abrigo natural (terreno abierto)")
    partes.append(f"suelo {r['suelo_tipo']}")
    partes.append(f"pendiente {r['pendiente']:.0f}°")
    if r["hondonada_m"] > 10:
        partes.append(f"{r['hondonada_m']:.0f} m por debajo del entorno")
    return ", ".join(partes)


def main():
    args = [a for a in sys.argv[1:] if a != "--recalcular"]
    if os.path.exists(SALIDA) and "--recalcular" not in sys.argv:
        sys.exit(f"Los refugios ya estan fijados en {SALIDA}.\n"
                 "No se tocan. Para recalcularlos a proposito: py preparar_refugios.py 5 --recalcular")
    n_ref = int(args[0]) if len(args) > 0 else N_REFUGIOS
    ruta_dem = args[1] if len(args) > 1 else DEM_DEFECTO
    if not os.path.exists(ruta_dem):
        sys.exit(f"No encuentro el mapa de elevacion: {ruta_dem}")
    t0 = time.time()
    z, celda, _, _ = ro.cargar_terreno(ruta_dem, tam_celda=CELDA)
    z = z.astype(np.float32)
    nf, nc = z.shape
    alto = nf * celda
    validos = ~np.isnan(z)
    print(f"Terreno: {nc} x {nf} celdas de {celda:g} m")

    # --- 1) puntuacion -------------------------------------------------
    pend = pendiente(z, celda)
    pend_local = media_caja(pend, max(1, round(RADIO_PLANO / celda)))
    print("Calculando horizonte en 16 direcciones...")
    tapado, paredes, dir_pared, _ = horizonte(z, celda)
    # 0.5 * cielo tapado (radiacion) + 0.5 * direcciones con pared (viento);
    # el cielo tapado se normaliza: tapar ~15 % del cielo ya es mucho abrigo
    proteccion = np.clip(0.5 * np.clip(tapado / 0.15, 0, 1) + 0.5 * np.clip(paredes / 0.5, 0, 1), 0, 1)
    hondo = media_caja(z, round(RADIO_HONDONADA / celda)) - z
    sin_hondonada = np.clip(1 - np.maximum(hondo, 0) / HONDONADA_MAX, 0, 1)

    ti = None
    if os.path.exists(SUELO_JSON):
        with open(SUELO_JSON, encoding="utf-8") as f:
            d = json.load(f)
        t = np.array(d["ti"], dtype=np.float32).reshape(d["nf"], d["nc"])
        t[t < 0] = np.nan
        ti = suelo.remuestrear(t, float(d["celda"]), nf, nc, celda)
        p_suelo = puntos_suelo(ti)
        p_suelo[np.isnan(p_suelo)] = 0.5
        print("Capa de suelo (THEMIS) incluida.")
    else:
        p_suelo = np.full((nf, nc), 0.5)
        print("(Sin suelo.json: el suelo cuenta como neutro.)")

    # cuanto mas plano mejor (no solo pasar el filtro): asi el refugio no queda
    # pegado al pie de la pared, donde la pendiente ya empieza a subir
    plano = np.clip(1 - pend_local / PEND_LOCAL_MAX, 0, 1)
    puntaje = (PESOS["proteccion"] * proteccion + PESOS["suelo"] * p_suelo
               + PESOS["sin_hondonada"] * sin_hondonada + PESOS["plano"] * plano)
    candidato = validos & (pend_local <= PEND_LOCAL_MAX) & (pend <= PEND_LOCAL_MAX + 4) \
        & (puntaje >= PUNTUACION_MINIMA)
    # que no este pegado al borde (el horizonte ahi esta incompleto)
    b = int(RADIO_HORIZONTE / celda)
    borde = np.zeros_like(candidato)
    borde[b:-b, b:-b] = True
    candidato &= borde
    print(f"Candidatos: {int(candidato.sum()):,} celdas de {int(validos.sum()):,}")
    if not candidato.any():
        sys.exit("Ningun candidato: baja PUNTUACION_MINIMA o sube PEND_LOCAL_MAX.")

    # --- 2) reparto por distancia caminando ------------------------------
    costos = ro.calcular_costos(z, celda)
    # zona transitable principal: la mayor region conectada a pie. Se prueba
    # desde varios candidatos y se queda la mas grande (un candidato puede estar
    # en un "bolsillo" rodeado de pendientes prohibidas).
    rng = np.random.default_rng(0)
    pool = np.flatnonzero(candidato)
    alcanzable = np.zeros((nf, nc), bool)
    for s in rng.choice(pool, size=min(12, pool.size), replace=False):
        if alcanzable.flat[s]:
            continue
        reg = np.isfinite(dijkstra_multi(costos, nf, nc, [int(s)]))
        if reg.sum() > alcanzable.sum():
            alcanzable = reg
        if alcanzable.sum() > 0.5 * validos.sum():
            break
    candidato &= alcanzable
    print(f"Zona transitable conectada: {100 * alcanzable.sum() / validos.sum():.0f} % del mapa")

    # primer refugio: buen puntaje y cerca del "centro" a pie de la zona transitable
    filas, cols = np.nonzero(alcanzable)
    fc, cc = filas.mean(), cols.mean()
    F, C = np.indices((nf, nc))
    cerca_centro = 1 / (1 + np.hypot(F - fc, C - cc) * celda / 2000)
    elegidos = [int(np.argmax(np.where(candidato, puntaje * cerca_centro, -1)))]
    yy, xx = np.indices((nf, nc))
    while len(elegidos) < n_ref:
        dist = dijkstra_multi(costos, nf, nc, elegidos)
        dist[~alcanzable] = 0
        lejos = np.zeros((nf, nc), bool)
        lejos[:] = True
        for e in elegidos:
            ef, ec = divmod(e, nc)
            lejos &= np.hypot(yy - ef, xx - ec) * celda >= SEPARACION_MIN
        valor = np.where(candidato & lejos, dist * puntaje ** 2, -1)
        if valor.max() <= 0:
            print("No quedan candidatos lo bastante separados.")
            break
        elegidos.append(int(np.argmax(valor)))
        print(f"  refugio {len(elegidos)} elegido")

    # Ajuste fino (tipo k-medias, pero a pie): cada refugio se mueve hacia el
    # centro de la zona que le toca cubrir, sin perder puntuacion.
    for vuelta in range(4):
        _, dueno = dijkstra_multi(costos, nf, nc, elegidos, etiquetas=True)
        nuevos = []
        for k, e in enumerate(elegidos):
            zona = (dueno == k) & alcanzable
            if not zona.any():
                nuevos.append(e)
                continue
            zf, zc = np.nonzero(zona)
            d_centro = np.hypot(yy - zf.mean(), xx - zc.mean()) * celda
            valor = np.where(candidato & zona, puntaje ** 2 / (1 + d_centro / 1500), -1)
            nuevos.append(int(np.argmax(valor)) if valor.max() > 0 else e)
        if nuevos == elegidos:
            break
        elegidos = nuevos
        print(f"  ajuste {vuelta + 1}: refugios recolocados")

    dist = dijkstra_multi(costos, nf, nc, elegidos)
    d_ok = dist[alcanzable & np.isfinite(dist)]
    min_a_pie = d_ok / VEL_A_PIE / 60

    refugios = []
    for k, e in enumerate(elegidos):
        f, c = divmod(e, nc)
        tipo = "desconocido"
        if ti is not None and not np.isnan(ti[f, c]):
            v = ti[f, c]
            tipo = ("fino suelto" if v < 150 else "arenoso" if v < 250
                    else "compacto con grava" if v < 350 else "rocoso o cementado")
        r = dict(
            id=k + 1, nombre=f"Refugio {chr(65 + k)}",
            x=round((c + 0.5) * celda, 1), y=round(alto - (f + 0.5) * celda, 1),
            z=round(float(z[f, c]), 1),
            puntaje=round(float(puntaje[f, c]), 2),
            proteccion=round(float(proteccion[f, c]), 2),
            cielo_tapado_pct=round(100 * float(tapado[f, c]), 1),
            pared_hacia=RUMBOS[int(round(dir_pared[f, c] / 22.5)) % 16],
            suelo=round(float(p_suelo[f, c]), 2), suelo_tipo=tipo,
            inercia=None if ti is None or np.isnan(ti[f, c]) else round(float(ti[f, c])),
            sin_hondonada=round(float(sin_hondonada[f, c]), 2),
            hondonada_m=round(float(hondo[f, c]), 1),
            pendiente=round(float(pend_local[f, c]), 1))
        r["motivo"] = motivo(r)
        refugios.append(r)

    salida = dict(
        fuente="DTM HiRISE (relieve, pendiente, horizonte) + THEMIS inercia termica (suelo)",
        origen="x = este, y = norte, en metros desde la esquina INFERIOR izquierda (igual que las rutas)",
        celda=celda, vel_a_pie=VEL_A_PIE,
        criterios=dict(pesos=PESOS, pend_local_max=PEND_LOCAL_MAX,
                       radio_horizonte=RADIO_HORIZONTE, separacion_min=SEPARACION_MIN),
        cobertura=dict(
            min_a_pie_mediana=round(float(np.median(min_a_pie)), 1),
            min_a_pie_p95=round(float(np.percentile(min_a_pie, 95)), 1),
            min_a_pie_max=round(float(min_a_pie.max()), 1),
            nota="Tiempo caminando al refugio mas cercano desde cualquier punto transitable, "
                 "con el costo de las rutas (distancia + castigo por pendiente)."),
        refugios=refugios)
    os.makedirs(os.path.dirname(SALIDA), exist_ok=True)
    with open(SALIDA, "w", encoding="utf-8") as f:
        json.dump(salida, f, ensure_ascii=False, indent=1)

    print(f"\n{len(refugios)} refugios ({time.time() - t0:.0f} s):")
    for r in refugios:
        print(f"  {r['nombre']}: ({r['x']:.0f}, {r['y']:.0f}) m, puntaje {r['puntaje']:.2f}: {r['motivo']}")
    cb = salida["cobertura"]
    print(f"Cobertura a pie: mediana {cb['min_a_pie_mediana']} min, 95 % en menos de "
          f"{cb['min_a_pie_p95']} min, peor caso {cb['min_a_pie_max']} min")
    print(f"Guardado: {SALIDA}")


if __name__ == "__main__":
    main()
