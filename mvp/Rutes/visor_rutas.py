"""
visor_rutas.py  -  Visor 3D interactivo de rutas sobre el mapa de Marte.

Carga el mapa UNA sola vez y abre un visor en el navegador donde puedes:
  - Hacer clic en el terreno 3D para mover el INICIO y el DESTINO.
  - Ajustar la pendiente maxima con un deslizador.
  La ruta se recalcula sola cada vez, sin reiniciar el programa.
  - Pulsar "Recorrer ruta" para que la camara viaje por la ruta en primera
    persona (o detras del rover) y avanzar/retroceder por ella.

COMO USARLO:
  1. Pon este archivo junto a ruta_optima.py y matriz_elevacion.asc
  2. Ejecuta:   py visor_rutas.py
  3. Se abre el navegador (si no, entra a la direccion que se imprime).
  Para terminar, pulsa Ctrl+C en esta ventana.

Necesita conexion a internet la primera vez para descargar Three.js (la
libreria 3D del navegador). No hace falta instalar nada en Python.
"""

import json
import os
import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

import geologia
import ruta_optima as ro

PUERTO = 8765
CARPETA_WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "visor")

# Limites del deslizador de pendiente (grados)
PENDIENTE_MIN, PENDIENTE_TOPE = 2, 60


class Motor:
    """Guarda el terreno y calcula rutas. Los costos se recalculan solo cuando
    cambia la pendiente maxima. Si llega una peticion nueva mientras se calcula
    otra, la vieja se cancela (solo importa la ultima que pidio el usuario)."""

    def __init__(self, ruta_asc):
        z, celda, _, _ = ro.cargar_terreno(ruta_asc)
        self.z = z.astype(np.float32)
        self.celda = float(celda)
        self.nf, self.nc = self.z.shape
        self.ancho = self.nc * self.celda
        self.alto = self.nf * self.celda
        self._costos = None
        self._pend_costos = None
        self._lock_costos = threading.Lock()
        self._lock_calculo = threading.Lock()
        self._generacion = 0
        self._lock_gen = threading.Lock()

    def meta(self):
        return dict(nf=self.nf, nc=self.nc, celda=self.celda, ancho=self.ancho,
                    alto=self.alto, zmin=float(np.nanmin(self.z)),
                    zmax=float(np.nanmax(self.z)),
                    pendiente_defecto=ro.PENDIENTE_MAXIMA,
                    pendiente_min=PENDIENTE_MIN, pendiente_tope=PENDIENTE_TOPE,
                    peso_pendiente=ro.PESO_PENDIENTE)

    def costos(self, pend):
        with self._lock_costos:
            if self._pend_costos != pend:
                print(f"Preparando costos para pendiente maxima {pend} grados...")
                self._costos = ro.calcular_costos(self.z, self.celda, pendiente_maxima=pend)
                self._pend_costos = pend
            return self._costos

    def _a_celda(self, p):
        x, y = p
        return int((self.alto - y) // self.celda), int(x // self.celda)

    def ruta(self, ini, fin, pend):
        with self._lock_gen:
            self._generacion += 1
            mi_gen = self._generacion
        cancelado = lambda: self._generacion != mi_gen

        celdas = {}
        for nombre, p in (("inicio", ini), ("destino", fin)):
            f, c = self._a_celda(p)
            if not (0 <= f < self.nf and 0 <= c < self.nc):
                return dict(ok=False, error=f"El {nombre} esta fuera del mapa.")
            if np.isnan(self.z[f, c]):
                return dict(ok=False, error=f"El {nombre} cae en una zona sin datos.")
            celdas[nombre] = (f, c)

        # Un calculo a la vez: si mientras esperabamos llego otra peticion, nos rendimos.
        with self._lock_calculo:
            if cancelado():
                return dict(ok=False, cancelada=True)
            costos = self.costos(pend)
            if cancelado():
                return dict(ok=False, cancelada=True)
            i0 = celdas["inicio"][0] * self.nc + celdas["inicio"][1]
            i1 = celdas["destino"][0] * self.nc + celdas["destino"][1]
            camino, costo = ro.astar(costos, self.nf, self.nc, i0, i1, self.celda,
                                     cancelado=cancelado)
        if camino is None and costo is None:
            return dict(ok=False, cancelada=True)
        if camino is None:
            return dict(ok=False, error=(
                f"No existe ruta con pendiente maxima de {pend} grados. "
                "Prueba subir la tolerancia o mover los puntos (puede que uno "
                "este rodeado de paredes empinadas)."))

        filas = np.array([i // self.nc for i in camino])
        cols = np.array([i % self.nc for i in camino])
        xs = (cols + 0.5) * self.celda
        ys = self.alto - (filas + 0.5) * self.celda
        zs = self.z[filas, cols].astype(np.float64)
        if len(camino) > 1:
            dxy = np.hypot(np.diff(xs), np.diff(ys))
            dz = np.diff(zs)
            d3 = np.hypot(dxy, dz)
            pend_pasos = np.degrees(np.arctan(np.abs(dz) / dxy))
        else:
            dz = d3 = pend_pasos = np.zeros(0)
        recta = float(np.hypot(ini[0] - fin[0], ini[1] - fin[1]))
        total = float(d3.sum())
        return dict(
            ok=True,
            pendiente_maxima=pend,
            x=np.round(xs, 2).tolist(), y=np.round(ys, 2).tolist(),
            z=np.round(zs, 2).tolist(),
            pend=np.round(pend_pasos, 2).tolist(),
            stats=dict(
                distancia=total, recta=recta,
                extra_pct=(100 * (total / recta - 1)) if recta > 0 else 0.0,
                subida=float(dz[dz > 0].sum()), bajada=float(-dz[dz < 0].sum()),
                pend_max=float(pend_pasos.max()) if pend_pasos.size else 0.0,
                pend_media=float(pend_pasos.mean()) if pend_pasos.size else 0.0,
                costo=float(costo)))


def crear_handler(motor, geo=None):
    """`geo` es la capa geologica opcional (ver geologia.py); None = sin capa."""
    alturas = motor.z.astype("<f4").tobytes()   # NaN = sin datos

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=CARPETA_WEB, **kw)

        def log_message(self, fmt, *args):
            pass   # silencioso: solo imprimimos lo importante

        def _json(self, obj, codigo=200):
            datos = json.dumps(obj).encode("utf-8")
            self.send_response(codigo)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(datos)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(datos)

        def do_GET(self):
            if self.path == "/api/terreno":
                return self._json(motor.meta())
            if self.path == "/api/alturas":
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(alturas)))
                self.end_headers()
                self.wfile.write(alturas)
                return
            if self.path == "/api/geologia":
                return self._json(geo["meta"] if geo else dict(disponible=False))
            if self.path == "/api/geologia_celdas" and geo:
                self.send_response(200)
                self.send_header("Content-Type", "application/octet-stream")
                self.send_header("Content-Length", str(len(geo["celdas"])))
                self.end_headers()
                self.wfile.write(geo["celdas"])
                return
            return super().do_GET()

        def do_POST(self):
            if self.path != "/api/ruta":
                return self._json(dict(ok=False, error="No encontrado"), 404)
            try:
                n = int(self.headers.get("Content-Length", 0))
                pet = json.loads(self.rfile.read(n) or b"{}")
                ini = tuple(float(v) for v in pet["inicio"])
                fin = tuple(float(v) for v in pet["destino"])
                pend = float(pet.get("pendiente_maxima", ro.PENDIENTE_MAXIMA))
                pend = round(min(max(pend, PENDIENTE_MIN), PENDIENTE_TOPE), 1)
            except (ValueError, KeyError, TypeError) as e:
                return self._json(dict(ok=False, error=f"Peticion invalida: {e}"), 400)
            try:
                res = motor.ruta(ini, fin, pend)
            except Exception as e:   # que un error no tumbe el servidor
                return self._json(dict(ok=False, error=f"Error interno: {e}"), 500)
            if res.get("ok"):
                s = res["stats"]
                print(f"Ruta: {s['distancia']:,.0f} m  |  pendiente max {pend} grados  |  "
                      f"inicio ({ini[0]:.0f}, {ini[1]:.0f})  destino ({fin[0]:.0f}, {fin[1]:.0f})")
            elif res.get("error"):
                print(f"Sin ruta: {res['error']}")
            return self._json(res)

    return Handler


def main():
    # Por defecto el mapa se busca junto a este script, se ejecute desde donde se ejecute
    carpeta = os.path.dirname(os.path.abspath(__file__))
    ruta_asc = sys.argv[1] if len(sys.argv) > 1 else os.path.join(carpeta, ro.NOMBRE_ARCHIVO)
    if not os.path.exists(ruta_asc):
        print(f"\nNO ENCUENTRO EL ARCHIVO: {ruta_asc}")
        input("\nPulsa Enter para salir...")
        return
    motor = Motor(ruta_asc)
    print(f"Terreno listo: {motor.nc} x {motor.nf} celdas de {motor.celda:.1f} m "
          f"({motor.ancho/1000:.2f} x {motor.alto/1000:.2f} km)")
    motor.costos(ro.PENDIENTE_MAXIMA)    # deja listos los costos por defecto
    geo = geologia.cargar(motor.z, motor.celda)     # opcional: None si no hay capa
    if geo:
        print("Capa geologica: " + ", ".join(
            f"{u['codigo']} {u['pct']:.0f} %" for u in geo["meta"]["unidades"]))

    url = f"http://127.0.0.1:{PUERTO}/"
    # En Windows, SO_REUSEADDR deja abrir dos servidores en el mismo puerto sin error
    # (y no se sabe cual responde); asi detectamos si el visor ya esta abierto.
    if os.name == "nt":
        ThreadingHTTPServer.allow_reuse_address = False
    try:
        servidor = ThreadingHTTPServer(("127.0.0.1", PUERTO), crear_handler(motor, geo))
    except OSError:
        print(f"\nEl puerto {PUERTO} ya esta en uso: probablemente el visor ya esta abierto "
              f"en otra ventana. Abriendo {url} ...")
        print("Si quieres reiniciarlo, cierra la otra ventana (Ctrl+C) y vuelve a ejecutar esto.")
        webbrowser.open(url)
        return
    print(f"\nVisor abierto en {url}   (Ctrl+C para terminar)\n")
    threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        print("\nListo.")
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
