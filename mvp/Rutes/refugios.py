"""
refugios.py  -  Capa OPCIONAL de refugios y rutas de emergencia para el visor.

Lee datos/procesados/refugios.json (lo genera pipeline/preparar_refugios.py:
los refugios son FIJOS, aqui solo se leen) y prepara, para cada refugio, el
"arbol" de caminos mas baratos desde CUALQUIER celda del mapa hasta el.

Como el costo de un paso es igual en los dos sentidos (FACTOR_SUBIDA = 1), un
solo Dijkstra que sale DEL refugio da el costo y el camino desde cada celda
HACIA el refugio. Con los 5 arboles listos, pedir "rutas a todos los refugios
desde aqui" es instantaneo: basta seguir el arbol.

Los arboles tardan unos segundos por refugio la primera vez (Python puro), se
calculan en segundo plano al abrir el visor y se guardan en un .npz junto al
mapa, asi que las siguientes veces cargan al instante.

El tiempo a pie de cada ruta usa la funcion de marcha de Tobler (mas lento en
subidas y en bajadas fuertes), escalada a 1,2 m/s en llano con traje.

Si el archivo no existe o falla algo, cargar() devuelve None y el visor
funciona exactamente igual que sin esta capa.
"""

import hashlib
import heapq
import json
import math
import os
import threading
from array import array

import numpy as np

import ruta_optima as ro

RUTA_DEFECTO = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "datos", "procesados", "refugios.json"))

VEL_LLANO = 1.2      # m/s caminando con traje en terreno plano


def velocidad_tobler(dz, dxy):
    """Velocidad (m/s) para un paso con desnivel dz en una distancia horizontal
    dxy. Tobler (1993): v = 6 exp(-3,5 |pendiente + 0,05|) km/h, escalada para
    que el maximo (bajada suave) sea VEL_LLANO * 1,19, como en el original."""
    s = np.divide(dz, dxy, out=np.zeros_like(dz, dtype=np.float64), where=dxy > 0)
    return VEL_LLANO * np.exp(-3.5 * (np.abs(s + 0.05) - 0.05))


def cargar(ruta_json=RUTA_DEFECTO):
    if not os.path.exists(ruta_json):
        return None
    try:
        with open(ruta_json, "r", encoding="utf-8") as f:
            d = json.load(f)
        if not d.get("refugios"):
            return None
        return d
    except Exception as e:           # la capa es opcional: nunca debe tumbar el visor
        print(f"(No se pudieron cargar los refugios: {e}. El visor sigue sin ellos.)")
        return None


def _arbol(costos, nf, nc, fuente):
    """Dijkstra desde `fuente` a todo el mapa. Devuelve (costo, siguiente),
    donde siguiente[i] es la celda que sigue a i en el camino HACIA la fuente."""
    INF = float("inf")
    dist = array("d", [INF]) * (nf * nc)
    sig = array("i", [-1]) * (nf * nc)
    desplaz = [dr * nc + dc for dr, dc in ro.VECINOS]
    dist[fuente] = 0.0
    sig[fuente] = fuente
    cola = [(0.0, fuente)]
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
                sig[j] = i
                push(cola, (nd, j))
    return (np.frombuffer(dist, dtype=np.float64).astype(np.float32),
            np.frombuffer(sig, dtype=np.int32).copy())


class Refugios:
    """Refugios + arboles de caminos para una pendiente maxima dada."""

    def __init__(self, datos, motor, ruta_cache_base):
        self.datos = datos
        self.motor = motor
        self.base = ruta_cache_base
        nf, nc, celda, alto = motor.nf, motor.nc, motor.celda, motor.alto
        self.celdas = []
        for r in datos["refugios"]:
            f = int((alto - r["y"]) // celda)
            c = int(r["x"] // celda)
            f, c = min(max(f, 0), nf - 1), min(max(c, 0), nc - 1)
            self.celdas.append(f * nc + c)
        self._arboles = {}            # pendiente -> lista de (costo, siguiente)
        self._estado = {}             # pendiente -> "calculando" | "listo"
        self._progreso = {}
        self._lock = threading.Lock()

    def meta(self):
        return dict(disponible=True, refugios=self.datos["refugios"],
                    cobertura=self.datos.get("cobertura"), fuente=self.datos.get("fuente", ""))

    def _archivo_cache(self, pend):
        firma = hashlib.md5(json.dumps([self.celdas, pend, self.motor.nf, self.motor.nc,
                                        ro.PESO_PENDIENTE, ro.FACTOR_SUBIDA]).encode()).hexdigest()[:10]
        return f"{self.base}_refugios_{firma}.npz"

    def preparar(self, pend):
        """Lanza (si hace falta) el calculo de los arboles en segundo plano."""
        with self._lock:
            if pend in self._estado:
                return self._estado[pend]
            self._estado[pend] = "calculando"
            self._progreso[pend] = 0
        threading.Thread(target=self._calcular, args=(pend,), daemon=True).start()
        return "calculando"

    def _calcular(self, pend):
        cache = self._archivo_cache(pend)
        arboles = None
        if os.path.exists(cache):
            try:
                d = np.load(cache)
                arboles = [(d[f"c{k}"], d[f"s{k}"]) for k in range(len(self.celdas))]
                print(f"Rutas de emergencia: arboles cargados de {os.path.basename(cache)}")
            except Exception:
                arboles = None
        if arboles is None:
            print(f"Rutas de emergencia: preparando caminos a {len(self.celdas)} refugios "
                  f"(pendiente max {pend} grados, solo la primera vez)...")
            costos = self.motor.costos(pend)
            arboles = []
            for k, celda in enumerate(self.celdas):
                arboles.append(_arbol(costos, self.motor.nf, self.motor.nc, celda))
                self._progreso[pend] = k + 1
                print(f"  refugio {k + 1}/{len(self.celdas)} listo")
            try:
                np.savez(cache, **{f"c{k}": a[0] for k, a in enumerate(arboles)},
                         **{f"s{k}": a[1] for k, a in enumerate(arboles)})
            except OSError as e:
                print(f"(No se pudo guardar el cache de refugios: {e})")
        with self._lock:
            self._arboles[pend] = arboles
            self._estado[pend] = "listo"

    def rutas_desde(self, p, pend):
        """Ruta desde el punto p=(x, y) a cada refugio. Si los arboles de esa
        pendiente aun no estan, devuelve dict(listo=False, progreso=...)."""
        estado = self.preparar(pend)
        if estado != "listo":
            return dict(ok=True, listo=False, progreso=self._progreso.get(pend, 0),
                        total=len(self.celdas))
        m = self.motor
        f, c = m._a_celda(p)
        if not (0 <= f < m.nf and 0 <= c < m.nc) or np.isnan(m.z[f, c]):
            return dict(ok=False, error="Punto fuera del mapa.")
        i0 = f * m.nc + c
        salida = []
        for k, (costo, sig) in enumerate(self._arboles[pend]):
            r = self.datos["refugios"][k]
            if not np.isfinite(costo[i0]):
                salida.append(dict(id=r["id"], nombre=r["nombre"], alcanzable=False))
                continue
            camino = [i0]
            while camino[-1] != self.celdas[k] and len(camino) < m.nf * m.nc:
                camino.append(int(sig[camino[-1]]))
            ruta = m.empaquetar(camino, float(costo[i0]), p, (r["x"], r["y"]), pend)
            # tiempo a pie paso a paso (Tobler)
            xs, ys, zs = (np.array(ruta[v]) for v in ("x", "y", "z"))
            if len(xs) > 1:
                dxy = np.hypot(np.diff(xs), np.diff(ys))
                dz = np.diff(zs)
                t_paso = np.hypot(dxy, dz) / velocidad_tobler(dz, dxy)
                t_acum = np.concatenate([[0.0], np.cumsum(t_paso)])
            else:
                t_acum = np.zeros(1)
            ruta.update(id=r["id"], nombre=r["nombre"], alcanzable=True,
                        tiempo_s=round(float(t_acum[-1]), 1),
                        t=np.round(t_acum, 1).tolist())
            salida.append(ruta)
        return dict(ok=True, listo=True, desde=list(p), pendiente_maxima=pend, rutas=salida)
