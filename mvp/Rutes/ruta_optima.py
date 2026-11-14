"""
ruta_optima.py  -  Calcula la ruta optima entre dos puntos sobre tu mapa de
elevacion de Marte (.asc) usando el algoritmo A* (da la misma ruta que Dijkstra, pero mas rapido).

>> Para cambiar inicio/destino y la pendiente SIN reiniciar, y recorrer la
>> ruta con la camara dentro del mapa 3D, usa el visor:  py visor_rutas.py

La ruta "optima" es la de MENOR COSTO, y el costo tiene en cuenta:
  - la distancia real recorrida sobre el terreno (incluyendo subidas/bajadas)
  - un castigo por la pendiente: cuanto mas empinado, mas "caro" es el paso
  - una prohibicion total de pasar por pendientes mayores al limite

COMO USARLO:
  1. Pon este archivo en la MISMA carpeta que tu matriz_elevacion.asc
  2. Ejecuta:   py ruta_optima.py
  3. Se abre el mapa. Haz CLIC donde quieras el INICIO y luego CLIC donde
     quieras el DESTINO. El programa calcula y dibuja la ruta.
  (Si quieres, puedes cambiar los numeros de la seccion AJUSTES.)
"""

import sys
import os
import csv
import heapq
import math
import warnings
from array import array

import numpy as np
import matplotlib.pyplot as plt
from matplotlib.colors import LightSource

# ======================================================================
#                              AJUSTES
# ======================================================================

# Nombre de tu archivo de elevacion
NOMBRE_ARCHIVO = "matriz_elevacion.asc"

# --- COMO ELEGIR LOS PUNTOS -----------------------------------------
# True  = el programa abre el mapa y tu eliges los puntos con el raton.
# False = el programa usa las coordenadas de PUNTO_INICIO y PUNTO_DESTINO.
ELEGIR_CON_CLIC = True

# Solo se usan si ELEGIR_CON_CLIC = False.
# Se escriben como (X, Y) en METROS, desde la esquina INFERIOR IZQUIERDA
# del mapa. Cuando calculas una ruta con clics, el programa te imprime
# estas dos lineas ya listas para copiar y pegar aqui.
# Si las dejas en None, usa dos esquinas opuestas del mapa.
PUNTO_INICIO = None
PUNTO_DESTINO = None

# --- COMO SE COMPORTA EL VEHICULO -----------------------------------
# Pendiente maxima que puede cruzar, en grados. Pasos mas empinados que
# esto estan PROHIBIDOS. (Un rover marciano suele limitarse a 20-30 grados)
PENDIENTE_MAXIMA = 15

# Que tanto prefiere evitar pendientes aunque sean permitidas.
#   0  = solo le importa la distancia (ignora la pendiente, salvo la prohibida)
#   3  = (recomendado) rodea las zonas empinadas si el desvio no es enorme
#   10 = evita las pendientes casi a cualquier precio
PESO_PENDIENTE = 3

# Cuanto mas "caro" es subir que bajar. 1 = igual; 1.5 = subir cuesta
# 50% mas que bajar con la misma inclinacion.
FACTOR_SUBIDA = 1.0

# --- RESOLUCION DEL CALCULO -----------------------------------------
# Tamano de celda con que se calcula la ruta, en metros. Menor = mas
# detalle pero mas lento y con mas memoria. 10 es un buen equilibrio.
TAMANO_CELDA_CALCULO = 10

# Tope de celdas para no quedarte sin memoria. Si el mapa lo supera, el
# programa agranda la celda solo y te lo avisa.
MAX_CELDAS = 1_500_000

# Para el dibujo 3D (no afecta a la ruta)
MAX_LADO_3D = 300
# ======================================================================


# ---------------------------- LECTURA ---------------------------------
def leer_asc(ruta):
    """Lee un archivo Arc/Info ASCII Grid. Devuelve (matriz, tamano_celda)."""
    encabezado = {}
    with open(ruta, "r") as f:
        while True:
            pos = f.tell()
            linea = f.readline()
            partes = linea.split()
            if len(partes) == 2 and partes[0].replace("_", "").isalpha():
                encabezado[partes[0].lower()] = float(partes[1])
            else:
                f.seek(pos)
                break
        datos = np.array(f.read().split(), dtype=np.float32)

    ncols = int(encabezado["ncols"])
    nrows = int(encabezado["nrows"])
    celda = encabezado["cellsize"]
    nodata = encabezado.get("nodata_value", -9999.0)

    matriz = datos.reshape(nrows, ncols)
    matriz[matriz == nodata] = np.nan
    matriz[matriz < -1e30] = np.nan
    return matriz, celda


def reducir_promedio(mat, factor):
    """Agrupa celdas en bloques de factor x factor y promedia cada bloque."""
    if factor <= 1:
        return mat
    f, c = mat.shape
    f2, c2 = (f // factor) * factor, (c // factor) * factor
    bloques = mat[:f2, :c2].reshape(f2 // factor, factor, c2 // factor, factor)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return np.nanmean(bloques, axis=(1, 3))


def cargar_terreno(ruta_archivo, tam_celda=None, max_celdas=None):
    """Lee el .asc ya reducido a la resolucion de calculo, por bloques de
    filas (no necesita cargar todo el archivo en memoria). El resultado se
    guarda en un .npz al lado del .asc para que los siguientes arranques sean
    instantaneos. Devuelve (z, celda, celda_original, (filas0, cols0))."""
    tam = TAMANO_CELDA_CALCULO if tam_celda is None else tam_celda
    tope = MAX_CELDAS if max_celdas is None else max_celdas
    cache = f"{os.path.splitext(ruta_archivo)[0]}_cache_{tam:g}m.npz"
    if (os.path.exists(cache)
            and os.path.getmtime(cache) >= os.path.getmtime(ruta_archivo)):
        d = np.load(cache)
        print(f"Usando mapa en cache: {os.path.basename(cache)}")
        return (d["z"], float(d["celda"]), float(d["celda0"]),
                tuple(int(v) for v in d["forma0"]))

    print("Leyendo archivo por bloques (solo la primera vez, luego usa cache)...")
    encabezado = {}
    with open(ruta_archivo, "r") as f:
        while True:
            pos = f.tell()
            partes = f.readline().split()
            if len(partes) == 2 and partes[0].replace("_", "").isalpha():
                encabezado[partes[0].lower()] = float(partes[1])
            else:
                f.seek(pos)
                break
        ncols = int(encabezado["ncols"])
        nrows = int(encabezado["nrows"])
        celda0 = encabezado["cellsize"]
        nodata = np.float32(encabezado.get("nodata_value", -9999.0))

        factor = max(1, int(round(tam / celda0)))
        while (nrows // factor) * (ncols // factor) > tope:
            factor += 1
        nf, ncr = nrows // factor, ncols // factor
        z = np.full((nf, ncr), np.nan, dtype=np.float32)

        bloque = factor * ncols
        pedazos, n_pend, fila_out = [], 0, 0
        for linea in f:
            v = np.array(linea.split(), dtype=np.float32)
            pedazos.append(v)
            n_pend += v.size
            while n_pend >= bloque and fila_out < nf:
                todo = np.concatenate(pedazos)
                b, resto = todo[:bloque], todo[bloque:]
                pedazos, n_pend = [resto], resto.size
                b = b.reshape(factor, ncols)[:, :ncr * factor].copy()
                b[(b == nodata) | (b < -1e30)] = np.nan
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore")
                    z[fila_out] = np.nanmean(b.reshape(factor, ncr, factor), axis=(0, 2))
                fila_out += 1
                if fila_out % 50 == 0:
                    print(f"  {100 * fila_out / nf:.0f} %", end="\r", flush=True)
            if fila_out >= nf:
                break
    print("  100 %")
    celda = celda0 * factor
    try:
        np.savez(cache, z=z, celda=celda, celda0=celda0, forma0=np.array([nrows, ncols]))
        print(f"Guardado cache: {os.path.basename(cache)}")
    except OSError as e:
        print(f"(No se pudo guardar el cache: {e})")
    return z, celda, celda0, (nrows, ncols)


# ------------------------ COSTOS Y DIJKSTRA ---------------------------
VECINOS = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]


def calcular_costos(z, celda, pendiente_maxima=None, peso_pendiente=None,
                    factor_subida=None):
    """
    Para cada celda y cada una de sus 8 direcciones, calcula cuanto cuesta
    dar ese paso. Devuelve 8 listas (una por direccion). Un costo infinito
    significa "paso imposible" (fuera del mapa, sin dato, o demasiado empinado).
    Los parametros que se dejan en None toman el valor de AJUSTES.
    """
    pmax = PENDIENTE_MAXIMA if pendiente_maxima is None else pendiente_maxima
    peso = PESO_PENDIENTE if peso_pendiente is None else peso_pendiente
    fsub = FACTOR_SUBIDA if factor_subida is None else factor_subida
    nf, nc = z.shape
    zp = np.pad(z.astype(np.float64), 1, constant_values=np.nan)
    costos = []
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        for dr, dc in VECINOS:
            z2 = zp[1 + dr:1 + dr + nf, 1 + dc:1 + dc + nc]
            dz = z2 - z
            horiz = celda * np.hypot(dr, dc)                 # distancia en el plano
            dist3d = np.hypot(horiz, dz)                     # distancia sobre el terreno
            pend = np.degrees(np.arctan(np.abs(dz) / horiz)) # inclinacion del paso
            factor = 1 + peso * (pend / pmax) ** 2
            factor = np.where(dz > 0, factor * fsub, factor)
            costo = dist3d * factor
            costo[pend > pmax] = np.inf
            costo[np.isnan(costo)] = np.inf
            a = array("d")
            a.frombytes(costo.ravel().tobytes())
            costos.append(a)
    return costos


def dijkstra(costos, nf, nc, inicio, fin):
    """Dijkstra clasico con cola de prioridad. Devuelve la lista de celdas
    de la ruta (indices planos) o None si no hay camino."""
    N = nf * nc
    INF = float("inf")
    dist = array("d", [INF]) * N
    previo = array("i", [-1]) * N
    desplaz = [dr * nc + dc for dr, dc in VECINOS]

    dist[inicio] = 0.0
    cola = [(0.0, inicio)]
    while cola:
        d, i = heapq.heappop(cola)
        if d > dist[i]:
            continue
        if i == fin:
            break
        for k in range(8):
            c = costos[k][i]
            if c == INF:
                continue
            j = i + desplaz[k]
            nd = d + c
            if nd < dist[j]:
                dist[j] = nd
                previo[j] = i
                heapq.heappush(cola, (nd, j))

    if dist[fin] == INF:
        return None, INF
    ruta = [fin]
    while ruta[-1] != inicio:
        ruta.append(previo[ruta[-1]])
    ruta.reverse()
    return ruta, dist[fin]


def astar(costos, nf, nc, inicio, fin, celda, factor_subida=None, cancelado=None):
    """A* sobre la misma red que dijkstra(): da la misma ruta optima pero
    explora muchas menos celdas, porque se guia por la distancia en linea
    recta al destino (que nunca sobreestima el costo real).
    `cancelado` es una funcion opcional; si devuelve True se aborta y se
    devuelve (None, None). Si no hay camino devuelve (None, inf)."""
    fsub = FACTOR_SUBIDA if factor_subida is None else factor_subida
    escala = celda * min(1.0, fsub)          # asi la heuristica es admisible
    N = nf * nc
    INF = float("inf")
    dist = array("d", [INF]) * N
    previo = array("i", [-1]) * N
    desplaz = [dr * nc + dc for dr, dc in VECINOS]
    ff, cf = divmod(fin, nc)
    hypot = math.hypot
    push, pop = heapq.heappush, heapq.heappop

    def h(i):
        r, c = divmod(i, nc)
        return escala * hypot(r - ff, c - cf)

    dist[inicio] = 0.0
    cola = [(h(inicio), 0.0, inicio)]
    n = 0
    while cola:
        _, d, i = pop(cola)
        if d > dist[i]:
            continue
        if i == fin:
            break
        n += 1
        if cancelado is not None and n % 20000 == 0 and cancelado():
            return None, None
        for k in range(8):
            c = costos[k][i]
            if c == INF:
                continue
            j = i + desplaz[k]
            nd = d + c
            if nd < dist[j]:
                dist[j] = nd
                previo[j] = i
                push(cola, (nd + h(j), nd, j))

    if dist[fin] == INF:
        return None, INF
    ruta = [fin]
    while ruta[-1] != inicio:
        ruta.append(previo[ruta[-1]])
    ruta.reverse()
    return ruta, dist[fin]


# ------------------------------- MAIN ---------------------------------
def preparar(ruta_archivo):
    """Lee el mapa, lo reduce a la resolucion de calculo y prepara los costos."""
    z, celda, celda0, (filas0, cols0) = cargar_terreno(ruta_archivo)
    print(f"Mapa original: {cols0} x {filas0} celdas de {celda0} m "
          f"({cols0*celda0/1000:.2f} x {filas0*celda0/1000:.2f} km)")
    nf, nc = z.shape
    if celda > celda0 * 1.01:
        print(f"Para el calculo se usan celdas de {celda:.1f} m "
              f"({nc} x {nf} = {nc*nf:,} celdas)")
    if celda > TAMANO_CELDA_CALCULO * 1.5:
        print(f"AVISO: el mapa es muy grande y se agrando la celda a {celda:.0f} m "
              f"para no quedarse sin memoria. Recorta el mapa en QGIS si necesitas mas detalle.")

    print("Preparando costos...")
    costos = calcular_costos(z, celda)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        gy, gx = np.gradient(z, celda)
        pend_mapa = np.degrees(np.arctan(np.hypot(gx, gy)))
    base = np.where(np.isnan(z), np.nanmin(z), z)
    sombra = LightSource(azdeg=315, altdeg=45).shade(
        base, cmap=plt.cm.gray, vert_exag=3, dx=celda, dy=celda,
        blend_mode="soft", vmin=np.nanmin(z), vmax=np.nanmax(z))
    prohibido = np.ma.masked_where(~(pend_mapa > PENDIENTE_MAXIMA), np.ones_like(z))

    return dict(z=z, celda=celda, nf=nf, nc=nc, ancho=nc * celda, alto=nf * celda,
                costos=costos, sombra=sombra, prohibido=prohibido)


def dibujar_base(ax, D):
    """Dibuja el relieve sombreado y las zonas prohibidas (pendiente > limite)."""
    extent = [0, D["ancho"], 0, D["alto"]]
    ax.imshow(D["sombra"], extent=extent)
    ax.imshow(D["prohibido"], extent=extent, cmap="autumn", alpha=0.55, vmin=0, vmax=1)
    ax.set_xlabel("Este-Oeste (m)")
    ax.set_ylabel("Norte-Sur (m)")


def a_celda(D, p):
    x, y = p
    return int((D["alto"] - y) // D["celda"]), int(x // D["celda"])


def elegir_puntos_con_clic(D):
    """Muestra el mapa y espera dos clics. Devuelve (inicio, destino) o None."""
    fig, ax = plt.subplots(figsize=(10, 9))
    dibujar_base(ax, D)
    fig.subplots_adjust(top=0.88, bottom=0.08, left=0.09, right=0.97)
    plt.show(block=False)
    plt.pause(0.2)

    elegidos = []
    etiquetas = [("INICIO", "lime"), ("DESTINO", "red")]
    k = 0
    while k < 2:
        nombre, color = etiquetas[k]
        ax.set_title(f"Haz CLIC para elegir el {nombre}\n"
                     f"Naranja/amarillo = pendiente mayor a {PENDIENTE_MAXIMA} grados (prohibido).  "
                     f"Si usas la lupa o la mano de la barra, desactivalas antes de hacer clic",
                     fontsize=10)
        fig.canvas.draw_idle()
        pts = plt.ginput(1, timeout=0)
        if not pts:                      # cerraron la ventana
            plt.close(fig)
            return None
        p = pts[0]
        f, c = a_celda(D, p)
        if not (0 <= f < D["nf"] and 0 <= c < D["nc"]) or np.isnan(D["z"][f, c]):
            print("Ese punto esta fuera del mapa o sin datos. Elige otro.")
            continue
        elegidos.append(p)
        ax.scatter(*p, c=color, s=140, edgecolor="k", zorder=5)
        ax.annotate(nombre.capitalize(), p, xytext=(8, 8), textcoords="offset points",
                    color="white", fontweight="bold",
                    bbox=dict(boxstyle="round", fc="black", alpha=0.6))
        fig.canvas.draw_idle()
        plt.pause(0.1)
        k += 1
    plt.close(fig)
    return elegidos[0], elegidos[1]


def calcular_y_mostrar(D, ini, fin, n):
    """Calcula la ruta, la imprime, la guarda y la dibuja. Devuelve True si hubo ruta."""
    z, celda, nf, nc = D["z"], D["celda"], D["nf"], D["nc"]
    ancho_m, alto_m = D["ancho"], D["alto"]

    celdas = {}
    for nombre, p in (("INICIO", ini), ("DESTINO", fin)):
        f, c = a_celda(D, p)
        if not (0 <= f < nf and 0 <= c < nc):
            print(f"\nERROR: el punto de {nombre} {p} esta FUERA del mapa. "
                  f"X debe estar entre 0 y {ancho_m:.0f} e Y entre 0 y {alto_m:.0f}.")
            return False
        if np.isnan(z[f, c]):
            print(f"\nERROR: el punto de {nombre} {p} cae en una zona sin datos.")
            return False
        celdas[nombre] = (f, c)

    print(f"\nINICIO : x={ini[0]:.0f} m, y={ini[1]:.0f} m  (altura {z[celdas['INICIO']]:.1f} m)")
    print(f"DESTINO: x={fin[0]:.0f} m, y={fin[1]:.0f} m  (altura {z[celdas['DESTINO']]:.1f} m)")
    print(f"Pendiente maxima permitida: {PENDIENTE_MAXIMA} grados  |  peso de pendiente: {PESO_PENDIENTE}")
    print("Buscando la ruta con A* (puede tardar unos segundos)...")

    i0 = celdas["INICIO"][0] * nc + celdas["INICIO"][1]
    i1 = celdas["DESTINO"][0] * nc + celdas["DESTINO"][1]
    ruta, costo_total = astar(D["costos"], nf, nc, i0, i1, celda)

    if ruta is None:
        print("\nNO EXISTE RUTA entre esos puntos con una pendiente maxima de "
              f"{PENDIENTE_MAXIMA} grados.")
        print("Posibles causas: el inicio o el destino esta rodeado de paredes muy empinadas "
              "(por ejemplo, dentro de un crater cerrado), o el limite de pendiente es muy bajo.")
        print("Elige otros puntos o sube PENDIENTE_MAXIMA.")
        return False

    filas_r = np.array([i // nc for i in ruta])
    cols_r = np.array([i % nc for i in ruta])
    xs = (cols_r + 0.5) * celda
    ys = alto_m - (filas_r + 0.5) * celda
    zs = z[filas_r, cols_r]
    dxy = np.hypot(np.diff(xs), np.diff(ys))
    dz = np.diff(zs)
    d3 = np.hypot(dxy, dz)
    pend_pasos = np.degrees(np.arctan(np.abs(dz) / dxy))
    dist_acum = np.concatenate([[0], np.cumsum(d3)])
    recta = np.hypot(ini[0] - fin[0], ini[1] - fin[1])

    print("\n================ RESULTADO DE LA RUTA ================")
    print(f"Distancia recorrida (sobre el terreno): {d3.sum():,.0f} m")
    print(f"Distancia en linea recta (mapa plano) : {recta:,.0f} m")
    print(f"La ruta es {100*(d3.sum()/recta-1):.1f} % mas larga que la recta")
    print(f"Subida acumulada : {dz[dz > 0].sum():,.1f} m")
    print(f"Bajada acumulada : {-dz[dz < 0].sum():,.1f} m")
    print(f"Pendiente maxima en la ruta  : {pend_pasos.max():.1f} grados")
    print(f"Pendiente media en la ruta   : {pend_pasos.mean():.1f} grados")
    print("======================================================")
    print("\nPara repetir exactamente esta ruta sin hacer clic, pega esto en AJUSTES:")
    print("   ELEGIR_CON_CLIC = False")
    print(f"   PUNTO_INICIO = ({ini[0]:.0f}, {ini[1]:.0f})")
    print(f"   PUNTO_DESTINO = ({fin[0]:.0f}, {fin[1]:.0f})\n")

    f_csv = f"ruta_optima_{n}.csv"
    with open(f_csv, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["distancia_acumulada_m", "x_m", "y_m", "altura_m"])
        for a, b, c_, d in zip(dist_acum, xs, ys, zs):
            w.writerow([f"{a:.1f}", f"{b:.1f}", f"{c_:.1f}", f"{d:.2f}"])
    print(f"Guardado: {f_csv}  (coordenadas de cada punto de la ruta)")

    # ---- Figura 1: mapa + perfil ----
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(16, 7),
                                   gridspec_kw={"width_ratios": [1.3, 1]})
    dibujar_base(ax1, D)
    ax1.plot(xs, ys, color="cyan", lw=2.5, label="Ruta optima")
    ax1.plot([ini[0], fin[0]], [ini[1], fin[1]], "w--", lw=1, alpha=0.8, label="Linea recta")
    ax1.scatter(*ini, c="lime", s=120, edgecolor="k", zorder=5, label="Inicio")
    ax1.scatter(*fin, c="red", s=120, edgecolor="k", zorder=5, label="Destino")
    ax1.set_title(f"Ruta optima  (rojo/naranja = pendiente > {PENDIENTE_MAXIMA}°, prohibido)")
    ax1.legend(loc="upper left", fontsize=9)
    ax2.fill_between(dist_acum, zs, zs.min() - 0.05 * (zs.max() - zs.min() + 1),
                     color="tab:brown", alpha=0.35)
    ax2.plot(dist_acum, zs, color="tab:brown", lw=2)
    ax2.set_title("Perfil de elevacion a lo largo de la ruta")
    ax2.set_xlabel("Distancia recorrida (m)")
    ax2.set_ylabel("Altura (m)")
    ax2.grid(alpha=0.3)
    fig.tight_layout()
    f_mapa = f"ruta_mapa_{n}.png"
    fig.savefig(f_mapa, dpi=150)
    print(f"Guardado: {f_mapa}")

    # ---- Figura 2: 3D ----
    f3 = max(1, int(np.ceil(max(nf, nc) / MAX_LADO_3D)))
    z3 = reducir_promedio(z, f3)
    c3 = celda * f3
    y3, x3 = np.mgrid[0:z3.shape[0], 0:z3.shape[1]]
    x3 = (x3 + 0.5) * c3
    y3 = (z3.shape[0] - 0.5 - y3) * c3
    fig3 = plt.figure(figsize=(11, 8))
    ax3 = fig3.add_subplot(111, projection="3d")
    ax3.plot_surface(x3, y3, z3, cmap="viridis", linewidth=0, antialiased=False,
                     rcount=z3.shape[0], ccount=z3.shape[1], alpha=0.9)
    extra = (np.nanmax(z) - np.nanmin(z)) * 0.01
    ax3.plot(xs, ys, zs + extra, color="red", lw=3.5, label="Ruta optima", zorder=10)
    ax3.plot([ini[0]], [ini[1]], [z[celdas["INICIO"]] + extra], "o", color="white",
             markersize=11, markeredgecolor="k", zorder=11, label="Inicio")
    ax3.plot([fin[0]], [fin[1]], [z[celdas["DESTINO"]] + extra], "o", color="magenta",
             markersize=11, markeredgecolor="k", zorder=11, label="Destino")
    ancho = max(z3.shape)
    alto_real = (np.nanmax(z3) - np.nanmin(z3)) / c3
    ax3.set_box_aspect((z3.shape[1], z3.shape[0], min(alto_real * 2, ancho * 0.5)))
    ax3.set_title("Ruta en 3D (altura exagerada). Arrastra con el raton para girar")
    ax3.set_xlabel("Este-Oeste (m)", labelpad=12)
    ax3.set_ylabel("Norte-Sur (m)", labelpad=12)
    ax3.set_zlabel("Altura (m)", labelpad=18)
    ax3.xaxis.set_major_locator(plt.MaxNLocator(4))
    ax3.yaxis.set_major_locator(plt.MaxNLocator(4))
    ax3.zaxis.set_major_locator(plt.MaxNLocator(5))
    ax3.view_init(elev=40, azim=-60)
    ax3.legend(loc="upper right")
    f_3d = f"ruta_3d_{n}.png"
    fig3.savefig(f_3d, dpi=150)
    print(f"Guardado: {f_3d}")

    print("\nSe abriran las ventanas con la ruta. Cierralas para continuar.")
    plt.show()
    return True


def main():
    ruta_archivo = sys.argv[1] if len(sys.argv) > 1 else NOMBRE_ARCHIVO
    if not os.path.exists(ruta_archivo):
        print(f"\nNO ENCUENTRO EL ARCHIVO: {ruta_archivo}")
        print("Debe estar en la misma carpeta que este script.")
        input("\nPulsa Enter para salir...")
        return

    D = preparar(ruta_archivo)
    n = 1

    if not ELEGIR_CON_CLIC:
        ini = PUNTO_INICIO if PUNTO_INICIO is not None else (0.08 * D["ancho"], 0.08 * D["alto"])
        fin = PUNTO_DESTINO if PUNTO_DESTINO is not None else (0.92 * D["ancho"], 0.92 * D["alto"])
        calcular_y_mostrar(D, ini, fin, n)
        input("\nPulsa Enter para salir...")
        return

    while True:
        print("\n>>> Se abrio el mapa: haz clic en el INICIO y luego en el DESTINO.")
        puntos = elegir_puntos_con_clic(D)
        if puntos is None:
            print("Cerraste el mapa sin elegir puntos.")
            break
        if calcular_y_mostrar(D, puntos[0], puntos[1], n):
            n += 1
        r = input("\n¿Calcular otra ruta? (s = si, cualquier otra tecla = salir): ").strip().lower()
        if r != "s":
            break
    print("Listo.")


if __name__ == "__main__":
    main()
