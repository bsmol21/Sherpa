// Modelo 3D de cada refugio: una base humana y una Starship aterrizada.
//   Base: esclusa (la puerta esta justo en el punto del refugio, donde
//   terminan las rutas), cupula habitable, dos modulos, paneles solares,
//   antena con baliza y una bandera de la NASA junto a la puerta.
//   Starship: casco de acero, escudo termico, aletas, motores, seis patas
//   y la marca de quemado del aterrizaje en el suelo.
// Todo va a escala real (metros) y apoyado en el terreno: la cupula tiene una
// plataforma nivelada con zocalo hasta el suelo, y cada pata (de modulos,
// esclusa, paneles y nave) mide lo que haga falta para llegar al suelo que
// tiene debajo. La orientacion de la base y el sitio de la nave se eligen
// buscando el terreno mas llano alrededor del refugio.
// Se reconstruye al cambiar la exageracion vertical (el suelo cambia de altura).

export function crearBases(ctx) {
  const { THREE, escena, sueloMundo } = ctx;
  const Y = new THREE.Vector3(0, 1, 0);
  const raiz = new THREE.Group();
  escena.add(raiz);

  // ------------------------------------------------------------ materiales
  const std = (o) => new THREE.MeshStandardMaterial(o);
  const M = {
    blanco: std({ color: 0xe9e6df, roughness: 0.6, metalness: 0.05 }),
    naranja: std({ color: 0xd8642a, roughness: 0.55 }),
    gris: std({ color: 0x8d9097, roughness: 0.5, metalness: 0.5 }),
    oscuro: std({ color: 0x2b2d31, roughness: 0.6, metalness: 0.4 }),
    regolito: std({ color: 0x8a6f5a, roughness: 0.95 }),        // plataforma de regolito sinterizado
    ventana: std({ color: 0x201810, emissive: 0xffc98a, emissiveIntensity: 0.9, roughness: 0.2 }),
    luzVerde: std({ color: 0x103018, emissive: 0x5dff8a, emissiveIntensity: 1.2 }),
    luzRoja: std({ color: 0x300808, emissive: 0xff3a2a, emissiveIntensity: 1 }),
    // un metal sin nada que reflejar sale negro: refleja un cielo marciano simple
    acero: std({ color: 0xd8dbe0, roughness: 0.3, metalness: 0.8, envMap: entornoMarte(), envMapIntensity: 1.1 }),
    losetas: std({ color: 0x17181b, roughness: 0.85, metalness: 0.1 }),
    motor: std({ color: 0x3a3634, roughness: 0.45, metalness: 0.8, side: THREE.DoubleSide }),
    panel: std({ color: 0xffffff, map: texturaPanel(), roughness: 0.3, metalness: 0.4 }),
    bandera: std({ map: texturaBandera(), roughness: 0.8, side: THREE.DoubleSide }),
  };
  const matQuemado = new THREE.MeshBasicMaterial({ map: texturaQuemado(), transparent: true,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 });

  // ------------------------------------------------------------ texturas
  function lienzo(w, h) {
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    return [cv, cv.getContext("2d")];
  }
  function tex(cv) {
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  // Bandera de la NASA: insignia "meatball" (circulo azul, estrellas, orbita,
  // vector rojo y letras NASA) sobre fondo blanco. Dibujada a mano: es una
  // aproximacion del logotipo, no el archivo oficial.
  function texturaBandera() {
    const [cv, g] = lienzo(384, 256);
    g.fillStyle = "#f5f5f2"; g.fillRect(0, 0, 384, 256);
    const cx = 192, cy = 128, R = 104;
    g.fillStyle = "#0b3d91"; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
    // estrellas (posiciones fijas dentro del circulo)
    g.fillStyle = "#fff";
    let s = 7;
    const azar = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let k = 0; k < 34; k++) {
      const a = azar() * Math.PI * 2, r = Math.sqrt(azar()) * R * 0.9;
      g.beginPath(); g.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0.8 + azar() * 1.6, 0, Math.PI * 2); g.fill();
    }
    // orbita blanca
    g.save(); g.translate(cx + 6, cy + 4); g.rotate(-0.42);
    g.strokeStyle = "#fff"; g.lineWidth = 4;
    g.beginPath(); g.ellipse(0, 0, R * 0.98, R * 0.33, 0, 0, Math.PI * 2); g.stroke();
    g.restore();
    // vector rojo: ala que cruza el circulo y sale por la derecha arriba
    g.fillStyle = "#fc3d21";
    g.beginPath();
    g.moveTo(cx - R * 0.95, cy + R * 0.62);
    g.quadraticCurveTo(cx - R * 0.15, cy + R * 0.02, cx + R * 1.32, cy - R * 0.62);
    g.quadraticCurveTo(cx + R * 0.25, cy - R * 0.02, cx - R * 0.05, cy + R * 0.42);
    g.lineTo(cx - R * 0.12, cy + R * 0.3);
    g.quadraticCurveTo(cx - R * 0.5, cy + R * 0.42, cx - R * 0.95, cy + R * 0.62);
    g.fill();
    // letras
    g.fillStyle = "#fff"; g.font = "italic bold 60px Arial, Helvetica, sans-serif";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("NASA", cx, cy + 4);
    return tex(cv);
  }
  // Entorno para reflejos: cielo claro arriba, horizonte polvoriento y suelo rojizo
  function entornoMarte() {
    const [cv, g] = lienzo(64, 32);
    const gr = g.createLinearGradient(0, 0, 0, 32);
    gr.addColorStop(0, "#d9b89a"); gr.addColorStop(0.45, "#f0cfae");
    gr.addColorStop(0.55, "#9a6a4c"); gr.addColorStop(1, "#5a3a28");
    g.fillStyle = gr; g.fillRect(0, 0, 64, 32);
    const t = tex(cv);
    t.mapping = THREE.EquirectangularReflectionMapping;
    return t;
  }
  function texturaPanel() {
    const [cv, g] = lienzo(128, 64);
    g.fillStyle = "#16264d"; g.fillRect(0, 0, 128, 64);
    g.strokeStyle = "#6f86b8"; g.lineWidth = 1;
    for (let x = 0; x <= 128; x += 16) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 64); g.stroke(); }
    for (let y = 0; y <= 64; y += 16) { g.beginPath(); g.moveTo(0, y); g.lineTo(128, y); g.stroke(); }
    g.strokeStyle = "#c9ccd2"; g.lineWidth = 4; g.strokeRect(0, 0, 128, 64);
    return tex(cv);
  }
  function texturaQuemado() {
    const [cv, g] = lienzo(128, 128);
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    gr.addColorStop(0, "rgba(18,10,6,0.85)"); gr.addColorStop(0.35, "rgba(35,20,12,0.6)");
    gr.addColorStop(1, "rgba(60,35,20,0)");
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    return tex(cv);
  }

  // ------------------------------------------------------------ utilidades
  // Sistema local: origen (x0, z0) en el mundo, eje l a lo largo de `ang`,
  // eje w perpendicular. Dentro del grupo, (x, y, z) local = (l, altura, w).
  function sistema(x0, z0, ang, h0) {
    const g = new THREE.Group();
    g.position.set(x0, 0, z0);
    g.rotation.y = -ang;
    const ux = Math.cos(ang), uz = Math.sin(ang);
    const xz = (l, w) => [x0 + ux * l - uz * w, z0 + uz * l + ux * w];
    const suelo = (l, w) => { const h = sueloMundo(...xz(l, w)); return Number.isNaN(h) ? h0 : h; };
    // alturas minima y maxima del suelo en un circulo
    const rango = (l, w, r) => {
      let lo = Infinity, hi = -Infinity;
      for (const [a, f] of [[0, 0], ...Array.from({ length: 16 }, (_, k) => [k / 16 * Math.PI * 2, k % 2 ? 0.55 : 1])]) {
        const h = suelo(l + Math.cos(a) * r * f, w + Math.sin(a) * r * f);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      return { lo, hi };
    };
    return { g, xz, suelo, rango };
  }
  function malla(g, geo, mat, x = 0, y = 0, z = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = m.receiveShadow = true;
    g.add(m);
    return m;
  }
  // Cilindro entre dos puntos (patas, postes, tuneles)
  function tubo(g, a, b, r, mat, seg = 10) {
    const d = new THREE.Vector3().subVectors(b, a), L = d.length();
    const m = malla(g, new THREE.CylinderGeometry(r, r, L, seg), mat);
    m.position.copy(a).addScaledVector(d, 0.5);
    m.quaternion.setFromUnitVectors(Y, d.normalize());
    return m;
  }
  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  // Pata con zapata: desde un punto de la estructura hasta el suelo que tiene debajo
  function pata(S, l, w, y, r, mat, abrir = 0) {
    const lp = l * (1 + abrir), wp = w * (1 + abrir), h = S.suelo(lp, wp);
    tubo(S.g, V(l, y, w), V(lp, h, wp), r, mat);
    malla(S.g, new THREE.CylinderGeometry(r * 2.2, r * 2.6, 0.18, 12), mat, lp, h + 0.09, wp);
  }

  // ------------------------------------------------------------ base humana
  const D_CUPULA = 10, R_CUPULA = 6;
  function costeOrientacion(S) {
    const c = S.rango(D_CUPULA, 0, R_CUPULA + 1);
    const m1 = S.rango(D_CUPULA, 10.8, 4), m2 = S.rango(D_CUPULA, -10.8, 4);
    return (c.hi - c.lo) * 2 + (m1.hi - m1.lo) + (m2.hi - m2.lo);
  }

  function construirBase(P, h0) {
    // Orientacion con el terreno mas llano para la cupula y los modulos
    let mejor = null;
    for (let k = 0; k < 16; k++) {
      const ang = k / 16 * Math.PI * 2, S = sistema(P.x, P.z, ang, h0), c = costeOrientacion(S);
      if (!mejor || c < mejor.c) mejor = { ang, c };
    }
    const S = sistema(P.x, P.z, mejor.ang, h0), g = S.g;
    const anim = { banderas: [], balizas: [] };

    // --- Cupula sobre plataforma nivelada (con zocalo hasta el punto mas bajo)
    const rc = S.rango(D_CUPULA, 0, R_CUPULA + 0.8);
    const top = rc.hi + 0.4, alto = top - (rc.lo - 1);
    malla(g, new THREE.CylinderGeometry(R_CUPULA + 0.8, R_CUPULA + 1.1, alto, 40), M.regolito, D_CUPULA, top - alto / 2, 0);
    malla(g, new THREE.CylinderGeometry(R_CUPULA, R_CUPULA, 1.8, 40), M.blanco, D_CUPULA, top + 0.9, 0);
    malla(g, new THREE.CylinderGeometry(R_CUPULA + 0.03, R_CUPULA + 0.03, 0.35, 40, 1, true), M.ventana, D_CUPULA, top + 1.2, 0);
    const cup = malla(g, new THREE.SphereGeometry(R_CUPULA, 40, 16, 0, Math.PI * 2, 0, Math.PI / 2), M.blanco, D_CUPULA, top + 1.8, 0);
    cup.scale.y = 0.72;
    malla(g, new THREE.TorusGeometry(R_CUPULA + 0.02, 0.12, 8, 48).rotateX(Math.PI / 2), M.naranja, D_CUPULA, top + 1.82, 0);
    malla(g, new THREE.CylinderGeometry(0.9, 1.1, 0.5, 20), M.gris, D_CUPULA, top + 1.8 + R_CUPULA * 0.72, 0);
    // luces del borde de la plataforma
    for (let k = 0; k < 8; k++) {
      const a = k / 8 * Math.PI * 2 + 0.2;
      malla(g, new THREE.SphereGeometry(0.12, 8, 6), M.ventana,
        D_CUPULA + Math.cos(a) * (R_CUPULA + 0.6), top + 0.12, Math.sin(a) * (R_CUPULA + 0.6));
    }

    // --- Esclusa: la puerta queda en el punto del refugio (l = 0)
    const yE = top + 1.3, L0 = 0.6, L1 = D_CUPULA - R_CUPULA + 0.3;
    malla(g, new THREE.CylinderGeometry(1.3, 1.3, L1 - L0, 24).rotateZ(Math.PI / 2), M.blanco, (L0 + L1) / 2, yE, 0);
    malla(g, new THREE.CylinderGeometry(1.36, 1.36, 0.25, 24).rotateZ(Math.PI / 2), M.naranja, L0 + 0.5, yE, 0);
    malla(g, new THREE.CylinderGeometry(1.4, 1.4, 0.3, 24).rotateZ(Math.PI / 2), M.gris, L0, yE, 0);
    malla(g, new THREE.BoxGeometry(0.12, 1.9, 1.1), M.oscuro, L0 - 0.2, yE - 0.15, 0);       // puerta
    const luzPuerta = malla(g, new THREE.SphereGeometry(0.1, 8, 6), M.luzVerde, L0 - 0.2, yE + 1.0, 0);
    anim.balizas.push({ m: luzPuerta, tipo: "puerta" });
    for (const l of [L0 + 0.6, L1 - 0.6]) for (const w of [-0.9, 0.9]) pata(S, l, w, yE - 1.1, 0.09, M.gris);
    // rampa desde la puerta hasta el suelo
    const yPie = yE - 1.25, lR = -2.6, hR = S.suelo(lR, 0);
    const dl = L0 - 0.3 - lR, dy = yPie - hR;
    const rampa = malla(g, new THREE.BoxGeometry(Math.hypot(dl, dy), 0.14, 1.3), M.gris, (L0 - 0.3 + lR) / 2, (yPie + hR) / 2, 0);
    rampa.rotation.z = Math.atan2(dy, dl);

    // --- Dos modulos a los lados de la cupula, sobre patas
    for (const lado of [1, -1]) {
      const wc = lado * (R_CUPULA + 4.8), rm = S.rango(D_CUPULA, wc, 4.2);
      const yM = Math.max(top, rm.hi + 0.6) + 2.0;
      malla(g, new THREE.CylinderGeometry(2, 2, 7.2, 28).rotateX(Math.PI / 2), M.blanco, D_CUPULA, yM, wc);
      for (const e of [-1, 1]) {
        const tapa = malla(g, new THREE.SphereGeometry(2, 24, 12), M.blanco, D_CUPULA, yM, wc + e * 3.6);
        tapa.scale.z = 0.35;
        malla(g, new THREE.CylinderGeometry(2.05, 2.05, 0.3, 28).rotateX(Math.PI / 2), M.naranja, D_CUPULA, yM, wc + e * 2.6);
      }
      for (let k = -1; k <= 1; k++) {                                    // ventanillas
        malla(g, new THREE.BoxGeometry(0.1, 0.45, 0.7), M.ventana, D_CUPULA - 1.99, yM + 0.5, wc + k * 1.4);
      }
      // tunel hasta la cupula
      tubo(g, V(D_CUPULA, top + 1.2, lado * (R_CUPULA - 0.3)), V(D_CUPULA, yM - 0.3, lado * (R_CUPULA + 1.4)), 1.0, M.gris, 16);
      for (const dw of [-2.6, 2.6]) for (const dl of [-1.3, 1.3]) pata(S, D_CUPULA + dl, wc + dw, yM - 1.5, 0.11, M.gris, 0.0);
      if (lado < 0) {                                                    // radiador sobre el laboratorio
        tubo(g, V(D_CUPULA, yM + 1.9, wc), V(D_CUPULA, yM + 2.6, wc), 0.08, M.gris);
        malla(g, new THREE.BoxGeometry(3.2, 0.06, 5.5), M.blanco, D_CUPULA, yM + 2.65, wc);
      }
    }

    // --- Paneles solares detras de la cupula, cada uno con su poste
    for (const w of [-7, 0, 7]) {
      const l = D_CUPULA + R_CUPULA + 8, h = S.suelo(l, w);
      tubo(g, V(l, h, w), V(l, h + 2.2, w), 0.1, M.gris);
      const p = malla(g, new THREE.BoxGeometry(2.8, 0.08, 5.2), M.panel, l, h + 2.3, w);
      p.rotation.z = -0.45;                                              // inclinados hacia el cielo
    }

    // --- Antena con baliza roja
    {
      const l = D_CUPULA + 3, w = -(R_CUPULA + 9), h = S.suelo(l, w);
      tubo(g, V(l, h, w), V(l, h + 9, w), 0.13, M.gris);
      for (const a of [0, 2.1, 4.2]) tubo(g, V(l, h + 6, w), V(l + Math.cos(a) * 2.5, S.suelo(l + Math.cos(a) * 2.5, w + Math.sin(a) * 2.5), w + Math.sin(a) * 2.5), 0.03, M.gris, 5);
      const plato = malla(g, new THREE.SphereGeometry(1.3, 20, 8, 0, Math.PI * 2, 0, 0.9), M.blanco, l, h + 7.4, w);
      plato.rotation.z = Math.PI * 0.75;
      const roja = malla(g, new THREE.SphereGeometry(0.16, 8, 6), M.luzRoja.clone(), l, h + 9.15, w);
      anim.balizas.push({ m: roja, tipo: "antena" });
    }

    // --- Bandera de la NASA junto a la puerta
    {
      const l = -1.6, w = -2.6, h = S.suelo(l, w), alto = 3.6;
      tubo(g, V(l, h - 0.3, w), V(l, h + alto, w), 0.04, M.gris, 8);
      malla(g, new THREE.SphereGeometry(0.07, 8, 6), M.gris, l, h + alto + 0.05, w);
      tubo(g, V(l, h + alto - 0.05, w), V(l, h + alto - 0.05, w - 1.85), 0.02, M.gris, 6);   // varilla superior
      // La tela se extiende hacia -w desde el mastil y mira hacia -l: se lee de
      // frente al llegar a la puerta.
      const geo = new THREE.PlaneGeometry(1.8, 1.2, 14, 8);
      geo.translate(-0.9, 0, 0);                                        // borde del mastil en x = 0
      geo.rotateY(-Math.PI / 2);
      malla(g, geo, M.bandera, l, h + alto - 0.65, w);
      anim.banderas.push({ geo, base: Float32Array.from(geo.attributes.position.array), fase: P.x * 0.01 });
    }
    raiz.add(g);
    return { anim, ang: mejor.ang, cupula: S.xz(D_CUPULA, 0) };
  }

  // ------------------------------------------------------------ Starship
  const R_NAVE = 4.5;
  function construirNave(P, h0, angBase, semilla) {
    // Sitio mas llano a 55-80 m, lejos de la cupula y de los paneles
    let mejor = null;
    const S0 = sistema(P.x, P.z, 0, h0);
    for (const dist of [55, 65, 80]) {
      for (let k = 0; k < 24; k++) {
        const a = k / 24 * Math.PI * 2;
        const dif = Math.atan2(Math.sin(a - angBase), Math.cos(a - angBase));
        if (Math.abs(dif) < 1.0) continue;                               // no encima de la base
        const l = Math.cos(a) * dist, w = Math.sin(a) * dist;
        const r = S0.rango(l, w, 7);
        const c = r.hi - r.lo + dist * 0.01;
        if (!mejor || c < mejor.c) mejor = { c, l, w };
      }
    }
    const [x, z] = S0.xz(mejor.l, mejor.w);
    // El escudo termico (lado negro, eje +l local) mira hacia fuera: desde la
    // base se ve el acero
    const S = sistema(x, z, Math.atan2(mejor.w, mejor.l) + (semilla % 3 - 1) * 0.3, h0), g = S.g;

    // Patas: el casco queda vertical y nivelado; cada pata llega a su suelo
    const pies = Array.from({ length: 6 }, (_, k) => {
      const a = k / 6 * Math.PI * 2 + Math.PI / 6;
      return [Math.cos(a) * 6.4, Math.sin(a) * 6.4];
    });
    const rc = S.rango(0, 0, R_NAVE);
    const yB = Math.max(rc.hi, ...pies.map(([l, w]) => S.suelo(l, w))) + 2.6;
    for (const [l, w] of pies) {
      const h = S.suelo(l, w);
      tubo(g, V(l * 0.66, yB + 2.2, w * 0.66), V(l, h + 0.2, w), 0.32, M.gris, 8);
      tubo(g, V(l * 0.66, yB + 0.2, w * 0.66), V(l * 0.92, h + 0.9, w * 0.92), 0.16, M.gris, 6);
      malla(g, new THREE.CylinderGeometry(0.9, 1.0, 0.3, 14), M.gris, l, h + 0.15, w);
    }
    // Casco, escudo termico (medio lado negro) y morro ojival
    const ALTO = 35, MORRO = 15;
    malla(g, new THREE.CylinderGeometry(R_NAVE, R_NAVE, ALTO, 48), M.acero, 0, yB + ALTO / 2, 0);
    malla(g, new THREE.CylinderGeometry(R_NAVE + 0.04, R_NAVE + 0.04, ALTO, 48, 1, true, 0, Math.PI), M.losetas, 0, yB + ALTO / 2, 0);
    const perfil = Array.from({ length: 18 }, (_, i) => {
      const t = i / 17;
      return new THREE.Vector2(R_NAVE * Math.pow(1 - t * t, 0.6), t * MORRO);
    });
    malla(g, new THREE.LatheGeometry(perfil, 48), M.acero, 0, yB + ALTO, 0);
    const negro = malla(g, new THREE.LatheGeometry(perfil.map((p) => new THREE.Vector2(p.x * 1.01, p.y)), 48, 0, Math.PI),
      M.losetas, 0, yB + ALTO, 0);
    negro.scale.y = 0.99;
    // Aletas: dos traseras grandes y dos delanteras junto al morro
    for (const e of [-1, 1]) {
      const a = malla(g, new THREE.BoxGeometry(0.35, 10, 4.2), M.losetas, 0, yB + 6, e * (R_NAVE + 2));
      a.rotation.x = e * 0.04;
      malla(g, new THREE.BoxGeometry(0.3, 6, 2.6), M.losetas, 0, yB + ALTO + 3, e * (R_NAVE + 0.9));
    }
    // Ventanillas de la cubierta de tripulacion (lado de acero)
    for (let k = -2; k <= 2; k++) {
      const a = -Math.PI / 2 + k * 0.17, y = yB + ALTO - 4;
      const v = malla(g, new THREE.BoxGeometry(0.1, 0.55, 0.55), M.ventana, Math.sin(a) * (R_NAVE + 0.02), y, Math.cos(a) * (R_NAVE + 0.02));
      v.rotation.y = a;
    }
    // Faldon y motores
    malla(g, new THREE.CylinderGeometry(R_NAVE, R_NAVE * 0.95, 0.4, 48), M.oscuro, 0, yB + 0.2, 0);
    const tobera = new THREE.LatheGeometry(Array.from({ length: 8 }, (_, i) => {
      const t = i / 7;
      return new THREE.Vector2(0.55 + 0.75 * Math.pow(t, 0.7), -t * 2.1);
    }), 24);
    for (const [l, w] of [[1.3, 0], [-0.65, 1.13], [-0.65, -1.13]]) malla(g, tobera, M.motor, l, yB + 0.1, w);
    // Marca de quemado del aterrizaje, pegada al suelo
    g.add(discoQuemado(S, 18));
    raiz.add(g);
  }

  function discoQuemado(S, R) {
    const anillos = 8, seg = 36, pos = [], uv = [], idx = [];
    const lift = ctx.lift();
    for (let i = 0; i <= anillos; i++) {
      const r = R * i / anillos;
      for (let j = 0; j < seg; j++) {
        const a = j / seg * Math.PI * 2, l = Math.cos(a) * r, w = Math.sin(a) * r;
        pos.push(l, S.suelo(l, w) + lift, w);
        uv.push(0.5 + l / (2 * R), 0.5 + w / (2 * R));
        if (i > 0) {
          const a0 = (i - 1) * seg + j, a1 = (i - 1) * seg + (j + 1) % seg, b0 = i * seg + j, b1 = i * seg + (j + 1) % seg;
          idx.push(a0, b0, a1, a1, b0, b1);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    const m = new THREE.Mesh(geo, matQuemado);
    m.receiveShadow = true;
    m.renderOrder = 1;
    return m;
  }

  // ------------------------------------------------------------ API
  let anims = [], exagHecha = null;
  function limpiar() {
    raiz.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
    raiz.clear();
    anims = [];
  }
  function construir(refugios, forzar = false) {
    const exag = ctx.exag();
    if (!refugios || (!forzar && exag === exagHecha)) return;
    exagHecha = exag;
    limpiar();
    refugios.forEach((r, k) => {
      const P = ctx.aMundoXZ(r.x, r.y);
      const h0 = sueloMundo(P.x, P.z);
      const base = construirBase(P, Number.isNaN(h0) ? 0 : h0);
      construirNave(P, Number.isNaN(h0) ? 0 : h0, base.ang, r.id ?? k);
      anims.push(base.anim);
    });
  }
  function actualizar(t) {
    for (const a of anims) {
      for (const b of a.banderas) {                        // ondea suave (aire marciano muy fino)
        const p = b.geo.attributes.position.array, o = b.base;
        for (let i = 0; i < p.length; i += 3) {
          const d = -o[i + 2];                               // distancia al mastil (0..1,8)
          p[i] = o[i] + Math.sin(d * 2.6 - t * 2.2 + b.fase) * 0.07 * d;
        }
        b.geo.attributes.position.needsUpdate = true;
        b.geo.computeVertexNormals();
      }
      for (const b of a.balizas) {
        b.m.material.emissiveIntensity = b.tipo === "antena"
          ? ((t * 0.8) % 1 < 0.12 ? 3 : 0.15) : 1 + 0.4 * Math.sin(t * 3);
      }
    }
  }
  return { construir, actualizar };
}
