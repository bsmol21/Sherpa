"""
ver_terreno.py  -  Visualiza una matriz de elevacion (.asc) de Marte.

COMO USARLO:
  1. Pon este archivo en la MISMA carpeta que tu matriz_elevacion.asc
  2. Ejecutalo (ver instrucciones). Se abren los graficos y ademas se
     guardan como imagenes PNG en esa misma carpeta.

Si tu archivo tiene otro nombre, cambia la linea de abajo.
"""

import sys
import os
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.colors import LightSource

# ----------------------------------------------------------------------
# UNICO AJUSTE QUE TIENES QUE REVISAR: el nombre de tu archivo
# ----------------------------------------------------------------------
NOMBRE_ARCHIVO = "matriz_elevacion.asc"

# Maximo de celdas por lado que se dibujan (solo afecta al dibujo, no a
# tus datos). Si el grafico va lento, bajalo a 500.
MAX_LADO_DIBUJO = 1000

# --- Vista 3D ---
# Tamano de celda que se usa en el 3D, en metros. Menor numero = mas detalle
# (y mas lento al girar). 10 es un buen punto de partida.
TAMANO_CELDA_3D = 10
# Limite de celdas por lado en el 3D, para que no se trabe. Si tu
# computadora es potente, puedes subirlo (por ejemplo a 600).
MAX_LADO_3D = 400
# ----------------------------------------------------------------------


def leer_asc(ruta):
    """Lee un archivo Arc/Info ASCII Grid. Devuelve (matriz, tamano_celda)."""
    encabezado = {}
    with open(ruta, "r") as f:
        # El encabezado son las primeras lineas que empiezan con una palabra
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
    matriz[matriz < -1e30] = np.nan   # por si el valor "sin dato" es enorme
    return matriz, celda


def calcular_pendiente(mat, celda):
    """Pendiente en grados (0 = plano, 90 = pared vertical)."""
    dy, dx = np.gradient(mat, celda)
    return np.degrees(np.arctan(np.hypot(dx, dy)))


def reducir_promedio(mat, factor):
    """Agrupa celdas en bloques de factor x factor y promedia cada bloque."""
    if factor <= 1:
        return mat
    f, c = mat.shape
    f2, c2 = (f // factor) * factor, (c // factor) * factor
    bloques = mat[:f2, :c2].reshape(f2 // factor, factor, c2 // factor, factor)
    with np.errstate(all="ignore"):
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            return np.nanmean(bloques, axis=(1, 3))


def reducir(mat, factor):
    """Toma 1 de cada 'factor' celdas, solo para dibujar mas rapido."""
    return mat[::factor, ::factor]


def main():
    ruta = sys.argv[1] if len(sys.argv) > 1 else NOMBRE_ARCHIVO
    if not os.path.exists(ruta):
        print(f"\nNO ENCUENTRO EL ARCHIVO: {ruta}")
        print("Revisa que este en la misma carpeta que este script y que")
        print("el nombre en NOMBRE_ARCHIVO sea exactamente igual.")
        input("\nPulsa Enter para salir...")
        return

    print("Leyendo archivo (puede tardar si es grande)...")
    mat, celda = leer_asc(ruta)
    filas, cols = mat.shape

    print("\n=========== RESUMEN DE TU TERRENO ===========")
    print(f"Columnas x filas : {cols} x {filas}  ({cols*filas:,} celdas)")
    print(f"Tamano de celda  : {celda} m")
    print(f"Area cubierta    : {cols*celda/1000:.2f} km x {filas*celda/1000:.2f} km")
    print(f"Altura minima    : {np.nanmin(mat):.1f} m")
    print(f"Altura maxima    : {np.nanmax(mat):.1f} m")
    print(f"Desnivel total   : {np.nanmax(mat)-np.nanmin(mat):.1f} m")
    if np.nanmax(mat) <= 255 and np.nanmin(mat) >= 0:
        print("\n!! AVISO: los valores van de 0 a 255. Eso parece una imagen,")
        print("   no un mapa de alturas reales.")
    pend = calcular_pendiente(mat, celda)
    print(f"Pendiente media  : {np.nanmean(pend):.1f} grados")
    print(f"Pendiente maxima : {np.nanmax(pend):.1f} grados")
    print(f"Celdas con pendiente > 25 grados: {100*np.nansum(pend>25)/np.sum(~np.isnan(pend)):.1f} %")
    print("=============================================\n")

    # Version reducida solo para dibujar
    factor = max(1, int(max(filas, cols) / MAX_LADO_DIBUJO))
    m = reducir(mat, factor)
    p = reducir(pend, factor)
    c = celda * factor
    extent = [0, cols * celda, 0, filas * celda]   # en metros

    # ---- Figura 1: elevacion con relieve + pendiente -------------------
    fig, ejes = plt.subplots(1, 2, figsize=(15, 7))

    ls = LightSource(azdeg=315, altdeg=45)
    mat_rell = np.nan_to_num(m, nan=np.nanmin(m))
    sombreado = ls.shade(mat_rell, cmap=plt.cm.viridis, vert_exag=3, dx=c, dy=c,
                         blend_mode="soft", vmin=np.nanmin(m), vmax=np.nanmax(m))
    ejes[0].imshow(sombreado, extent=extent)
    barra0 = fig.colorbar(plt.cm.ScalarMappable(
        norm=plt.Normalize(np.nanmin(m), np.nanmax(m)), cmap="viridis"),
        ax=ejes[0], shrink=0.8)
    barra0.set_label("Altura (m)")
    ejes[0].set_title("Elevacion con relieve sombreado")
    ejes[0].set_xlabel("Este-Oeste (m)")
    ejes[0].set_ylabel("Norte-Sur (m)")

    im1 = ejes[1].imshow(p, cmap="RdYlGn_r", vmin=0, vmax=35, extent=extent)
    barra1 = fig.colorbar(im1, ax=ejes[1], shrink=0.8)
    barra1.set_label("Pendiente (grados)")
    ejes[1].set_title("Mapa de pendiente (verde = plano, rojo = empinado)")
    ejes[1].set_xlabel("Este-Oeste (m)")

    plt.tight_layout()
    fig.savefig("terreno_elevacion_y_pendiente.png", dpi=150)
    print("Guardado: terreno_elevacion_y_pendiente.png")

    # ---- Figura 2: vista 3D --------------------------------------------
    factor3 = max(1, int(round(TAMANO_CELDA_3D / celda)))
    while max(filas, cols) / factor3 > MAX_LADO_3D:
        factor3 += 1
    m3 = reducir_promedio(mat, factor3)
    c3 = celda * factor3
    print(f"Vista 3D: celdas de {c3:.1f} m  ({m3.shape[1]} x {m3.shape[0]} celdas)")
    y3, x3 = np.mgrid[0:m3.shape[0], 0:m3.shape[1]]
    x3 = x3 * c3
    y3 = (m3.shape[0] - 1 - y3) * c3
    fig3 = plt.figure(figsize=(11, 8))
    ax3 = fig3.add_subplot(111, projection="3d")
    sup = ax3.plot_surface(x3, y3, m3, cmap="viridis", linewidth=0,
                           antialiased=False, rcount=m3.shape[0],
                           ccount=m3.shape[1])
    ancho = max(m3.shape)
    alto_real = (np.nanmax(m3) - np.nanmin(m3)) / c3   # en "celdas"
    alto = min(alto_real * 2, ancho * 0.5)    # exagerado x2, pero nunca mas de la mitad del ancho
    ax3.set_box_aspect((m3.shape[1], m3.shape[0], alto))
    ax3.set_title("Vista 3D (altura exagerada). Arrastra con el raton para girar")
    ax3.set_xlabel("Este-Oeste (m)", labelpad=12)
    ax3.set_ylabel("Norte-Sur (m)", labelpad=12)
    ax3.set_zlabel("Altura (m)", labelpad=18)
    ax3.xaxis.set_major_locator(plt.MaxNLocator(4))
    ax3.yaxis.set_major_locator(plt.MaxNLocator(4))
    ax3.zaxis.set_major_locator(plt.MaxNLocator(5))
    ax3.view_init(elev=35, azim=-60)
    fig3.colorbar(sup, shrink=0.5, pad=0.18, label="Altura (m)")
    fig3.savefig("terreno_3d.png", dpi=150)
    print("Guardado: terreno_3d.png")

    print("\nSe abriran las ventanas. Cierralas para terminar.")
    plt.show()


if __name__ == "__main__":
    main()
