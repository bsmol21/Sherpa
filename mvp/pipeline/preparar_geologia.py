"""
preparar_geologia.py  -  Recorta el mapa geologico global de Marte (USGS
SIM 3292, Tanaka et al. 2014, escala 1:20.000.000) a la zona del mapa de
elevacion y lo guarda en datos/procesados/geologia.json.

Se corre UNA sola vez (o cuando cambie el mapa de elevacion):

    py preparar_geologia.py

Entradas (rutas por defecto, se pueden pasar como argumentos):
  1. datos/crudos/SIM3292_Global_Geology   (.shp + .dbf, sin extension)
  2. Rutes/matriz_elevacion.asc            (solo se lee el encabezado y el .prj)

Salida: datos/procesados/geologia.json con las unidades geologicas que tocan
el mapa y sus poligonos ya recortados, en METROS desde la esquina SUPERIOR
IZQUIERDA del mapa de elevacion (x = este, y = sur). Al estar en metros y no
en celdas, sirve para cualquier resolucion de calculo: el visor lo convierte
a su rejilla al arrancar (ver Rutes/geologia.py).

No necesita librerias GIS: lee el shapefile directamente (solo usa numpy).

OJO CON LA ESCALA: es un mapa GLOBAL. Un milimetro del mapa impreso son 20 km,
asi que los contactos entre unidades pueden estar corridos varios kilometros.
Sirve como contexto cientifico, no para decidir por donde caminar.
"""

import json
import math
import os
import re
import struct
import sys

import numpy as np

AQUI = os.path.dirname(os.path.abspath(__file__))
MVP = os.path.dirname(AQUI)
SHP_DEFECTO = os.path.join(MVP, "datos", "crudos", "SIM3292_Global_Geology")
DEM_DEFECTO = os.path.join(MVP, "Rutes", "matriz_elevacion.asc")
SALIDA = os.path.join(MVP, "datos", "procesados", "geologia.json")

# Los poligonos se recortan un poco mas alla del borde del mapa
MARGEN = 100.0   # m

# El shapefile declara el elipsoide de Marte 2000, pero el mapa se dibujo sobre
# la ESFERA de Marte 2000 (latitud planetocentrica), igual que el DTM de HiRISE.
# Por eso las latitudes se usan tal cual. Si se tratara como planetografica, los
# contactos se correrian ~12 km al sur en Jezero.
FUENTE = ("USGS SIM 3292, Geologic Map of Mars (Tanaka et al., 2014), "
          "escala 1:20.000.000")
NOTA = ("Mapa global: los contactos pueden estar corridos varios kilometros. "
        "Edades aproximadas (modelo de conteo de crateres).")

# Colores de la capa (contrastan con el terreno rojizo), por orden de area
COLORES = [(0.20, 0.78, 0.62), (0.66, 0.48, 0.95), (0.95, 0.85, 0.30),
           (0.35, 0.60, 0.98), (0.95, 0.45, 0.75), (0.60, 0.85, 0.30)]

# ---------------------------------------------------------------------------
# Nombre en espanol y edad a partir del codigo de la unidad, p. ej. "mNhm":
#   [e|m|l] epoca (temprano/medio/tardio) + periodo(s) A/H/N + tipo de terreno
PERIODOS = {"N": "Noeico", "H": "Hespérico", "A": "Amazónico"}
EPOCAS = {"e": "Temprano", "m": "Medio", "l": "Tardío"}
# (mas antiguo, mas reciente) en millones de anos, redondeado
EDADES = {"eN": (4100, 3900), "mN": (3900, 3800), "lN": (3800, 3700), "N": (4100, 3700),
          "eH": (3700, 3600), "lH": (3600, 3400), "H": (3700, 3400),
          "eA": (3400, 1200), "mA": (1200, 300), "lA": (300, 0), "A": (3400, 0)}
TIPOS = {
    "h": "de tierras altas", "hm": "de macizos de tierras altas",
    "he": "de edificios de tierras altas", "hu": "indivisa de tierras altas",
    "t": "de transición", "tu": "indivisa de transición",
    "to": "de canales de desbordamiento", "i": "de impacto",
    "v": "volcánica", "ve": "de edificios volcánicos", "vf": "de campos volcánicos",
    "l": "de tierras bajas", "a": "de delantales de derrubios", "b": "de cuenca",
    "p": "polar", "pe": "de edificios polares", "pu": "polar indivisa",
    "pd": "de dunas polares", "pc": "de casquete polar",
}
# Por que le interesa al astronauta (lo dice Sherpa al entrar en la unidad)
INTERES = {
    "hm": "Son macizos levantados por un impacto gigante: de la corteza más antigua de Marte.",
    "h": "Es corteza antigua de las tierras altas, muy craterizada.",
    "t": "Es terreno de transición entre las tierras altas y las bajas, modelado por erosión y sedimentos.",
    "i": "Es material expulsado por un cráter de impacto: trae a la superficie roca de las profundidades.",
    "v": "Son coladas de lava.",
    "ve": "Es el flanco de un volcán.",
}


def _miles(n):
    return f"{n:,}".replace(",", ".")


def describir(codigo):
    """Devuelve (nombre, edad, interes) en espanol para un codigo de unidad."""
    m = re.fullmatch(r"([eml]?)([AHN]{1,2})([a-z]*)", codigo)
    if not m:
        return f"unidad {codigo}", "", ""
    epoca, periodos, tipo = m.groups()
    nombre_per = "-".join(PERIODOS[p] for p in periodos)
    if epoca:
        nombre_per += f" {EPOCAS[epoca]}"
    nombre = f"unidad {TIPOS.get(tipo, tipo)} del {nombre_per}".replace("  ", " ")
    rangos = [EDADES.get(epoca + p) or EDADES[p] for p in periodos]
    viejo, joven = max(r[0] for r in rangos), min(r[1] for r in rangos)
    if joven == 0:
        edad = f"menos de {_miles(viejo)} millones de años"
    else:
        edad = f"entre {_miles(joven)} y {_miles(viejo)} millones de años"
    return nombre, edad, INTERES.get(tipo, "")


# ------------------------------------------------------------- lectura
def leer_dbf(ruta):
    """Lee la tabla de atributos. Devuelve una lista de diccionarios."""
    with open(ruta, "rb") as f:
        cab = f.read(32)
        nreg, lcab, lreg = struct.unpack("<IHH", cab[4:12])
        campos = []
        while True:
            d = f.read(32)
            if d[0] == 0x0D:
                break
            campos.append((d[:11].split(b"\0")[0].decode(), d[16]))
        f.seek(lcab)
        filas = []
        for _ in range(nreg):
            r = f.read(lreg)
            pos, fila = 1, {}
            for nombre, largo in campos:
                fila[nombre] = r[pos:pos + largo].decode("latin-1").strip()
                pos += largo
            filas.append(fila)
    return filas


def leer_shp(ruta):
    """Recorre los poligonos del .shp: (indice, caja, inicio de cada anillo, puntos)."""
    with open(ruta, "rb") as f:
        f.seek(100)
        i = 0
        while True:
            cab = f.read(8)
            if len(cab) < 8:
                break
            d = f.read(struct.unpack(">i", cab[4:8])[0] * 2)
            if struct.unpack("<i", d[:4])[0] in (5, 15, 25):       # poligono
                caja = struct.unpack("<4d", d[4:36])
                npartes, npts = struct.unpack("<2i", d[36:44])
                partes = struct.unpack(f"<{npartes}i", d[44:44 + 4 * npartes])
                pts = np.frombuffer(d, dtype="<f8", count=2 * npts,
                                    offset=44 + 4 * npartes).reshape(-1, 2)
                yield i, caja, partes, pts
            i += 1


def leer_georef(ruta_asc):
    """Encabezado del .asc y proyeccion de su .prj (cilindrica equidistante)."""
    enc = {}
    with open(ruta_asc, "r") as f:
        for _ in range(6):
            partes = f.readline().split()
            if len(partes) == 2:
                enc[partes[0].lower()] = float(partes[1])
    with open(os.path.splitext(ruta_asc)[0] + ".prj", "r") as f:
        prj = f.read()
    if "Equidistant_Cylindrical" not in prj:
        raise SystemExit("El .prj del mapa no es una proyeccion cilindrica equidistante; "
                         "este script solo sabe con esa.")

    def param(nombre):
        return float(re.search(rf'PARAMETER\["{nombre}",\s*([-\d.eE+]+)', prj).group(1))

    radio = float(re.search(r'SPHEROID\["[^"]*",\s*([\d.eE+]+)', prj).group(1))
    return dict(
        radio=radio, lon0=param("Central_Meridian"), lat1=param("Standard_Parallel_1"),
        x_izq=enc["xllcorner"] - param("False_Easting"),
        y_sup=enc["yllcorner"] + enc["nrows"] * enc["cellsize"] - param("False_Northing"),
        ancho=enc["ncols"] * enc["cellsize"], alto=enc["nrows"] * enc["cellsize"])


# ------------------------------------------------------------ geometria
def recortar(anillo, x0, y0, x1, y1):
    """Recorta un anillo (lista de (x, y)) contra un rectangulo (Sutherland-Hodgman)."""
    bordes = [(0, x0, 1), (0, x1, -1), (1, y0, 1), (1, y1, -1)]   # (eje, limite, signo)
    for eje, lim, sg in bordes:
        if not anillo:
            break
        sal, a = [], anillo[-1]
        for b in anillo:
            da, db = (a[eje] - lim) * sg, (b[eje] - lim) * sg
            if (da >= 0) != (db >= 0):
                t = da / (da - db)
                sal.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            if db >= 0:
                sal.append(b)
            a = b
        anillo = sal
    return anillo


def area(anillo):
    s = 0.0
    for (xa, ya), (xb, yb) in zip(anillo, anillo[1:] + anillo[:1]):
        s += xa * yb - xb * ya
    return s / 2          # con signo: los huecos restan


# ----------------------------------------------------------------- main
def main():
    base_shp = os.path.splitext(sys.argv[1])[0] if len(sys.argv) > 1 else SHP_DEFECTO
    ruta_dem = sys.argv[2] if len(sys.argv) > 2 else DEM_DEFECTO
    for ruta in (base_shp + ".shp", base_shp + ".dbf", ruta_dem,
                 os.path.splitext(ruta_dem)[0] + ".prj"):
        if not os.path.exists(ruta):
            raise SystemExit(f"NO ENCUENTRO EL ARCHIVO: {ruta}")

    g = leer_georef(ruta_dem)
    m_lon = g["radio"] * math.cos(math.radians(g["lat1"])) * math.pi / 180   # m por grado
    m_lat = g["radio"] * math.pi / 180
    # Caja del mapa (con margen) en grados, para descartar rapido casi todo
    lon_a = g["lon0"] + (g["x_izq"] - MARGEN) / m_lon
    lon_b = g["lon0"] + (g["x_izq"] + g["ancho"] + MARGEN) / m_lon
    lat_b = (g["y_sup"] + MARGEN) / m_lat
    lat_a = (g["y_sup"] - g["alto"] - MARGEN) / m_lat
    print(f"Mapa de elevacion: {g['ancho']/1000:.2f} x {g['alto']/1000:.2f} km, "
          f"lon {lon_a:.3f} a {lon_b:.3f} E, lat {lat_a:.3f} a {lat_b:.3f} N")

    atributos = leer_dbf(base_shp + ".dbf")
    unidades = {}                                    # codigo -> dict
    for i, (xa, ya, xb, yb), partes, pts in leer_shp(base_shp + ".shp"):
        if xb < lon_a or xa > lon_b or yb < lat_a or ya > lat_b:
            continue
        # grados -> metros desde la esquina superior izquierda (x este, y sur)
        x = (pts[:, 0] - g["lon0"]) * m_lon - g["x_izq"]
        y = g["y_sup"] - pts[:, 1] * m_lat
        limites = list(partes) + [len(pts)]
        anillos = []
        for a, b in zip(limites[:-1], limites[1:]):
            anillo = recortar(list(zip(x[a:b].tolist(), y[a:b].tolist())),
                              -MARGEN, -MARGEN, g["ancho"] + MARGEN, g["alto"] + MARGEN)
            if len(anillo) >= 3 and abs(area(anillo)) > 1.0:
                anillos.append([[round(px, 1), round(py, 1)] for px, py in anillo])
        if not anillos:
            continue
        codigo = atributos[i]["Unit"]
        u = unidades.setdefault(codigo, dict(codigo=codigo,
                                             descripcion=atributos[i]["UnitDesc"],
                                             poligonos=[], area=0.0))
        u["poligonos"].append(anillos)
        u["area"] += abs(sum(area([tuple(p) for p in an]) for an in anillos))

    if not unidades:
        raise SystemExit("Ningun poligono del mapa geologico toca el mapa de elevacion. "
                         "Revisa que los dos archivos sean de la misma zona.")

    lista = sorted(unidades.values(), key=lambda u: -u["area"])
    total = sum(u["area"] for u in lista)
    print("\nUnidades geologicas en el mapa:")
    for k, u in enumerate(lista):
        u["nombre"], u["edad"], u["interes"] = describir(u["codigo"])
        u["color"] = list(COLORES[k % len(COLORES)])
        print(f"  {u['codigo']:6s} {100 * u.pop('area') / total:5.1f} %  {u['nombre']}  ({u['edad']})")

    os.makedirs(os.path.dirname(SALIDA), exist_ok=True)
    with open(SALIDA, "w", encoding="utf-8") as f:
        json.dump(dict(fuente=FUENTE, nota=NOTA,
                       origen="esquina superior izquierda del mapa de elevacion; "
                              "x = este (m), y = sur (m)",
                       ancho=round(g["ancho"], 1), alto=round(g["alto"], 1),
                       unidades=lista), f, ensure_ascii=False, indent=1)
    print(f"\nGuardado: {SALIDA}  ({os.path.getsize(SALIDA) / 1024:.1f} KB)")
    print("Ahora abre el visor (py visor_rutas.py) y marca la casilla \"Capa geologica\".")


if __name__ == "__main__":
    main()
