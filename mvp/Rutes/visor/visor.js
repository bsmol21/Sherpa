// Visor 3D de rutas de PathFinder.
// Coordenadas: el backend trabaja en METROS desde la esquina inferior izquierda
// del mapa (x = este, y = norte). En la escena 3D: X = este, Y = arriba,
// Z = sur, con el centro del mapa en el origen.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { crearCasco } from "./casco.js";

const $ = (id) => document.getElementById(id);
const VELOCIDADES = [1.5, 3, 5, 10, 25, 50, 100, 250, 500];   // m/s
const CAMARAS = ["Primera persona", "Persecución", "Aérea"];
const ALTURA_OJOS = 1.7;                                      // m, dentro del casco

// ------------------------------------------------------------------ estado
const E = {
  meta: null, alt: null, pendCelda: null,       // terreno
  exag: 3, tol: 15, verProhibido: true,
  modo: "inicio", inicio: null, destino: null,  // puntos en metros [x, y]
  ruta: null,                                   // {x,y,z,pend,cum,total,stats,sx,sy,celdas}
  peticion: 0,
  // recorrido
  siguiendo: false, reproduciendo: true, s: 0, vel: 3, cam: 1,
  yaw: 0, pitch: 0, distPersec: 1,
  // atmosfera
  polvo: 0.2, solElev: 35, remolinos: true, t: 0,
};

// ------------------------------------------------------------------ escena
const lienzo = $("escena");
const renderer = new THREE.WebGLRenderer({ canvas: lienzo, antialias: true,
  logarithmicDepthBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const escena = new THREE.Scene();
const camara = new THREE.PerspectiveCamera(55, 1, 0.1, 1e6);
const controles = new OrbitControls(camara, lienzo);
controles.enableDamping = true;
controles.maxPolarAngle = Math.PI * 0.49;
controles.zoomToCursor = true;
controles.screenSpacePanning = false;

const hemi = new THREE.HemisphereLight(0xffe8d6, 0x3a2418, 0.9);
const sol = new THREE.DirectionalLight(0xffffff, 1.6);
// La sombra solo se calcula en una caja pequena alrededor del astronauta
sol.castShadow = true;
sol.shadow.mapSize.set(1024, 1024);
Object.assign(sol.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 1, far: 400 });
sol.shadow.bias = -0.0005;
sol.shadow.normalBias = 0.05;
escena.add(hemi, sol, sol.target);

function redimensionar() {
  renderer.setSize(innerWidth, innerHeight, false);
  camara.aspect = innerWidth / innerHeight;
  camara.updateProjectionMatrix();
}
addEventListener("resize", redimensionar);

// ------------------------------------------------------- conversiones
const M = () => E.meta;
function aMundo(xm, ym, h, out = new THREE.Vector3()) {
  return out.set(xm - M().ancho / 2, (h - M().zmin) * E.exag, M().alto / 2 - ym);
}
function aMapa(wx, wz) { return [wx + M().ancho / 2, M().alto / 2 - wz]; }

// Altura real (m) interpolada en un punto del mapa; NaN si no hay datos.
function alturaMapa(xm, ym) {
  const { nc, nf, celda } = M();
  const c = xm / celda - 0.5, r = (M().alto - ym) / celda - 0.5;
  const c0 = Math.floor(c), r0 = Math.floor(r);
  if (c0 < 0 || r0 < 0 || c0 >= nc - 1 || r0 >= nf - 1) return NaN;
  const fc = c - c0, fr = r - r0, i = r0 * nc + c0, a = E.alt;
  return (a[i] * (1 - fc) + a[i + 1] * fc) * (1 - fr) +
         (a[i + nc] * (1 - fc) + a[i + nc + 1] * fc) * fr;
}
// Altura del suelo en la escena, sobre los MISMOS triangulos que dibuja la
// malla (asi la ruta, el astronauta y la camara quedan pegados al terreno).
function sueloMundo(wx, wz) {
  const { nc, nf, celda, zmin } = M();
  const c = wx / celda + (nc - 1) / 2, r = wz / celda + (nf - 1) / 2;
  const c0 = Math.floor(c), r0 = Math.floor(r);
  if (c0 < 0 || r0 < 0 || c0 >= nc - 1 || r0 >= nf - 1) return NaN;
  const fc = c - c0, fr = r - r0, a = E.alt;
  const i = r0 * nc + c0, j = i + 1, k = i + nc, l = k + 1;
  const h = fc + fr <= 1
    ? a[i] + fc * (a[j] - a[i]) + fr * (a[k] - a[i])
    : a[l] + (1 - fc) * (a[k] - a[l]) + (1 - fr) * (a[j] - a[l]);
  return (h - zmin) * E.exag;                        // NaN si alguna esquina no tiene datos
}
function pendienteMapa(xm, ym) {
  const { nc, nf, celda } = M();
  const c = Math.round(xm / celda - 0.5), r = Math.round((M().alto - ym) / celda - 0.5);
  if (c < 0 || r < 0 || c >= nc || r >= nf) return NaN;
  return E.pendCelda[r * nc + c];
}

// ------------------------------------------------------------- terreno
let malla, colores, mini, pesoRuta;
const RAMPA = [[0, [0.22, 0.12, 0.08]], [0.35, [0.47, 0.26, 0.15]],
               [0.7, [0.71, 0.47, 0.29]], [1, [0.89, 0.75, 0.6]]];
function rampa(t, out) {
  for (let k = 1; k < RAMPA.length; k++) {
    if (t <= RAMPA[k][0] || k === RAMPA.length - 1) {
      const [t0, a] = RAMPA[k - 1], [t1, b] = RAMPA[k];
      const f = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
      for (let j = 0; j < 3; j++) out[j] = a[j] + (b[j] - a[j]) * f;
      return out;
    }
  }
}

function calcularPendientes() {
  const { nc, nf, celda } = M(), a = E.alt, p = new Float32Array(nc * nf);
  for (let r = 0; r < nf; r++) {
    for (let c = 0; c < nc; c++) {
      const i = r * nc + c;
      const l = c > 0 ? a[i - 1] : NaN, d = c < nc - 1 ? a[i + 1] : NaN;
      const u = r > 0 ? a[i - nc] : NaN, b = r < nf - 1 ? a[i + nc] : NaN;
      const gx = !isNaN(l) && !isNaN(d) ? (d - l) / (2 * celda)
               : !isNaN(d) ? (d - a[i]) / celda : !isNaN(l) ? (a[i] - l) / celda : 0;
      const gy = !isNaN(u) && !isNaN(b) ? (b - u) / (2 * celda)
               : !isNaN(b) ? (b - a[i]) / celda : !isNaN(u) ? (a[i] - u) / celda : 0;
      p[i] = isNaN(a[i]) ? NaN : Math.atan(Math.hypot(gx, gy)) * 180 / Math.PI;
    }
  }
  E.pendCelda = p;
}

function construirTerreno() {
  const { nc, nf, celda } = M(), a = E.alt, n = nc * nf;
  const pos = new Float32Array(n * 3);
  colores = new Float32Array(n * 3);
  pesoRuta = new Float32Array(n);
  for (let r = 0; r < nf; r++) {
    for (let c = 0; c < nc; c++) {
      const i = r * nc + c;
      pos[3 * i] = (c - (nc - 1) / 2) * celda;
      pos[3 * i + 2] = (r - (nf - 1) / 2) * celda;
    }
  }
  // Solo triangulos con sus 3 esquinas con datos (las zonas sin datos quedan huecas)
  const idx = [];
  for (let r = 0; r < nf - 1; r++) {
    for (let c = 0; c < nc - 1; c++) {
      const i = r * nc + c, j = i + 1, k = i + nc, l = k + 1;
      if (!isNaN(a[i]) && !isNaN(a[k]) && !isNaN(a[j])) idx.push(i, k, j);
      if (!isNaN(a[j]) && !isNaN(a[k]) && !isNaN(a[l])) idx.push(j, k, l);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colores, 3));
  geo.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
  malla = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  malla.receiveShadow = true;
  escena.add(malla);
  aplicarExageracion();
  colorear();
}

function aplicarExageracion() {
  const pos = malla.geometry.attributes.position, a = E.alt, z0 = M().zmin;
  for (let i = 0; i < a.length; i++) pos.array[3 * i + 1] = isNaN(a[i]) ? 0 : (a[i] - z0) * E.exag;
  pos.needsUpdate = true;
  malla.geometry.computeVertexNormals();
  malla.geometry.computeBoundingSphere();
  colocarMarcadores();
  dibujarRuta3D();
}

function colorear() {
  const a = E.alt, p = E.pendCelda, { zmin, zmax } = M(), rgb = [0, 0, 0];
  const rojo = [0.95, 0.16, 0.06], ambar = [0.95, 0.68, 0.2], cian = [0.25, 0.85, 0.95];
  const img = mini.base.data;
  // En la vista general la ruta se "pinta" sobre el propio terreno; durante el
  // recorrido se ve la cinta con flechas, que es mas nitida de cerca.
  const pintarRuta = E.ruta && !E.siguiendo;
  for (let i = 0; i < a.length; i++) {
    if (isNaN(a[i])) { img[4 * i + 3] = 0; continue; }
    rampa((a[i] - zmin) / (zmax - zmin), rgb);
    if (E.verProhibido) {
      const m = p[i] > E.tol ? [rojo, 0.62] : p[i] > E.tol * 0.8 ? [ambar, 0.28] : null;
      if (m) for (let j = 0; j < 3; j++) rgb[j] += (m[0][j] - rgb[j]) * m[1];
    }
    img[4 * i] = rgb[0] * 255; img[4 * i + 1] = rgb[1] * 255; img[4 * i + 2] = rgb[2] * 255;
    img[4 * i + 3] = 255;
    if (pintarRuta && pesoRuta[i] > 0) {
      for (let j = 0; j < 3; j++) rgb[j] += (cian[j] - rgb[j]) * pesoRuta[i];
    }
    colores.set(rgb, 3 * i);
  }
  malla.geometry.attributes.color.needsUpdate = true;
  mini.baseCtx.putImageData(mini.base, 0, 0);
}

function marcarCeldasRuta() {
  pesoRuta.fill(0);
  if (!E.ruta) return;
  const { nc, nf } = M();
  for (const i of E.ruta.celdas) {
    const r0 = Math.floor(i / nc), c0 = i % nc;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || c < 0 || r >= nf || c >= nc) continue;
        const w = dr === 0 && dc === 0 ? 0.8 : 0.4;
        const j = r * nc + c;
        if (w > pesoRuta[j]) pesoRuta[j] = w;
      }
    }
  }
}

// ----------------------------------------------------- marcadores y ruta
const S = () => Math.max(M().ancho, M().alto) / 100;   // escala de los pines
function crearPin(color) {
  const g = new THREE.Group(), mat = new THREE.MeshLambertMaterial({ color, emissive: color,
    emissiveIntensity: 0.35 });
  const palo = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1, 8), mat);
  palo.position.y = 0.5;
  const bola = new THREE.Mesh(new THREE.SphereGeometry(0.16, 20, 14), mat);
  bola.position.y = 1;
  g.add(palo, bola);
  g.visible = false;
  escena.add(g);
  return g;
}
let pinInicio, pinDestino, cinta, texCinta;

function colocarMarcadores() {
  for (const [pin, p] of [[pinInicio, E.inicio], [pinDestino, E.destino]]) {
    if (!p) { pin.visible = false; continue; }
    aMundo(p[0], p[1], alturaMapa(p[0], p[1]) || M().zmin, pin.position);
    // Durante el recorrido los pines se hacen pequenos para no tapar la vista
    pin.scale.setScalar(E.siguiendo ? 12 : S());
    pin.visible = true;
  }
}

// Textura de la cinta: banda translucida con bordes y flechas (sentido de avance)
function crearTexturaCinta() {
  const cv = document.createElement("canvas");
  cv.width = 64; cv.height = 64;
  const g = cv.getContext("2d");
  g.fillStyle = "rgba(79,216,232,0.18)"; g.fillRect(4, 0, 56, 64);
  g.fillStyle = "rgba(170,248,255,0.95)"; g.fillRect(4, 0, 4, 64); g.fillRect(56, 0, 4, 64);
  g.strokeStyle = "rgba(255,255,255,0.9)"; g.lineWidth = 7; g.lineCap = "round"; g.lineJoin = "round";
  g.beginPath(); g.moveTo(16, 46); g.lineTo(32, 26); g.lineTo(48, 46); g.stroke();
  const t = new THREE.CanvasTexture(cv);
  t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = renderer.capabilities.getMaxAnisotropy();
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const ANCHO_CINTA = 2.4;          // m
const PERIODO_FLECHAS = 3;        // m entre flechas
// La cinta se apoya en el terreno: cada vertice toma la altura exacta del
// triangulo del mapa que tiene debajo, con una elevacion minima para que no
// parpadee contra el suelo.
function dibujarRuta3D() {
  if (cinta) { escena.remove(cinta); cinta.geometry.dispose(); cinta = null; }
  if (!E.ruta || E.ruta.total <= 0) return;
  const total = E.ruta.total, paso = Math.max(0.75, total / 25000);
  const n = Math.floor(total / paso) + 1;
  const pos = new Float32Array(n * 3 * 3), uv = new Float32Array(n * 3 * 2);
  const idx = [], p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
  const lift = 0.08 + 0.06 * E.exag;
  for (let k = 0; k < n; k++) {
    const s = Math.min(total, k * paso);
    enRuta(s, p);
    enRuta(s - 2, a); enRuta(s + 2, b);
    let tx = b.x - a.x, tz = b.z - a.z;
    const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
    for (let j = 0; j < 3; j++) {               // izquierda, centro, derecha
      const off = (j - 1) * ANCHO_CINTA / 2;
      const x = p.x - tz * off, z = p.z + tx * off;
      const g = sueloMundo(x, z);
      const o = (k * 3 + j) * 3;
      pos[o] = x; pos[o + 1] = (Number.isNaN(g) ? p.y : g) + lift; pos[o + 2] = z;
      uv[(k * 3 + j) * 2] = j / 2; uv[(k * 3 + j) * 2 + 1] = s / PERIODO_FLECHAS;
    }
    if (k > 0) {
      for (let j = 0; j < 2; j++) {
        const i0 = (k - 1) * 3 + j, i1 = i0 + 1, i2 = k * 3 + j, i3 = i2 + 1;
        idx.push(i0, i2, i1, i1, i2, i3);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  cinta = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: texCinta, transparent: true,
    depthWrite: false, side: THREE.DoubleSide }));
  cinta.renderOrder = 1;
  escena.add(cinta);
}

// ---------------------------------------------------------- astronauta
// Hecho con piezas simples. Mira hacia +Z; mide ~1,85 m.
// Con `matUnico` todas las piezas usan ese material (lo usa el holograma).
function crearAstronauta(matUnico = null) {
  const std = (o) => matUnico ?? new THREE.MeshStandardMaterial(o);
  const traje = std({ color: 0xf2f0ea, roughness: 0.75 });
  const gris = std({ color: 0x8b8f96, roughness: 0.6, metalness: 0.3 });
  const visor = std({ color: 0x3a2508, roughness: 0.15, metalness: 0.9,
    emissive: 0xc8871e, emissiveIntensity: 0.45 });
  const rojo = std({ color: 0xc8402a, roughness: 0.6 });
  const pieza = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = !matUnico; return m;
  };
  const raiz = new THREE.Group(), cuerpo = new THREE.Group();
  raiz.add(cuerpo);

  cuerpo.add(pieza(new THREE.CapsuleGeometry(0.21, 0.36, 6, 14), traje, 0, 1.3, 0));
  cuerpo.children[0].scale.z = 0.8;
  cuerpo.add(pieza(new THREE.BoxGeometry(0.44, 0.58, 0.24), traje, 0, 1.34, -0.24));   // mochila
  cuerpo.add(pieza(new THREE.BoxGeometry(0.2, 0.13, 0.06), gris, 0, 1.3, 0.18));       // panel pecho
  cuerpo.add(pieza(new THREE.BoxGeometry(0.06, 0.04, 0.02), rojo, 0.05, 1.31, 0.215));
  cuerpo.add(pieza(new THREE.CylinderGeometry(0.008, 0.008, 0.45, 6), gris, 0.15, 1.85, -0.3)); // antena
  cuerpo.add(pieza(new THREE.SphereGeometry(0.2, 24, 16), traje, 0, 1.69, 0));          // casco
  const v = pieza(new THREE.SphereGeometry(0.17, 24, 16), visor, 0, 1.7, 0.06);
  v.scale.set(0.95, 0.75, 0.75);
  cuerpo.add(v);
  cuerpo.add(pieza(new THREE.CylinderGeometry(0.2, 0.22, 0.08, 18), gris, 0, 1.53, 0));  // cuello

  const extremidad = (x, y, r1, l1, r2, l2, final) => {
    const hombro = new THREE.Group(); hombro.position.set(x, y, 0);
    hombro.add(pieza(new THREE.CapsuleGeometry(r1, l1, 4, 10), traje, 0, -(l1 / 2 + r1 * 0.6), 0));
    const codo = new THREE.Group(); codo.position.y = -(l1 + r1 * 1.4);
    codo.add(pieza(new THREE.CapsuleGeometry(r2, l2, 4, 10), traje, 0, -(l2 / 2 + r2 * 0.5), 0));
    codo.add(final(-(l2 + r2 * 1.6)));
    hombro.add(codo);
    return { hombro, codo };
  };
  const bota = (y) => pieza(new THREE.BoxGeometry(0.15, 0.1, 0.27), gris, 0, y - 0.06, 0.04);
  const guante = (y) => pieza(new THREE.SphereGeometry(0.068, 12, 8), gris, 0, y + 0.03, 0);
  const pierI = extremidad(0.11, 0.95, 0.088, 0.3, 0.078, 0.29, bota);
  const pierD = extremidad(-0.11, 0.95, 0.088, 0.3, 0.078, 0.29, bota);
  const brazI = extremidad(0.3, 1.5, 0.07, 0.22, 0.064, 0.2, guante);
  const brazD = extremidad(-0.3, 1.5, 0.07, 0.22, 0.064, 0.2, guante);
  for (const e of [pierI, pierD, brazI, brazD]) cuerpo.add(e.hombro);
  raiz.visible = false;
  escena.add(raiz);
  return { raiz, cuerpo, pierI, pierD, brazI, brazD, fase: 0, amp: 0, rumbo: 0, pasoPrevio: 0 };
}
let astro, casco;

// Ciclo de pasos: piernas, rodillas, brazos y el brinco de baja gravedad.
function animarCaminata(A, dt, andando) {
  A.amp += ((andando ? 1 : 0) - A.amp) * (1 - Math.exp(-dt * 6));
  // A altas velocidades (camara rapida) el paso no sigue acelerando
  const vPaso = Math.min(VELOCIDADES[E.vel], 3);
  if (andando) A.fase += Math.PI * vPaso / 1.3 * dt;       // ~1,3 m por paso
  const amp = A.amp * (0.4 + 0.2 * vPaso / 3), sF = Math.sin(A.fase), cF = Math.cos(A.fase);
  A.pierI.hombro.rotation.x = -sF * amp;
  A.pierD.hombro.rotation.x = sF * amp;
  A.pierI.codo.rotation.x = A.amp * (0.1 + 0.8 * Math.max(0, cF));
  A.pierD.codo.rotation.x = A.amp * (0.1 + 0.8 * Math.max(0, -cF));
  A.brazI.hombro.rotation.x = sF * amp * 0.7;
  A.brazD.hombro.rotation.x = -sF * amp * 0.7;
  A.brazI.codo.rotation.x = A.brazD.codo.rotation.x = -0.25 - 0.2 * A.amp;
  A.brazI.hombro.rotation.z = 0.12; A.brazD.hombro.rotation.z = -0.12;
  // Brinco de baja gravedad y respiracion en reposo
  A.cuerpo.position.y = A.amp * 0.07 * Math.abs(sF) + (1 - A.amp) * 0.006 * Math.sin(E.t * 2);
  A.cuerpo.rotation.x = A.amp * 0.08;
}

function actualizarAstronauta(dt) {
  const A = astro;
  A.raiz.visible = !!E.ruta && !(E.siguiendo && E.cam === 0);
  if (!E.ruta) return;
  const p = enRuta(E.s), a = enRuta(E.s - 2), b = enRuta(E.s + 2);
  const objetivo = Math.atan2(b.x - a.x, b.z - a.z);
  let d = objetivo - A.rumbo;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  A.rumbo += d * (1 - Math.exp(-dt * 8));
  A.raiz.position.copy(p);
  A.raiz.rotation.y = A.rumbo;

  const andando = E.siguiendo && E.reproduciendo && E.s < E.ruta.total;
  animarCaminata(A, dt, andando);

  // Polvo al apoyar cada pie
  const paso = Math.floor(A.fase / Math.PI);
  if (andando && paso !== A.pasoPrevio) {
    const pie = new THREE.Vector3(paso % 2 ? -0.11 : 0.11, 0.02, 0.15);
    A.raiz.localToWorld(pie);
    emitirPolvo(pie, 10);
  }
  A.pasoPrevio = paso;

  // La luz del sol sigue al astronauta para que su sombra sea nitida
  sol.target.position.copy(p);
  sol.position.copy(p).addScaledVector(dirSol, 150);
}

// ---------------------------------------------------------- atmosfera
const dirSol = new THREE.Vector3(-1, 1.2, -1).normalize();
const C = (h) => new THREE.Color(h);
const COL = {
  horizonte: C(0xd8a27a), zenit: C(0x7d4f3c), halo: C(0x8fb0d8), tormenta: C(0xa8683c),
  polvo: C(0xc89a6a), solBajo: C(0xffc28a), solAlto: C(0xfff3e6), cieloHemi: C(0xffe8d6),
};
let cielo, niebla, motas, remolinos = [], bocanadas, escalaPuntos = 1;

function crearCielo() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSol: { value: dirSol }, uZenit: { value: new THREE.Color() },
      uHorizonte: { value: new THREE.Color() }, uHalo: { value: COL.halo.clone() },
      uPolvo: { value: 0 }, uDia: { value: 1 } },
    vertexShader: `varying vec3 vDir;
      void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `uniform vec3 uSol, uZenit, uHorizonte, uHalo; uniform float uPolvo, uDia;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 col = mix(uHorizonte, uZenit, pow(clamp(h, 0.0, 1.0), 0.45));
        float cs = max(dot(d, uSol), 0.0);
        // Halo azulado alrededor del sol (tipico del atardecer marciano)
        float bajo = 0.35 + 0.65 * (1.0 - clamp(uSol.y, 0.0, 1.0));
        col = mix(col, uHalo, pow(cs, 18.0) * bajo * (1.0 - uPolvo));
        // Disco solar, pequeno y palido; se apaga con el polvo
        float disco = pow(cs, 3000.0) * 4.0 + pow(cs, 150.0) * 0.3;
        col += vec3(1.0, 0.95, 0.85) * disco * (1.0 - 0.9 * uPolvo) * step(-0.03, uSol.y);
        col = mix(col, uHorizonte, uPolvo * 0.8);
        col = mix(uHorizonte, col, smoothstep(-0.05, 0.02, h));
        gl_FragColor = vec4(col * uDia, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false,
  });
  cielo = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), mat);
  cielo.renderOrder = -1000;
  cielo.frustumCulled = false;
  escena.add(cielo);
}

// Material de particulas (polvo): tamano en metros, transparencia por
// particula, niebla y el mismo buffer de profundidad logaritmico que el terreno.
function materialParticulas(color) {
  return new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      color: { value: color.clone() }, opacidad: { value: 1 }, escala: { value: 1 } }]),
    vertexShader: `#include <common>
      #include <fog_pars_vertex>
      #include <logdepthbuf_pars_vertex>
      attribute float alfa; attribute float tam;
      uniform float escala; varying float vAlfa;
      void main() {
        vAlfa = alfa;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = min(tam * escala / max(-mvPosition.z, 0.05), 256.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <logdepthbuf_vertex>
        #include <fog_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <fog_pars_fragment>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 color; uniform float opacidad; varying float vAlfa;
      void main() {
        #include <logdepthbuf_fragment>
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(color, smoothstep(0.5, 0.0, d) * vAlfa * opacidad);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    transparent: true, depthWrite: false, fog: true,
  });
}
function sistemaParticulas(n, color) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  geo.setAttribute("alfa", new THREE.BufferAttribute(new Float32Array(n), 1));
  geo.setAttribute("tam", new THREE.BufferAttribute(new Float32Array(n), 1));
  const pts = new THREE.Points(geo, materialParticulas(color));
  pts.frustumCulled = false;
  escena.add(pts);
  return pts;
}

// Motas de polvo flotando alrededor de la camara (solo durante el recorrido)
const CAJA = 70;
function crearMotas() {
  const n = 3000;
  motas = sistemaParticulas(n, COL.polvo);
  const p = motas.geometry.attributes.position.array, a = motas.geometry.attributes.alfa.array;
  const t = motas.geometry.attributes.tam.array;
  for (let i = 0; i < n; i++) {
    p[3 * i] = (Math.random() - 0.5) * CAJA; p[3 * i + 1] = (Math.random() - 0.3) * 30;
    p[3 * i + 2] = (Math.random() - 0.5) * CAJA;
    a[i] = 0.25 + Math.random() * 0.75; t[i] = 0.04 + Math.random() * 0.1;
  }
  motas.userData.semilla = Float32Array.from({ length: n }, () => Math.random() * 100);
}
function viento() {
  const ang = 0.6 + 0.4 * Math.sin(E.t * 0.03), v = 1.5 + 22 * E.polvo * E.polvo;
  return [Math.cos(ang) * v, Math.sin(ang) * v];
}
const envolver = (v, m) => ((v % m) + m) % m;
function actualizarMotas(dt) {
  motas.visible = E.siguiendo && E.polvo > 0.02;
  if (!motas.visible) return;
  const [vx, vz] = viento(), p = motas.geometry.attributes.position.array, sd = motas.userData.semilla;
  const c = camara.position, mitad = CAJA / 2;
  for (let i = 0; i < sd.length; i++) {
    const o = 3 * i, s = sd[i];
    p[o] += (vx + Math.sin(E.t * 0.7 + s) * 0.6) * dt;
    p[o + 1] += Math.sin(E.t * 0.5 + s * 1.3) * 0.25 * dt;
    p[o + 2] += (vz + Math.cos(E.t * 0.6 + s) * 0.6) * dt;
    // las motas se mantienen en una caja centrada en la camara
    p[o] = c.x + envolver(p[o] - c.x + mitad, CAJA) - mitad;
    p[o + 2] = c.z + envolver(p[o + 2] - c.z + mitad, CAJA) - mitad;
    p[o + 1] = c.y + envolver(p[o + 1] - c.y + 8, 30) - 8;
  }
  motas.geometry.attributes.position.needsUpdate = true;
  motas.material.uniforms.opacidad.value = 0.15 + 0.85 * E.polvo;
}

// Polvo levantado por las botas
function crearBocanadas() {
  const n = 400;
  bocanadas = sistemaParticulas(n, COL.polvo);
  bocanadas.userData = { vel: new Float32Array(n * 3), vida: new Float32Array(n), sig: 0 };
}
function emitirPolvo(pos, k) {
  const u = bocanadas.userData, p = bocanadas.geometry.attributes.position.array;
  for (let m = 0; m < k; m++) {
    const i = u.sig; u.sig = (u.sig + 1) % u.vida.length;
    const ang = Math.random() * Math.PI * 2, r = 0.3 + Math.random() * 0.9;
    p[3 * i] = pos.x; p[3 * i + 1] = pos.y; p[3 * i + 2] = pos.z;
    u.vel[3 * i] = Math.cos(ang) * r; u.vel[3 * i + 1] = 0.3 + Math.random() * 0.7;
    u.vel[3 * i + 2] = Math.sin(ang) * r;
    u.vida[i] = 1;
  }
}
function actualizarBocanadas(dt) {
  const u = bocanadas.userData, g = bocanadas.geometry.attributes;
  const p = g.position.array, a = g.alfa.array, t = g.tam.array, [vx, vz] = viento();
  for (let i = 0; i < u.vida.length; i++) {
    if (u.vida[i] <= 0) { a[i] = 0; continue; }
    u.vida[i] -= dt / 1.8;
    u.vel[3 * i + 1] -= 0.6 * dt;                    // gravedad marciana + rozamiento
    for (let j = 0; j < 3; j++) u.vel[3 * i + j] *= 1 - 1.2 * dt;
    p[3 * i] += (u.vel[3 * i] + vx * 0.15) * dt;
    p[3 * i + 1] += u.vel[3 * i + 1] * dt;
    p[3 * i + 2] += (u.vel[3 * i + 2] + vz * 0.15) * dt;
    a[i] = Math.max(0, u.vida[i]) * 0.55;
    t[i] = 0.15 + (1 - u.vida[i]) * 0.6;
  }
  g.position.needsUpdate = g.alfa.needsUpdate = g.tam.needsUpdate = true;
}

// Remolinos de polvo ("dust devils") que cruzan el paisaje
function crearRemolinos() {
  for (let k = 0; k < 3; k++) {
    const n = 900, r = sistemaParticulas(n, COL.polvo);
    r.userData = {
      u: Float32Array.from({ length: n }, () => Math.random()),
      th: Float32Array.from({ length: n }, () => Math.random() * Math.PI * 2),
      rr: Float32Array.from({ length: n }, () => 0.7 + Math.random() * 0.6),
      vida: 1, dur: 1, alto: 1, radio: 1, wx: 0, wz: 0,   // vida 1 = se coloca en el primer cuadro
    };
    remolinos.push(r);
  }
}
function reiniciarRemolino(r, centro) {
  const d = r.userData, ang = Math.random() * Math.PI * 2, dist = 250 + Math.random() * 1500;
  d.id = (d.id || 0) + 1;                       // para que Sherpa avise una vez por remolino
  d.wx = centro.x + Math.cos(ang) * dist; d.wz = centro.z + Math.sin(ang) * dist;
  d.vida = 0; d.dur = 35 + Math.random() * 50;
  d.alto = 90 + Math.random() * 220; d.radio = 4 + Math.random() * 6;
}
function actualizarRemolinos(dt) {
  const centro = E.siguiendo ? camara.position : controles.target;
  for (const r of remolinos) {
    const d = r.userData;
    r.visible = E.remolinos && E.polvo < 0.8;
    if (!r.visible) continue;
    d.vida += dt / d.dur;
    const g = sueloMundo(d.wx, d.wz);
    if (d.vida >= 1 || Number.isNaN(g)) { reiniciarRemolino(r, centro); continue; }
    const [vx, vz] = viento();
    d.wx += vx * 0.6 * dt; d.wz += vz * 0.6 * dt;
    const fade = Math.min(1, d.vida * 6, (1 - d.vida) * 6) * (1 - E.polvo);
    const ga = r.geometry.attributes, p = ga.position.array, a = ga.alfa.array, t = ga.tam.array;
    for (let i = 0; i < d.u.length; i++) {
      const u = (d.u[i] + E.t * 0.06) % 1;
      const th = d.th[i] + E.t * (3.2 - 2.2 * u);
      const rad = d.radio * (0.25 + 2.6 * Math.pow(u, 1.4)) * d.rr[i];
      const sway = Math.sin(E.t * 0.4 + u * 3) * u * d.radio * 1.5;
      p[3 * i] = d.wx + Math.cos(th) * rad + sway;
      p[3 * i + 1] = g + u * d.alto;
      p[3 * i + 2] = d.wz + Math.sin(th) * rad;
      a[i] = Math.pow(1 - u, 0.8) * 0.35 * fade;
      t[i] = 1.5 + u * 6;
    }
    ga.position.needsUpdate = ga.alfa.needsUpdate = ga.tam.needsUpdate = true;
  }
}

// Recalcula sol, luces, cielo y niebla a partir de los deslizadores
const atm = { colNiebla: new THREE.Color(), densidad: 0 };
function aplicarAtmosfera() {
  const e = THREE.MathUtils.degToRad(E.solElev), q = E.polvo;
  dirSol.set(-Math.cos(e) * Math.SQRT1_2, Math.sin(e), -Math.cos(e) * Math.SQRT1_2).normalize();
  const dia = 0.22 + 0.78 * THREE.MathUtils.smoothstep(E.solElev, -2, 18);
  const horiz = COL.horizonte.clone().lerp(COL.tormenta, q);
  const zen = COL.zenit.clone().lerp(COL.tormenta, q * 0.85);
  // Al atardecer el horizonte se oscurece y se enfria un poco
  const tarde = 1 - THREE.MathUtils.smoothstep(E.solElev, 4, 30);
  horiz.lerp(C(0x9c7a72), tarde * 0.35 * (1 - q));
  const u = cielo.material.uniforms;
  u.uHorizonte.value.copy(horiz); u.uZenit.value.copy(zen);
  u.uPolvo.value = q; u.uDia.value = dia;
  atm.colNiebla.copy(horiz).multiplyScalar(dia);
  niebla.color.copy(atm.colNiebla);
  // Visibilidad: ~8 km con aire limpio, ~250 m en plena tormenta
  atm.densidad = 6e-5 + q * q * 4e-3;

  const visible = THREE.MathUtils.smoothstep(E.solElev, -1, 10);
  sol.intensity = 2.0 * visible * (1 - 0.7 * q);
  sol.color.copy(COL.solBajo).lerp(COL.solAlto, THREE.MathUtils.smoothstep(E.solElev, 5, 40));
  hemi.intensity = (0.25 + 0.75 * dia) * (0.85 + 0.3 * q);
  hemi.color.copy(COL.cieloHemi).lerp(COL.tormenta, q * 0.6);
  sol.castShadow = q < 0.85 && visible > 0.2;

  const etiquetas = [[0.05, "Despejado"], [0.3, "Algo de polvo"], [0.55, "Calima"],
    [0.8, "Tormenta"], [1.01, "Gran tormenta"]];
  $("polvoVal").textContent = etiquetas.find(([lim]) => q < lim)[1];
  $("solVal").textContent = `${E.solElev}°`;
}

function actualizarAtmosfera(dt) {
  // En la vista general la niebla se aligera para que el mapa siga legible
  niebla.density = E.siguiendo ? atm.densidad : Math.min(atm.densidad * 0.15, 6e-5);
  if (!E.ruta) {                       // sin astronauta: el sol ilumina desde su direccion
    sol.target.position.set(0, 0, 0);
    sol.position.copy(dirSol);
  }
  cielo.position.copy(camara.position);
  cielo.scale.setScalar(camara.far * 0.5);
  actualizarMotas(dt);
  actualizarRemolinos(dt);
  actualizarBocanadas(dt);
  if (texCinta) texCinta.offset.y -= dt * 0.8;      // las flechas avanzan
}

function actualizarEscalaPuntos() {
  escalaPuntos = renderer.getDrawingBufferSize(new THREE.Vector2()).y /
    (2 * Math.tan(THREE.MathUtils.degToRad(camara.fov) / 2));
  for (const s of [motas, bocanadas, ...remolinos]) s.material.uniforms.escala.value = escalaPuntos;
}

// ---------------------------------------------------------- minimapa
function crearMinimapa() {
  const { nc, nf } = M(), escala = Math.min(230 / nc, 280 / nf);
  const cv = $("mini");
  cv.width = Math.round(nc * escala * devicePixelRatio);
  cv.height = Math.round(nf * escala * devicePixelRatio);
  cv.style.width = `${Math.round(nc * escala)}px`;
  cv.style.height = `${Math.round(nf * escala)}px`;
  const baseCv = document.createElement("canvas");
  baseCv.width = nc; baseCv.height = nf;
  const baseCtx = baseCv.getContext("2d");
  mini = { cv, ctx: cv.getContext("2d"), baseCv, baseCtx, base: baseCtx.createImageData(nc, nf) };
  cv.addEventListener("click", (ev) => {
    const b = cv.getBoundingClientRect();
    colocarPunto([(ev.clientX - b.left) / b.width * M().ancho,
                  (1 - (ev.clientY - b.top) / b.height) * M().alto]);
  });
}

function dibujarMinimapa() {
  const { cv, ctx } = mini, W = cv.width, H = cv.height;
  const px = (x) => x / M().ancho * W, py = (y) => (1 - y / M().alto) * H;
  ctx.clearRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(mini.baseCv, 0, 0, W, H);
  const k = devicePixelRatio;
  if (E.ruta) {
    ctx.strokeStyle = "#4fd8e8"; ctx.lineWidth = 2 * k; ctx.beginPath();
    E.ruta.x.forEach((x, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, px(x), py(E.ruta.y[i])));
    ctx.stroke();
  }
  for (const [p, col] of [[E.inicio, "#5be36b"], [E.destino, "#ff4d5e"]]) {
    if (!p) continue;
    ctx.fillStyle = col; ctx.strokeStyle = "#000"; ctx.lineWidth = k;
    ctx.beginPath(); ctx.arc(px(p[0]), py(p[1]), 4.5 * k, 0, 7); ctx.fill(); ctx.stroke();
  }
  // Camara: posicion y direccion de la mirada
  const [cx, cy] = aMapa(camara.position.x, camara.position.z);
  const dir = camara.getWorldDirection(new THREE.Vector3());
  const ang = Math.atan2(dir.x, -dir.z);   // 0 = norte
  ctx.save();
  ctx.translate(px(cx), py(cy)); ctx.rotate(ang);
  ctx.fillStyle = "rgba(255,255,255,0.9)"; ctx.strokeStyle = "#000"; ctx.lineWidth = k;
  ctx.beginPath(); ctx.moveTo(0, -8 * k); ctx.lineTo(5 * k, 6 * k); ctx.lineTo(0, 3 * k);
  ctx.lineTo(-5 * k, 6 * k); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------- elegir puntos
const rayo = new THREE.Raycaster();
// Marcha el rayo sobre el mapa de alturas (mucho mas rapido que intersectar
// los ~1.6 millones de triangulos). Devuelve [xm, ym] o null.
function puntoBajoCursor(clientX, clientY) {
  const ndc = new THREE.Vector2(clientX / innerWidth * 2 - 1, -clientY / innerHeight * 2 + 1);
  rayo.setFromCamera(ndc, camara);
  const o = rayo.ray.origin, d = rayo.ray.direction;
  const W = M().ancho / 2, H = M().alto / 2, Y = (M().zmax - M().zmin) * E.exag;
  let t0 = 0, t1 = Infinity;                        // recorte contra la caja del mapa
  for (const [oo, dd, lo, hi] of [[o.x, d.x, -W, W], [o.y, d.y, -1, Y + 1], [o.z, d.z, -H, H]]) {
    if (Math.abs(dd) < 1e-12) { if (oo < lo || oo > hi) return null; continue; }
    let a = (lo - oo) / dd, b = (hi - oo) / dd;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
  }
  if (t0 > t1) return null;
  // Paso fino cerca de la camara (vista a pie), mas largo a lo lejos
  const p = new THREE.Vector3();
  let tPrev = t0;
  for (let t = t0; t <= t1 + 1; ) {
    p.copy(o).addScaledVector(d, t);
    const g = sueloMundo(p.x, p.z);
    if (!Number.isNaN(g) && p.y <= g) {
      let a = tPrev, b = t;                          // biseccion para afinar
      for (let k = 0; k < 12; k++) {
        const m = (a + b) / 2; p.copy(o).addScaledVector(d, m);
        const gm = sueloMundo(p.x, p.z);
        if (!Number.isNaN(gm) && p.y <= gm) b = m; else a = m;
      }
      p.copy(o).addScaledVector(d, b);
      return aMapa(p.x, p.z);
    }
    tPrev = t;
    t += Math.min(M().celda * 0.5, Math.max(0.2, t * 0.01));
  }
  return null;
}

function fmtPunto(p) {
  return `x ${Math.round(p[0])} m, y ${Math.round(p[1])} m · ${alturaMapa(p[0], p[1]).toFixed(0)} m`;
}

function ponerModo(m) {
  E.modo = m;
  $("modoInicio").classList.toggle("activo", m === "inicio");
  $("modoDestino").classList.toggle("activo", m === "destino");
}

function colocarPunto(p) {
  if (Number.isNaN(alturaMapa(p[0], p[1]))) {
    return mostrarEstado("Ese punto está fuera del mapa o sin datos.", true);
  }
  const otro = E.modo === "inicio" ? "destino" : "inicio";
  E[E.modo] = p;
  if (!E[otro]) ponerModo(otro);               // solo avanza si falta el otro punto
  actualizarPuntos();
  pedirRuta();
}

function actualizarPuntos() {
  $("txtInicio").lastChild.textContent = `Inicio: ${E.inicio ? fmtPunto(E.inicio) : "sin elegir"}`;
  $("txtDestino").lastChild.textContent = `Destino: ${E.destino ? fmtPunto(E.destino) : "sin elegir"}`;
  colocarMarcadores();
}

// -------------------------------------------------------- pedir ruta
let temporizador = null;
function pedirRuta(retardo = 0) {
  clearTimeout(temporizador);
  temporizador = setTimeout(pedirRutaYa, retardo);
}

async function pedirRutaYa() {
  if (!E.inicio || !E.destino) return;
  const mia = ++E.peticion;
  mostrarEstado('<span class="giro"></span>Calculando ruta…', false, true);
  let res;
  try {
    const r = await fetch("/api/ruta", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inicio: E.inicio, destino: E.destino, pendiente_maxima: E.tol }) });
    res = await r.json();
  } catch (e) {
    if (mia === E.peticion) mostrarEstado("No se pudo contactar con el servidor. ¿Sigue abierto visor_rutas.py?", true);
    return;
  }
  if (mia !== E.peticion || res.cancelada) return;     // llego una peticion mas nueva
  if (!res.ok) {
    ponerRuta(null);
    return mostrarEstado(res.error, true);
  }
  ponerRuta(res);
  mostrarEstado(`Ruta con pendiente máxima de ${res.pendiente_maxima}°`);
}

// Media movil simetrica: quita el zigzag de la rejilla (8 direcciones) para
// la cinta y el astronauta, sin mover los extremos.
function suavizar(v, radio = 3, pasadas = 2) {
  let a = Float64Array.from(v);
  for (let p = 0; p < pasadas; p++) {
    const b = new Float64Array(a.length);
    for (let i = 0; i < a.length; i++) {
      const k = Math.min(radio, i, a.length - 1 - i);
      let s = 0;
      for (let j = i - k; j <= i + k; j++) s += a[j];
      b[i] = s / (2 * k + 1);
    }
    a = b;
  }
  return a;
}

function ponerRuta(res) {
  if (!res) {
    E.ruta = null;
    if (E.siguiendo) salirRecorrido();
  } else {
    const cum = [0];
    for (let i = 1; i < res.x.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(res.x[i] - res.x[i - 1], res.y[i] - res.y[i - 1],
                                       res.z[i] - res.z[i - 1]));
    }
    const { nc, celda, alto } = M();
    const celdas = res.x.map((x, i) =>
      Math.round((alto - res.y[i]) / celda - 0.5) * nc + Math.round(x / celda - 0.5));
    E.ruta = { ...res, cum, total: cum[cum.length - 1], sx: suavizar(res.x), sy: suavizar(res.y), celdas };
    E.s = Math.min(E.s, E.ruta.total);
    casco.nuevaRuta();
  }
  $("recorrer").disabled = $("csv").disabled = !E.ruta || E.ruta.total <= 0;
  marcarCeldasRuta();
  colorear();
  dibujarRuta3D();
  dibujarPerfil();
  const st = $("stats");
  st.hidden = !E.ruta;
  if (E.ruta) {
    const s = E.ruta.stats, n = (v, d = 0) => v.toLocaleString("es", { maximumFractionDigits: d,
      minimumFractionDigits: d });
    const min = s.distancia / 1.2 / 60;            // a ~1,2 m/s caminando con traje
    st.innerHTML = `
      <dt>Distancia sobre el terreno</dt><dd>${n(s.distancia)} m</dd>
      <dt>En línea recta</dt><dd>${n(s.recta)} m</dd>
      <dt>Desvío</dt><dd>+${n(s.extra_pct, 1)} %</dd>
      <dt>Subida / bajada</dt><dd>${n(s.subida)} / ${n(s.bajada)} m</dd>
      <dt>Pendiente máx. / media</dt><dd>${n(s.pend_max, 1)}° / ${n(s.pend_media, 1)}°</dd>
      <dt>A pie (~1,2 m/s)</dt><dd>${min >= 60 ? `${Math.floor(min / 60)} h ${n(min % 60)} min` : `${n(min)} min`}</dd>`;
  }
}

function mostrarEstado(html, error = false, crudo = false) {
  const el = $("estado");
  if (crudo) el.innerHTML = html; else el.textContent = html;
  el.classList.toggle("error", error);
}

function descargarCSV() {
  const r = E.ruta, filas = ["distancia_acumulada_m,x_m,y_m,altura_m"];
  r.x.forEach((x, i) => filas.push(`${r.cum[i].toFixed(1)},${x.toFixed(1)},${r.y[i].toFixed(1)},${r.z[i].toFixed(2)}`));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([filas.join("\n")], { type: "text/csv" }));
  a.download = `ruta_pend${E.tol}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// --------------------------------------------------- recorrer la ruta
// Punto de la ruta (suavizada) a una distancia s (m) del inicio, en
// coordenadas de mundo y con la altura exacta del suelo.
function enRuta(s, out = new THREE.Vector3()) {
  const r = E.ruta, n = r.cum.length;
  s = Math.min(Math.max(s, 0), r.total);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (r.cum[m] <= s) lo = m; else hi = m; }
  const seg = r.cum[hi] - r.cum[lo], f = seg > 0 ? (s - r.cum[lo]) / seg : 0;
  const xm = r.sx[lo] + (r.sx[hi] - r.sx[lo]) * f, ym = r.sy[lo] + (r.sy[hi] - r.sy[lo]) * f;
  aMundo(xm, ym, r.z[lo] + (r.z[hi] - r.z[lo]) * f, out);
  const g = sueloMundo(out.x, out.z);
  if (!Number.isNaN(g)) out.y = g;
  return out;
}
function indiceEn(s) {
  const c = E.ruta.cum; let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m] <= s) lo = m; else hi = m; }
  return lo;
}
// Direccion de avance suavizada (promedio de varios puntos por delante).
function direccionEn(s) {
  const aqui = enRuta(Math.max(0, s - 5)), suma = new THREE.Vector3(), p = new THREE.Vector3();
  for (const d of [8, 18, 30, 45]) suma.add(enRuta(s + d, p).sub(aqui));
  if (suma.lengthSq() < 1e-6) suma.copy(enRuta(E.ruta.total)).sub(enRuta(E.ruta.total - 20));
  suma.y = 0;
  return suma.lengthSq() > 0 ? suma.normalize() : new THREE.Vector3(0, 0, -1);
}

const ojoAct = new THREE.Vector3(), objAct = new THREE.Vector3();
function entrarRecorrido() {
  if (!E.ruta) return;
  E.siguiendo = true;
  E.reproduciendo = true;
  if (E.s >= E.ruta.total - 1) E.s = 0;
  E.yaw = E.pitch = 0;
  ojoAct.copy(camara.position);
  objAct.copy(controles.target);
  controles.enabled = false;
  $("hud").classList.add("visible");
  $("ayudaOrbita").hidden = true; $("ayudaRuta").hidden = false;
  $("recorrer").textContent = "■ Dejar de recorrer";
  colorear();                 // quita la ruta pintada en el terreno: se ve la cinta
  colocarMarcadores();
  dibujarPerfil();
  actualizarHUD();
  actualizarModoCasco();
}

// El casco (visor, HUD, holograma y Sherpa) solo existe en primera persona
function actualizarModoCasco() {
  const activo = E.siguiendo && E.cam === 0 && !!E.ruta;
  document.body.classList.toggle("casco", activo);
  casco.cambioModo(activo);
}

function salirRecorrido() {
  E.siguiendo = false;
  controles.target.copy(objAct);
  controles.enabled = true;
  camara.fov = 55; camara.updateProjectionMatrix(); actualizarEscalaPuntos();
  $("hud").classList.remove("visible");
  $("ayudaOrbita").hidden = false; $("ayudaRuta").hidden = true;
  $("recorrer").textContent = "▶ Recorrer ruta";
  colorear();
  colocarMarcadores();
  actualizarModoCasco();
}

const ARRIBA = new THREE.Vector3(0, 1, 0);
function camaraDeseada(ojo, obj) {
  const p = enRuta(E.s), dir = direccionEn(E.s);
  const mirar = dir.clone().applyAxisAngle(ARRIBA, E.yaw);
  const k = E.distPersec;
  if (E.cam === 0) {                       // primera persona: dentro del casco
    ojo.copy(p).y += ALTURA_OJOS + astro.amp * 0.04 * Math.abs(Math.sin(astro.fase));  // vaiven del paso
    obj.copy(ojo).addScaledVector(mirar, 25);
    const g = sueloMundo(obj.x, obj.z);
    obj.y = (Number.isNaN(g) ? p.y : g) + ALTURA_OJOS * 0.8 + Math.tan(E.pitch) * 25;
  } else {
    const [atras, arriba, mira] = E.cam === 1 ? [6, 2.6, 1.3] : [40, 45, 1];
    ojo.copy(p).addScaledVector(mirar, -atras * k);
    ojo.y += arriba * k + Math.tan(E.pitch) * atras * k;
    obj.copy(p).addScaledVector(dir, E.cam === 1 ? 2 : 0);
    obj.y = p.y + mira;
  }
  // nunca bajo el suelo
  const g = sueloMundo(ojo.x, ojo.z);
  if (!Number.isNaN(g)) ojo.y = Math.max(ojo.y, g + (E.cam === 0 ? ALTURA_OJOS * 0.9 : 0.6));
}

function actualizarHUD() {
  if (!E.ruta) return;
  const i = indiceEn(E.s), r = E.ruta;
  const pend = r.pend[Math.min(i, r.pend.length - 1)] ?? 0;
  const n = (v) => Math.round(v).toLocaleString("es");
  $("hudDatos").innerHTML = `<b>${n(E.s)}</b> / ${n(r.total)} m · altura ${n(r.z[i])} m · ` +
    `pendiente <b style="color:${pend > E.tol * 0.8 ? "var(--peligro)" : "inherit"}">${pend.toFixed(1)}°</b>`;
  $("play").textContent = E.reproduciendo ? "⏸" : "▶";
  $("camara").textContent = CAMARAS[E.cam];
  $("velEtq").textContent = `${VELOCIDADES[E.vel]} m/s`;
  dibujarCursorPerfil();
}

// --------------------------------------------------------- perfil
const perfil = $("perfil");
function dibujarPerfil() {
  const ctx = perfil.getContext("2d"), k = devicePixelRatio;
  perfil.width = perfil.clientWidth * k; perfil.height = perfil.clientHeight * k;
  perfil._img = null;
  if (!E.ruta || perfil.width === 0) return;
  const r = E.ruta, W = perfil.width, H = perfil.height;
  const zmin = Math.min(...r.z), zmax = Math.max(...r.z), rango = Math.max(1, zmax - zmin);
  const X = (s) => s / r.total * W, Y = (z) => H - 4 * k - (z - zmin) / rango * (H - 10 * k);
  ctx.clearRect(0, 0, W, H);
  ctx.beginPath(); ctx.moveTo(0, H);
  r.z.forEach((z, i) => ctx.lineTo(X(r.cum[i]), Y(z)));
  ctx.lineTo(W, H); ctx.closePath();
  ctx.fillStyle = "rgba(199,140,100,0.35)"; ctx.fill();
  // tramos empinados en naranja
  ctx.lineWidth = 2 * k;
  for (let i = 1; i < r.z.length; i++) {
    ctx.strokeStyle = r.pend[i - 1] > E.tol * 0.8 ? "#ff7a45" : "#e3b48c";
    ctx.beginPath(); ctx.moveTo(X(r.cum[i - 1]), Y(r.z[i - 1])); ctx.lineTo(X(r.cum[i]), Y(r.z[i])); ctx.stroke();
  }
  ctx.fillStyle = "#b9a596"; ctx.font = `${10 * k}px system-ui`;
  ctx.fillText(`${Math.round(zmax)} m`, 4 * k, 11 * k);
  ctx.fillText(`${Math.round(zmin)} m`, 4 * k, H - 3 * k);
  perfil._img = ctx.getImageData(0, 0, W, H);
}
function dibujarCursorPerfil() {
  if (!perfil._img || !E.ruta) return;
  const ctx = perfil.getContext("2d"), k = devicePixelRatio;
  ctx.putImageData(perfil._img, 0, 0);
  const x = E.s / E.ruta.total * perfil.width;
  ctx.strokeStyle = "#4fd8e8"; ctx.lineWidth = 2 * k;
  ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, perfil.height); ctx.stroke();
}
let arrastrandoPerfil = false;
function saltarPerfil(ev) {
  const b = perfil.getBoundingClientRect();
  E.s = Math.min(1, Math.max(0, (ev.clientX - b.left) / b.width)) * E.ruta.total;
  actualizarHUD();
}
perfil.addEventListener("pointerdown", (ev) => { arrastrandoPerfil = true; perfil.setPointerCapture(ev.pointerId); saltarPerfil(ev); });
perfil.addEventListener("pointermove", (ev) => { if (arrastrandoPerfil) saltarPerfil(ev); });
perfil.addEventListener("pointerup", () => { arrastrandoPerfil = false; });

// ------------------------------------------------------- eventos UI
let abajo = null;
lienzo.addEventListener("pointerdown", (ev) => {
  abajo = { x: ev.clientX, y: ev.clientY, boton: ev.button, yaw: E.yaw, pitch: E.pitch };
});
addEventListener("pointermove", (ev) => {
  if (abajo && E.siguiendo && abajo.boton === 0) {          // mirar alrededor
    E.yaw = abajo.yaw - (ev.clientX - abajo.x) * 0.005;
    E.pitch = Math.max(-1.2, Math.min(1.2, abajo.pitch - (ev.clientY - abajo.y) * 0.004));
  }
  if (!abajo && ev.target === lienzo) cursorPendiente = [ev.clientX, ev.clientY];
});
addEventListener("pointerup", (ev) => {
  if (abajo && abajo.boton === 0 && ev.target === lienzo &&
      Math.hypot(ev.clientX - abajo.x, ev.clientY - abajo.y) < 5) {
    const p = puntoBajoCursor(ev.clientX, ev.clientY);
    if (p) {
      if (E.siguiendo) { E.yaw = abajo.yaw; E.pitch = abajo.pitch; }
      colocarPunto(p);
    }
  }
  abajo = null;
});
lienzo.addEventListener("dblclick", () => { if (E.siguiendo) E.yaw = E.pitch = 0; });
lienzo.addEventListener("wheel", (ev) => {
  if (!E.siguiendo) return;
  if (E.cam === 0) {
    camara.fov = Math.max(20, Math.min(90, camara.fov + Math.sign(ev.deltaY) * 4));
    camara.updateProjectionMatrix();
    actualizarEscalaPuntos();
  } else {
    E.distPersec = Math.max(0.3, Math.min(15, E.distPersec * (ev.deltaY > 0 ? 1.12 : 1 / 1.12)));
  }
}, { passive: true });

// Lectura bajo el cursor (altura y pendiente), una vez por cuadro como mucho
let cursorPendiente = null;
function actualizarCursor() {
  if (!cursorPendiente) return;
  const p = puntoBajoCursor(...cursorPendiente);
  cursorPendiente = null;
  const el = $("cursor");
  if (!p) { el.textContent = ""; return; }
  const pd = pendienteMapa(p[0], p[1]);
  el.innerHTML = `${fmtPunto(p)} · pendiente <b style="color:${pd > E.tol ? "var(--peligro)" : "inherit"}">${pd.toFixed(1)}°</b>`;
}

// Que Espacio/Enter no vuelvan a "pulsar" el ultimo boton usado
document.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => b.blur()));
$("modoInicio").onclick = () => ponerModo("inicio");
$("modoDestino").onclick = () => ponerModo("destino");
$("intercambiar").onclick = () => {
  [E.inicio, E.destino] = [E.destino, E.inicio];
  actualizarPuntos(); pedirRuta();
};
let rafColor = 0;
$("pend").addEventListener("input", (ev) => {
  E.tol = +ev.target.value;
  $("pendVal").textContent = `${E.tol}°`;
  if (!rafColor) rafColor = requestAnimationFrame(() => { rafColor = 0; colorear(); dibujarPerfil(); });
  pedirRuta(350);                         // recalcula al dejar de mover el deslizador
});
$("verProhibido").onchange = (ev) => { E.verProhibido = ev.target.checked; colorear(); };
let rafExag = 0;
$("exag").addEventListener("input", (ev) => {
  E.exag = +ev.target.value;
  $("exagVal").textContent = `×${E.exag}`;
  if (!rafExag) rafExag = requestAnimationFrame(() => { rafExag = 0; aplicarExageracion(); });
});
$("polvo").addEventListener("input", (ev) => { E.polvo = ev.target.value / 100; aplicarAtmosfera(); });
$("sol").addEventListener("input", (ev) => { E.solElev = +ev.target.value; aplicarAtmosfera(); });
$("remolinos").onchange = (ev) => { E.remolinos = ev.target.checked; };
$("recorrer").onclick = () => (E.siguiendo ? salirRecorrido() : entrarRecorrido());
$("general").onclick = () => { if (E.siguiendo) salirRecorrido(); vistaGeneral(); };
$("csv").onclick = descargarCSV;
$("play").onclick = () => { E.reproduciendo = !E.reproduciendo; actualizarHUD(); };
$("camara").onclick = () => cambiarCamara();
$("salir").onclick = salirRecorrido;
$("vel").addEventListener("input", (ev) => { E.vel = +ev.target.value; actualizarHUD(); });

function cambiarCamara() {
  E.cam = (E.cam + 1) % CAMARAS.length;
  camara.fov = 55; camara.updateProjectionMatrix(); actualizarEscalaPuntos();
  actualizarHUD();
  actualizarModoCasco();
}

addEventListener("keydown", (ev) => {
  if (ev.target.tagName === "INPUT" && ev.target.type !== "checkbox" && ev.key !== "Escape") return;
  if (!E.siguiendo) {
    if ((ev.key === "r" || ev.key === "R") && E.ruta) entrarRecorrido();
    return;
  }
  const paso = ev.shiftKey ? 500 : 50;
  switch (ev.key) {
    case " ": E.reproduciendo = !E.reproduciendo; break;
    case "ArrowRight": E.s = Math.min(E.ruta.total, E.s + paso); break;
    case "ArrowLeft": E.s = Math.max(0, E.s - paso); break;
    case "ArrowUp": E.vel = Math.min(VELOCIDADES.length - 1, E.vel + 1); $("vel").value = E.vel; break;
    case "ArrowDown": E.vel = Math.max(0, E.vel - 1); $("vel").value = E.vel; break;
    case "c": case "C": cambiarCamara(); break;
    case "v": case "V": casco.alternarVoz(); break;
    case "Tab": document.body.classList.toggle("ver-panel"); break;
    case "Home": E.s = 0; break;
    case "End": E.s = E.ruta.total; break;
    case "Escape": salirRecorrido(); break;
    default: return;
  }
  ev.preventDefault();
  actualizarHUD();
});

function vistaGeneral() {
  const d = Math.max(M().ancho, M().alto);
  camara.position.set(0, d * 0.75, d * 0.6);
  controles.target.set(0, (M().zmax - M().zmin) * E.exag * 0.3, 0);
  controles.update();
}

// ------------------------------------------------------------ bucle
const reloj = new THREE.Clock();
const ojoDes = new THREE.Vector3(), objDes = new THREE.Vector3();
let hudT = 0;
function cuadro() {
  const dt = Math.min(0.1, reloj.getDelta());
  E.t += dt;
  if (E.siguiendo && E.ruta) {
    if (E.reproduciendo) {
      E.s += VELOCIDADES[E.vel] * dt;
      if (E.s >= E.ruta.total) { E.s = E.ruta.total; E.reproduciendo = false; actualizarHUD(); }
    }
  }
  if (E.ruta) actualizarAstronauta(dt); else astro.raiz.visible = false;
  if (E.siguiendo && E.ruta) {
    camaraDeseada(ojoDes, objDes);
    const a = 1 - Math.exp(-dt * (E.cam === 0 ? 12 : 5));
    ojoAct.lerp(ojoDes, a); objAct.lerp(objDes, a);
    camara.position.copy(ojoAct);
    camara.lookAt(objAct);
    if ((hudT += dt) > 0.1) { hudT = 0; actualizarHUD(); }
  } else {
    controles.update();
  }
  casco.actualizar(dt);
  actualizarAtmosfera(dt);
  actualizarCursor();
  dibujarMinimapa();
  renderer.render(escena, camara);
  requestAnimationFrame(cuadro);
}

// ------------------------------------------------------------ inicio
async function iniciar() {
  try {
    E.meta = await (await fetch("/api/terreno")).json();
    E.alt = new Float32Array(await (await fetch("/api/alturas")).arrayBuffer());
  } catch (e) {
    $("carga").textContent = "No se pudo cargar el terreno. ¿Está corriendo visor_rutas.py?";
    return;
  }
  const m = M();
  E.tol = m.pendiente_defecto;
  $("pend").min = m.pendiente_min; $("pend").max = m.pendiente_tope; $("pend").value = E.tol;
  $("pendVal").textContent = `${E.tol}°`;

  const d = Math.max(m.ancho, m.alto);
  camara.far = d * 6; camara.updateProjectionMatrix();
  niebla = new THREE.FogExp2(0xd8a27a, 1e-4);
  escena.fog = niebla;

  pinInicio = crearPin(0x5be36b);
  pinDestino = crearPin(0xff4d5e);
  texCinta = crearTexturaCinta();
  astro = crearAstronauta();
  crearCielo();
  crearMotas();
  crearBocanadas();
  crearRemolinos();
  casco = crearCasco({ THREE, E, M, $, camara, enRuta, indiceEn, aMapa, sueloMundo, remolinos,
    crearAstronauta, animarCaminata, VELOCIDADES });
  E.polvo = $("polvo").value / 100; E.solElev = +$("sol").value; E.remolinos = $("remolinos").checked;
  aplicarAtmosfera();

  calcularPendientes();
  crearMinimapa();
  construirTerreno();
  redimensionar();
  actualizarEscalaPuntos();
  vistaGeneral();
  $("vel").value = E.vel;
  $("carga").remove();
  lienzo.classList.add("colocando");
  addEventListener("resize", () => { dibujarPerfil(); actualizarEscalaPuntos(); });
  cuadro();
  desdeURL();
}

// Permite abrir el visor con una ruta lista, p. ej.
//   /?inicio=368,10646&destino=6355,1267&pendiente=15&polvo=40&sol=20&recorrer=1
async function desdeURL() {
  const q = new URLSearchParams(location.search);
  const par = (k) => q.get(k)?.split(",").map(Number);
  if (q.has("pendiente")) { E.tol = +q.get("pendiente"); $("pend").value = E.tol; $("pendVal").textContent = `${E.tol}°`; colorear(); }
  if (q.has("polvo")) { $("polvo").value = q.get("polvo"); E.polvo = q.get("polvo") / 100; }
  if (q.has("sol")) { $("sol").value = q.get("sol"); E.solElev = +q.get("sol"); }
  if (q.has("camara")) E.cam = +q.get("camara") % CAMARAS.length;
  if (q.has("s")) E.s = +q.get("s");
  aplicarAtmosfera();
  if (!par("inicio") || !par("destino")) return;
  E.inicio = par("inicio"); E.destino = par("destino"); ponerModo("destino");
  actualizarPuntos();
  await pedirRutaYa();
  if (q.get("recorrer") === "1" && E.ruta) {
    entrarRecorrido();
    camaraDeseada(ojoAct, objAct);           // empezar ya junto al astronauta
    if (q.has("pausa")) { E.reproduciendo = false; actualizarHUD(); }
  }
}
iniciar();
