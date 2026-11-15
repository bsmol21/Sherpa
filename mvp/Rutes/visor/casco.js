// Vista desde el casco (solo en primera persona):
//   - HUD proyectado en el visor: brujula, radar con la ruta, datos de la ruta
//     y del traje, proxima maniobra y avisos de pendiente.
//   - Holograma de un astronauta que camina unos metros por delante, marcando la ruta.
//   - Sherpa: mini asistente que comenta el recorrido (con voz opcional).
//   - Panel VITALES y estado de emergencia (los calcula vitales.js en E.vit).
// El marco del casco y el vidrio son HTML/CSS (ver index.html, #casco).

import { t, idioma, num, dist as fmtDist, letraRef, geoTxt, sueloTxt, polvoTxt } from "./i18n.js";

const DIST_HOLO = 12;           // m por delante del astronauta
const VEL_A_PIE = 1.2;          // m/s caminando con traje (para las estimaciones)

export function crearCasco(ctx) {
  const { THREE, E, $, camara, enRuta, indiceEn, aMapa, sueloMundo } = ctx;

  // ------------------------------------------------------- holograma
  // Normal: cian. Yendo a un refugio: amarillo y con destellos de baliza de emergencia.
  const COL_HOLO = new THREE.Color(0x6ff3ff), COL_BALIZA = new THREE.Color(0xffc81f);
  const matHolo = new THREE.ShaderMaterial({
    uniforms: { color: { value: COL_HOLO.clone() }, t: { value: 0 }, opacidad: { value: 1 }, brillo: { value: 1 } },
    vertexShader: `#include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        vY = (modelMatrix * vec4(position, 1.0)).y;
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: `#include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 color; uniform float t, opacidad, brillo;
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        #include <logdepthbuf_fragment>
        float borde = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);   // contorno brillante
        float lineas = 0.55 + 0.45 * sin(vY * 90.0 - t * 6.0);                  // lineas de barrido
        float banda = 1.0 - smoothstep(0.0, 0.04, abs(fract(vY * 0.6 - t * 0.45) - 0.5));
        float a = ((0.06 + 0.8 * borde) * lineas + banda * 0.3) * opacidad;
        gl_FragColor = vec4(color * (0.35 + 0.8 * borde) * brillo, a);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const holo = ctx.crearAstronauta(matHolo);
  const anillo = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.46, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x6ff3ff, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false }));
  anillo.position.y = 0.04;
  holo.raiz.add(anillo);

  // Baliza: luz que ilumina el terreno alrededor y un destello sobre el casco.
  // La luz existe siempre (con intensidad 0) para no recompilar los shaders.
  const luzBaliza = new THREE.PointLight(COL_BALIZA, 0, 30, 2);
  luzBaliza.position.y = 2.1;
  holo.raiz.add(luzBaliza);
  const cvD = document.createElement("canvas");
  cvD.width = cvD.height = 64;
  const gD = cvD.getContext("2d"), grad = gD.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)"); grad.addColorStop(0.25, "rgba(255,220,90,0.9)");
  grad.addColorStop(1, "rgba(255,180,0,0)");
  gD.fillStyle = grad; gD.fillRect(0, 0, 64, 64);
  const destello = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cvD),
    color: COL_BALIZA, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  destello.position.y = 2.1;
  destello.visible = false;
  holo.raiz.add(destello);

  // Doble destello cada 0,8 s, como una baliza de emergencia (0 = apagada, ~1 = destello)
  function pulsoBaliza(t) {
    const f = (t * 1.25) % 1;
    return Math.exp(-f * 22) + (f > 0.2 ? Math.exp(-(f - 0.2) * 22) : 0);
  }

  function actualizarHolo(dt) {
    holo.raiz.visible = activo;
    luzBaliza.intensity = 0;
    if (!activo) return;
    const s = Math.min(E.s + DIST_HOLO, E.ruta.total);
    const p = enRuta(s), a = enRuta(s - 1.5), b = enRuta(s + 1.5);
    let d = Math.atan2(b.x - a.x, b.z - a.z) - holo.rumbo;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    holo.rumbo += d * (1 - Math.exp(-dt * 8));
    holo.raiz.position.copy(p);
    holo.raiz.rotation.y = holo.rumbo;
    ctx.animarCaminata(holo, dt, E.reproduciendo && s < E.ruta.total);
    matHolo.uniforms.t.value = E.t;
    const emerg = !!E.rutaBase;                     // vamos (o llegamos) a un refugio
    matHolo.uniforms.color.value.copy(emerg ? COL_BALIZA : COL_HOLO);
    anillo.material.color.copy(emerg ? COL_BALIZA : COL_HOLO);
    if (emerg) {
      // Baliza: parpadea mientras vamos al refugio; al llegar queda fija
      const b = E.vit?.enRefugio ? 0.35 : pulsoBaliza(E.t);
      matHolo.uniforms.opacidad.value = 0.5 + 0.7 * b;
      matHolo.uniforms.brillo.value = 0.8 + 1.8 * b;
      luzBaliza.intensity = 60 * b;
      destello.visible = true;
      destello.material.opacity = Math.min(1, b);
      destello.scale.setScalar(0.5 + 1.3 * b);
      anillo.material.opacity = 0.35 + 0.6 * b;
      anillo.scale.setScalar(1 + 0.5 * b);
      return;
    }
    destello.visible = false;
    matHolo.uniforms.brillo.value = 1;
    anillo.material.opacity = 0.55;
    // parpadeo de proyeccion, con algun "fallo" ocasional
    const glitch = Math.sin(E.t * 1.7) > 0.985 ? 0.35 : 1;
    matHolo.uniforms.opacidad.value = (0.85 + 0.15 * Math.sin(E.t * 23) * Math.sin(E.t * 7.3)) * glitch;
    anillo.scale.setScalar(1 + 0.12 * Math.sin(E.t * 4));
  }

  // ------------------------------------------------------- utilidades
  const ang = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  // Rumbo de la ruta en s: 0 = norte, en sentido horario (radianes)
  function rumboRuta(s) {
    const a = enRuta(s - 8), b = enRuta(s + 8);
    return Math.atan2(b.x - a.x, -(b.z - a.z));
  }
  function rumboCamara() {
    const d = camara.getWorldDirection(new THREE.Vector3());
    return Math.atan2(d.x, -d.z);
  }
  const fmtTiempo = (m) => {
    const min = m / VEL_A_PIE / 60;
    return min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`;
  };
  const relativo = (rad) => {
    const g = ang(rad) * 180 / Math.PI;
    const R = t("relativo");
    return Math.abs(g) < 35 ? R.delante : Math.abs(g) > 145 ? R.detras : g > 0 ? R.der : R.izq;
  };

  // Primer giro claro en los proximos 300 m
  function proximoGiro() {
    const h0 = rumboRuta(E.s);
    for (let d = 20; d <= 300 && E.s + d < E.ruta.total - 5; d += 10) {
      const dif = ang(rumboRuta(E.s + d) - h0);
      if (Math.abs(dif) > 0.5) return { d, dif };
    }
    return null;
  }
  // Primer tramo empinado (> 80 % del limite) en los proximos 200 m
  function proximaPendiente() {
    const r = E.ruta;
    for (let i = indiceEn(E.s); i < r.pend.length && r.cum[i] < E.s + 200; i++) {
      if (r.pend[i] > E.tol * 0.8) {
        let max = r.pend[i];
        for (let j = i; j < Math.min(r.pend.length, i + 15); j++) max = Math.max(max, r.pend[j]);
        return { d: Math.max(0, r.cum[i] - E.s), pend: max, i };
      }
    }
    return null;
  }
  const traje = () => {
    const elev = E.solElev * Math.PI / 180;
    return { temp: Math.round(-85 + 65 * Math.sin(elev) - 6 * E.polvo) };
  };

  // ------------------------------------------------------- Sherpa
  const sh = { cola: [], txt: "", pos: 0, espera: 0, vistos: new Set(), voz: false, urg: false };
  const urgentes = new WeakSet();
  const shPanel = $("hcSherpa"), shTxt = $("hcSherpaTxt");
  function decir(texto, clave, urgente = false) {
    if (clave) { if (sh.vistos.has(clave)) return; sh.vistos.add(clave); }
    const m = new String(texto);
    if (urgente) {
      urgentes.add(m);
      sh.cola.unshift(m);
      if (sh.txt && !sh.urg) sh.txt = "";               // un aviso urgente corta un comentario normal
    } else sh.cola.push(m);
    if (sh.cola.length > 4) sh.cola.length = 4;          // que no se acumule
  }
  // --- Voz
  // Habla en el idioma elegido en el menu de inicio (es / en). Se elige la voz
  // mas natural que tenga el navegador para ese idioma. Las "Multilingual"
  // (voces neuronales de Edge/Windows) leen espanol e ingles con el MISMO
  // locutor y acento, y pronuncian bien los nombres en el otro idioma; suelen
  // servir para los dos, asi la voz de Sherpa no cambia al cambiar de idioma.
  // Despues van las neuronales del idioma ("Natural"/"Online" en Edge,
  // "Google" en Chrome) y por ultimo cualquier voz de ese idioma.
  let vozElegida = null;
  const LOCALES = { es: ["es-es", "es-mx", "es-us"], en: ["en-us", "en-gb"] };
  function puntuarVoz(v) {
    const n = v.name.toLowerCase(), l = v.lang.toLowerCase(), multi = n.includes("multilingual");
    const len = idioma();
    if (!l.startsWith(len) && !multi) return -1;
    let p = 0;
    if (multi) p += 60;
    if (/natural|neural|online/.test(n)) p += 40;
    else if (n.includes("google")) p += 25;
    if (l.startsWith(len)) p += 30;
    if (LOCALES[len].includes(l)) p += 3;
    if (/desktop|espeak/.test(n)) p -= 20;        // voces sinteticas antiguas, muy roboticas
    return p;
  }
  function elegirVoz() {
    if (!("speechSynthesis" in window)) return;
    let mejor = null, pm = -1;
    for (const v of speechSynthesis.getVoices()) {
      const p = puntuarVoz(v);
      if (p > pm) { pm = p; mejor = v; }
    }
    vozElegida = mejor;
    const b = $("hcVoz");
    if (b) b.title = `${t("tVoz")}${mejor ? ` · ${mejor.name}` : ""}`;
  }
  if ("speechSynthesis" in window) {
    elegirVoz();
    speechSynthesis.addEventListener?.("voiceschanged", elegirVoz);   // Chrome las carga tarde
  }

  // El texto del HUD usa abreviaturas; para la voz se escriben como se dicen.
  const HABLA = {
    es: { km: ["kilómetro", "kilómetros"], m: ["metro", "metros"], min: ["minuto", "minutos"],
      h: ["hora", "horas"], mSv: ["milisievert", "milisieverts"],
      lpm: ["pulsación por minuto", "pulsaciones por minuto"], bpm: ["pulsación por minuto", "pulsaciones por minuto"],
      masDe: "más de", menos: "menos", grados: "grados", pct: "por ciento", spo2: "saturación de oxígeno" },
    en: { km: ["kilometer", "kilometers"], m: ["meter", "meters"], min: ["minute", "minutes"],
      h: ["hour", "hours"], mSv: ["millisievert", "millisieverts"],
      lpm: ["beat per minute", "beats per minute"], bpm: ["beat per minute", "beats per minute"],
      masDe: "more than", menos: "minus", grados: "degrees", pct: "percent", spo2: "oxygen saturation" },
  };
  function paraVoz(texto) {
    const H = HABLA[idioma()];
    let s = texto;
    if (idioma() === "es") s = s.replace(/(\d)\.(\d{1,2})(?!\d)/g, "$1,$2");   // 37.5 -> 37,5 (no toca miles como 3.400)
    return s
      .replace(/>\s*(\d)/g, `${H.masDe} $1`)
      .replace(/(^|[\s(])-(\d)/g, `$1${H.menos} $2`)
      .replace(/(\d+(?:[.,]\d+)?)\s?(km|min|mSv|lpm|bpm|m|h)(?![\wáéíóúñ])/g,
        (_, n, u) => `${n} ${H[u][n === "1" ? 0 : 1]}`)
      .replace(/\s?°C/g, ` ${H.grados}`).replace(/\s?°/g, ` ${H.grados}`)
      .replace(/\s?%/g, ` ${H.pct}`)
      .replace(/SpO₂/g, H.spo2)
      .replace(/[·▍]/g, ",");
  }

  function hablar(texto) {
    if (!sh.voz || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    if (!vozElegida) elegirVoz();
    // Una frase por enunciado: suena con pausas naturales y evita que Chrome
    // corte los textos largos a los ~15 s.
    const frases = paraVoz(texto).split(/(?<=[.!?:])\s+/);
    for (const f of frases) {
      if (!f.trim()) continue;
      const u = new SpeechSynthesisUtterance(f.trim());
      // a una voz multilingue de otro idioma se le indica el idioma del texto
      const loc = idioma() === "en" ? "en-US" : "es-ES";
      if (vozElegida) { u.voice = vozElegida; u.lang = vozElegida.lang.toLowerCase().startsWith(idioma()) ? vozElegida.lang : loc; }
      else u.lang = loc;
      u.rate = 1; u.pitch = 1;                      // valores neutros: lo mas natural en voces neuronales
      speechSynthesis.speak(u);
    }
  }
  function actualizarSherpa(dt) {
    if (!sh.txt && sh.cola.length && activo) {
      const m = sh.cola.shift();
      sh.txt = String(m); sh.urg = urgentes.has(m); sh.pos = 0; sh.espera = 0;
      shPanel.classList.add("hablando");
      hablar(sh.txt);
    }
    if (!sh.txt) return;
    if (sh.pos < sh.txt.length) {
      sh.pos = Math.min(sh.txt.length, sh.pos + dt * 45);
      shTxt.textContent = sh.txt.slice(0, Math.floor(sh.pos)) + "▍";
    } else {
      shTxt.textContent = sh.txt;
      sh.espera += dt;
      if (sh.espera > 3.5 + sh.txt.length / 22) {
        sh.txt = "";
        shPanel.classList.remove("hablando");
        shTxt.innerHTML = `<span class="tenue">${t("enLinea")}</span>`;
      }
    }
  }

  // Geologia (solo si el visor tiene la capa geologica; si no, no hace nada).
  // Sherpa dice sobre que unidad caminas y avisa al cruzar a otra. Solo habla
  // cuando Sherpa esta callado y sin nada en cola: asi no tapa los avisos de
  // ruta y de riesgo, y la unidad que nombra es la de ese mismo momento.
  const PAUSA_INFO = 20;          // s minimos entre dos comentarios informativos (geologia, suelo)
  const geo = { dicho: null };
  const info = { t: -Infinity };
  const libreParaInfo = () => !sh.txt && !sh.cola.length && E.t - info.t >= PAUSA_INFO;
  function unidadAqui() {
    if (!ctx.unidadGeo) return null;
    const p = enRuta(E.s);
    return ctx.unidadGeo(...aMapa(p.x, p.z));
  }
  function vigilarGeologia() {
    const u = unidadAqui();
    if (!u || u.id === geo.dicho || !libreParaInfo()) return;
    const g = geoTxt(u);
    decir(geo.dicho === null ? t("shGeo", g.nombre, g.edad) : t("shGeoCambio", g.nombre, g.edad, g.interes));
    geo.dicho = u.id; info.t = E.t;
  }

  // Suelo (inercia termica) y polvo superficial: solo si el visor tiene la capa.
  //  - Advertencia si hay material fino suelto en los proximos 100 m de ruta.
  //  - Informativo (cuando Sherpa esta libre): resumen del suelo y del polvo al
  //    empezar, y aviso al pisar suelo rocoso o cementado.
  function sueloAqui() {
    if (!ctx.sueloEn) return null;
    const p = enRuta(E.s);
    return ctx.sueloEn(...aMapa(p.x, p.z));
  }
  function sueloSueltoAdelante() {
    if (!ctx.sueloEn) return null;
    const r = E.ruta;
    for (let i = indiceEn(E.s); i < r.x.length && r.cum[i] < E.s + 100; i++) {
      const su = ctx.sueloEn(r.x[i], r.y[i]);
      if (su && su.clase.riesgo === "alto") return { d: Math.max(0, r.cum[i] - E.s), i, su };
    }
    return null;
  }
  const sue = { resumen: false, clave: null };
  function vigilarSuelo() {
    const suelto = sueloSueltoAdelante();
    if (suelto) {
      const n = sueloTxt(suelto.su.clase).nombre;
      decir(suelto.d < 10 ? t("shSueltoAqui", n) : t("shSuelto", n, fmtDist(suelto.d)),
        `suelto${Math.floor(suelto.i / 15)}`);
    }
    const su = sueloAqui();
    if (!su || !libreParaInfo()) return;
    if (!sue.resumen) {
      const p = E.suelo?.polvo;
      const pt = p && polvoTxt(p);
      decir(t("shSuelo", sueloTxt(su.clase).nombre) + (pt ? t("shPolvoSup", pt.nivel, pt.texto) : ""));
      sue.resumen = true; info.t = E.t;
      return;
    }
    if (su.clase.clave === "roca") {
      const clave = `roca${Math.floor(E.s / 300)}`;
      if (clave === sue.clave || sh.vistos.has(clave)) return;
      decir(t("shRoca", sueloTxt(su.clase).nombre), clave);
      sue.clave = clave; info.t = E.t;
    }
  }

  // Sucesos que comenta Sherpa (se revisan 10 veces por segundo)
  let polvoAvisado = false;
  function vigilar(giro, cuesta, tj) {
    const r = E.ruta, total = r.total, falta = total - E.s;
    decir(t("shHola", fmtDist(total), fmtTiempo(total)), "hola");
    vigilarGeologia();
    vigilarSuelo();
    const aRefugio = E.vit && (E.vit.emergencia || E.vit.enRefugio);
    if (falta <= 1 && !aRefugio) return decir(t("shFin"), "fin", true);
    if (falta < 150) decir(t("shCasi", !!aRefugio, fmtDist(falta)), "casi");
    for (const h of [25, 50, 75]) {
      if (E.s >= total * h / 100 && E.s < total * h / 100 + 300) {
        decir(h === 50 ? t("shMitad", fmtDist(falta), fmtTiempo(falta)) : t("shHito", h, fmtDist(falta)), `hito${h}`);
      }
    }
    if (giro && giro.d <= 120) {
      decir(t("shGiro", fmtDist(giro.d), giro.dif > 0),
        `giro${Math.round((E.s + giro.d) / 60)}`);
    }
    if (cuesta && cuesta.d <= 150) {
      decir(t("shCuesta", cuesta.pend.toFixed(0), fmtDist(cuesta.d)),
        `pend${Math.floor(cuesta.i / 20)}`, true);
    }
    if (E.polvo > 0.6 && !polvoAvisado) {
      polvoAvisado = true;
      decir(t("shTormentaVis"), null, true);
    } else if (E.polvo < 0.4) polvoAvisado = false;
    if (E.solElev < 8) decir(t("shSolBajo", tj.temp), "sol");
    // Remolinos de polvo cercanos
    for (const rem of ctx.remolinos) {
      const u = rem.userData;
      if (!rem.visible || u.vida > 0.85 || u.vida < 0.1) continue;
      const dx = u.wx - camara.position.x, dz = u.wz - camara.position.z, dist = Math.hypot(dx, dz);
      if (dist < 500) {
        const rumbo = Math.atan2(dx, -dz);
        decir(t("shRemolino", fmtDist(dist), relativo(rumbo - rumboCamara())),
          `rem${ctx.remolinos.indexOf(rem)}-${u.id}`);
      }
    }
  }

  // ------------------------------------------------------- HUD
  const brujula = $("hcBrujula"), radar = $("hcRadar");
  function ajustarLienzo(cv) {
    const k = devicePixelRatio;
    const w = Math.round(cv.clientWidth * k), h = Math.round(cv.clientHeight * k);
    if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
    return k;
  }
  const HOLO = "#6ff3ff", AVISO = "#ffb36b", VERDE = "#7cffb2", AMARILLO = "#ffd23f";
  const colorRuta = () => E.rutaBase ? AMARILLO : HOLO;     // ruta de emergencia en amarillo
  // Refugio que importa ahora: al que vamos, el propuesto o el mejor
  const refugioFoco = () => {
    const V = E.vit;
    if (!V || !E.refugios) return null;
    return V.emergencia ?? V.enRefugio ?? V.propuesta?.ref ?? V.mejor?.ref ?? null;
  };

  function dibujarBrujula(rumbo) {
    const k = ajustarLienzo(brujula), g = brujula.getContext("2d"), W = brujula.width, H = brujula.height;
    g.clearRect(0, 0, W, H);
    const hd = rumbo * 180 / Math.PI, ppg = W / 110;                 // pixeles por grado
    const xDe = (deg) => W / 2 + ang((deg - hd) * Math.PI / 180) * 180 / Math.PI * ppg;
    g.strokeStyle = HOLO; g.fillStyle = HOLO; g.lineWidth = k;
    g.shadowColor = HOLO; g.shadowBlur = 6 * k;
    g.font = `${11 * k}px Consolas, ui-monospace, monospace`; g.textAlign = "center";
    const nombres = t("puntos");
    for (let deg = 0; deg < 360; deg += 5) {
      const x = xDe(deg);
      if (x < 0 || x > W) continue;
      const fuerte = deg % 45 === 0;
      g.globalAlpha = 1 - Math.abs(x - W / 2) / (W / 2) * 0.8;
      g.beginPath(); g.moveTo(x, H * 0.55); g.lineTo(x, H * (fuerte ? 0.25 : deg % 15 === 0 ? 0.38 : 0.46)); g.stroke();
      if (fuerte) g.fillText(nombres[deg], x, H * 0.2);
    }
    g.globalAlpha = 1;
    // Marcas: hacia donde va la ruta (cian) y donde esta el destino (rojo)
    const marca = (rad, color, rombo) => {
      const x = xDe(rad * 180 / Math.PI);
      if (x < 6 * k || x > W - 6 * k) return;
      g.fillStyle = color; g.shadowColor = color; g.beginPath();
      if (rombo) { g.moveTo(x, H * 0.6); g.lineTo(x + 5 * k, H * 0.75); g.lineTo(x, H * 0.9); g.lineTo(x - 5 * k, H * 0.75); }
      else { g.moveTo(x, H * 0.6); g.lineTo(x + 6 * k, H * 0.9); g.lineTo(x - 6 * k, H * 0.9); }
      g.fill();
    };
    const pa = enRuta(E.s), pb = enRuta(Math.min(E.ruta.total, E.s + 40));
    marca(Math.atan2(pb.x - pa.x, -(pb.z - pa.z)), colorRuta(), false);
    const [xm, ym] = aMapa(pa.x, pa.z);
    const dest = E.vit?.emergencia ? null : E.destino;
    if (dest) marca(Math.atan2(dest[0] - xm, dest[1] - ym), "#ff6b7a", true);
    const rf = refugioFoco();
    if (rf) marca(Math.atan2(rf.x - xm, rf.y - ym), VERDE, true);
    // Rumbo actual
    g.fillStyle = HOLO; g.shadowColor = HOLO;
    g.fillRect(W / 2 - k, H * 0.5, 2 * k, H * 0.5);
    g.font = `bold ${10 * k}px Consolas, ui-monospace, monospace`;
    g.fillText(`${String(Math.round((hd + 360) % 360)).padStart(3, "0")}°`, W / 2 + 22 * k, H * 0.98);
  }

  function dibujarRadar(rumbo) {
    const k = ajustarLienzo(radar), g = radar.getContext("2d"), W = radar.width, R = W / 2 - 4 * k;
    const cx = W / 2, cy = W / 2, ALCANCE = 250;                       // metros al borde
    const esc = R / ALCANCE, r = E.ruta;
    const p = enRuta(E.s), [px, py] = aMapa(p.x, p.z);
    const cs = Math.cos(rumbo), sn = Math.sin(rumbo);
    const aPant = (x, y) => {                        // rumbo hacia arriba
      const dx = x - px, dy = y - py;
      return [cx + (dx * cs - dy * sn) * esc, cy - (dx * sn + dy * cs) * esc];
    };
    g.clearRect(0, 0, W, W);
    g.save();
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.clip();
    g.fillStyle = "rgba(0, 45, 55, 0.28)"; g.fillRect(0, 0, W, W);
    g.strokeStyle = "rgba(111,243,255,0.25)"; g.lineWidth = k;
    for (const m of [100, 200]) { g.beginPath(); g.arc(cx, cy, m * esc, 0, Math.PI * 2); g.stroke(); }
    // Ruta: recorrida tenue, por delante brillante, tramos empinados en naranja
    const i0 = indiceEn(E.s), desde = Math.max(0, i0 - 40), hasta = Math.min(r.x.length - 1, i0 + 60);
    g.lineWidth = 3 * k; g.lineCap = "round"; g.shadowBlur = 6 * k;
    for (let i = desde; i < hasta; i++) {
      const [x1, y1] = aPant(r.sx[i], r.sy[i]), [x2, y2] = aPant(r.sx[i + 1], r.sy[i + 1]);
      const empinado = r.pend[i] > E.tol * 0.8;
      g.strokeStyle = g.shadowColor = empinado ? AVISO : colorRuta();
      g.globalAlpha = i < i0 ? 0.3 : 1;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    g.globalAlpha = 1;
    // Holograma
    const ph = enRuta(Math.min(r.total, E.s + DIST_HOLO)), [hx, hy] = aPant(...aMapa(ph.x, ph.z));
    g.fillStyle = colorRuta(); g.beginPath(); g.arc(hx, hy, 3 * k, 0, Math.PI * 2); g.fill();
    g.restore();
    // Refugios (verde): dentro del radar o en el borde con su direccion
    const foco = refugioFoco();
    for (const rf of E.refugios || []) {
      let [rx, ry] = aPant(rf.x, rf.y);
      const rd = Math.hypot(rx - cx, ry - cy);
      if (rd > R - 6 * k) {
        if (rf !== foco) continue;                    // fuera del radar solo se marca el importante
        rx = cx + (rx - cx) / rd * (R - 6 * k); ry = cy + (ry - cy) / rd * (R - 6 * k);
      }
      const l = (rf === foco ? 5 : 3.5) * k;
      g.fillStyle = g.shadowColor = VERDE; g.shadowBlur = 6 * k;
      g.fillRect(rx - l, ry - l, 2 * l, 2 * l);
    }
    // Destino: dentro del radar o en el borde con su direccion
    let [dx, dy] = aPant(E.destino[0], E.destino[1]);
    const dd = Math.hypot(dx - cx, dy - cy);
    if (dd > R - 6 * k) { dx = cx + (dx - cx) / dd * (R - 6 * k); dy = cy + (dy - cy) / dd * (R - 6 * k); }
    g.fillStyle = "#ff6b7a"; g.shadowColor = "#ff6b7a"; g.shadowBlur = 6 * k;
    g.beginPath(); g.arc(dx, dy, 4 * k, 0, Math.PI * 2); g.fill();
    // Borde y jugador
    g.strokeStyle = HOLO; g.shadowColor = HOLO; g.lineWidth = 1.5 * k;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.stroke();
    g.fillStyle = "#fff";
    g.beginPath(); g.moveTo(cx, cy - 8 * k); g.lineTo(cx + 5 * k, cy + 6 * k); g.lineTo(cx, cy + 3 * k);
    g.lineTo(cx - 5 * k, cy + 6 * k); g.closePath(); g.fill();
    g.shadowBlur = 0; g.fillStyle = HOLO; g.globalAlpha = 0.7;
    g.font = `${9 * k}px Consolas, ui-monospace, monospace`; g.textAlign = "left";
    g.fillText("250 m", cx + 4 * k, cy - R + 12 * k);
    g.globalAlpha = 1;
  }

  const barra = (v, aviso) => `<div class="barra${aviso ? " aviso" : ""}"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></div>`;
  function escribirDatos(giro, cuesta, tj) {
    const r = E.ruta, falta = Math.max(0, r.total - E.s), i = indiceEn(E.s);
    const pend = r.pend[Math.min(i, r.pend.length - 1)] ?? 0;
    const ug = unidadAqui(), su = sueloAqui();
    $("hcRuta").innerHTML = `<h3>${t("hRuta")}</h3>
      <div class="fila-hc"><span>${t("hRecorrido")}</span><b>${fmtDist(E.s)}</b></div>
      ${barra(E.s / r.total * 100)}
      <div class="fila-hc"><span>${t("hRestante")}</span><b>${fmtDist(falta)}</b></div>
      <div class="fila-hc"><span>${t("hPie")}</span><b>${fmtTiempo(falta)}</b></div>
      <div class="fila-hc"><span>${t("hAltitud")}</span><b>${Math.round(r.z[i])} m</b></div>
      <div class="fila-hc"><span>${t("hPend")}</span><b class="${pend > E.tol * 0.8 ? "aviso" : ""}">${num(pend, 1)}° / ${E.tol}°</b></div>
      ${barra(pend / E.tol * 100, pend > E.tol * 0.8)}
      ${ug ? `<div class="fila-hc"><span>${t("hGeo")}</span><b>${ug.codigo}</b></div>` : ""}
      ${su ? `<div class="fila-hc"><span>${t("hSuelo")}</span><b class="${su.clase.riesgo === "alto" ? "aviso" : ""}">${sueloTxt(su.clase).nombre.split(" ")[0]} · ${Math.round(su.ti)}</b></div>` : ""}`;
    escribirVitales(tj);
    // Proxima maniobra
    let flecha = "↑", texto = falta < 2 ? t("destinoAlcanzado") : t("sigue", fmtDist(Math.min(falta, 300)));
    let giroDeg = 0;
    if (falta < 2) flecha = "◎";
    else if (giro) {
      giroDeg = Math.max(-90, Math.min(90, giro.dif * 180 / Math.PI));
      texto = t("gira", giro.dif > 0, fmtDist(giro.d));
    }
    $("hcFlecha").textContent = flecha;
    $("hcFlecha").style.transform = `rotate(${giroDeg}deg)`;
    $("hcManiobra").textContent = texto;
    $("hcAviso").textContent = cuesta ? t("avisoPend", cuesta.pend.toFixed(0), fmtDist(cuesta.d)) : "";
  }

  // Panel VITALES (a la derecha) y franja de estado de emergencia
  function escribirVitales(tj) {
    const V = E.vit, el = $("hcTraje"), est = $("hcEstado");
    if (!V || !E.refugios) {                          // sin refugios: solo el entorno
      el.innerHTML = `<h3>${t("hEntorno")}</h3>
        <div class="fila-hc"><span>${t("hTempExt")}</span><b>${tj.temp} °C</b></div>
        <div class="fila-hc"><span>${t("hPolvo")}</span><b class="${E.polvo > 0.6 ? "aviso" : ""}">${Math.round(E.polvo * 100)} %</b></div>`;
      est.textContent = ""; est.className = "";
      return;
    }
    const fila = (n, v, aviso) => `<div class="fila-hc"><span>${n}</span><b class="${aviso ? "aviso" : ""}">${v}</b></div>`;
    const fm = (m) => !isFinite(m) || m > 600 ? "> 10 h" : m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)}` : `${Math.round(m)} min`;
    const seguroAviso = V.mejor ? V.seguro - V.mejor.eta < 25 : isFinite(V.seguro);
    el.innerHTML = `<h3>${t("hVitales")}</h3>
      ${fila(t("hPulso"), `${Math.round(V.fc)} ${t("lpm")}`, V.fc > 148)}
      ${barra((V.fc - 50) / 140 * 100, V.fc > 148)}
      ${fila(t("hEsfuerzo"), `${Math.round(V.met)} W`, V.intensidad > 0.7)}
      ${fila(t("hTempCorp"), `${num(V.tc, 1)} °C`, V.tc > 38.3 || V.tc < 36)}
      ${fila("SpO₂", `${Math.round(V.spo2)} %`, V.spo2 < 92)}
      ${fila(t("hFatiga"), `${Math.round(V.fatiga)} %`, V.fatiga > 70)}
      ${barra(V.fatiga, V.fatiga > 70)}
      ${fila(t("hDosis"), `${num(V.dosis, 2)} mSv`, V.dosis > 10)}
      ${fila(t("hTempExt"), `${tj.temp} °C`, false)}
      ${fila(t("hPolvo"), `${Math.round(E.polvo * 100)} %`, E.polvo > 0.6)}
      <div class="sep-hc"></div>
      ${fila(t("hSeguro"), fm(V.seguro), seguroAviso)}
      ${V.limita ? `<div class="tenue chico">${t("limita", t("limites")[V.limita])}</div>` : ""}
      ${V.emergencia ? fila(t("hVasAl"), `${letraRef(V.emergencia)} · ${fm((E.ruta.total - E.s) / VEL_A_PIE / 60)}`, true)
        : V.enRefugio ? fila(t("hRefugio"), `${letraRef(V.enRefugio)} · ${t("aSalvo")}`, false)
        : fila(t("hRefugio"), V.mejor ? `${letraRef(V.mejor.ref)} · ${fm(V.mejor.eta)}` : "—", !V.mejor)}
      ${V.tormenta ? fila(t("hTormenta"), V.tTormenta <= 0 ? t("encima") : fm(V.tTormenta), V.tTormenta < 30) : ""}`;
    const nom = t("estNivel")[V.nivel] ?? "";
    let txt = nom ? `${nom} · ${V.causa}` : "";
    if (V.emergencia) txt = t("estEmergencia", V.emergencia) + (V.causa ? ` · ${V.causa}` : "");
    else if (V.enRefugio) txt = t("estSalvo", V.enRefugio);
    else if (V.propuesta) txt += t("estPropuesta", V.propuesta.ref, fm(V.propuesta.eta));
    est.textContent = txt;
    est.className = V.enRefugio ? "ok" : V.emergencia ? "critico" : V.nivel;
  }

  // ------------------------------------------------------- ciclo
  let activo = false, reloj = 0;
  function actualizar(dt) {
    activo = E.siguiendo && E.cam === 0 && !!E.ruta && !!E.destino;
    actualizarHolo(dt);
    actualizarSherpa(dt);
    if (!activo) return;
    const rumbo = rumboCamara();
    dibujarBrujula(rumbo);
    dibujarRadar(rumbo);
    if ((reloj += dt) < 0.1) return;
    reloj = 0;
    const giro = proximoGiro(), cuesta = proximaPendiente(), tj = traje();
    escribirDatos(giro, cuesta, tj);
    vigilar(giro, cuesta, tj);
  }

  function alternarVoz() {
    sh.voz = !sh.voz;
    $("hcVoz").textContent = t(sh.voz ? "vozSi" : "vozNo");
    if (!sh.voz && "speechSynthesis" in window) speechSynthesis.cancel();
    else if (sh.txt) hablar(sh.txt);
  }
  $("hcVoz").addEventListener("click", (ev) => { alternarVoz(); ev.currentTarget.blur(); });

  return {
    actualizar,
    alternarVoz,
    decir,
    // Idioma nuevo: Sherpa calla lo pendiente (estaba en el otro idioma),
    // elige voz para el idioma nuevo y el casco se redibuja en el siguiente cuadro
    cambioIdioma() {
      sh.cola.length = 0; sh.txt = "";
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      shPanel.classList.remove("hablando");
      shTxt.innerHTML = `<span class="tenue">${t("enLinea")}</span>`;
      $("hcVoz").textContent = t(sh.voz ? "vozSi" : "vozNo");
      elegirVoz();
      reloj = 1;
    },
    cambioModo(on) {
      if (!on && "speechSynthesis" in window) speechSynthesis.cancel();
      reloj = 1;                                  // refrescar datos en el siguiente cuadro
    },
    nuevaRuta(emergencia = false) {               // ruta nueva: se olvidan los avisos anteriores
      const yaSaludo = sh.vistos.has("hola");
      sh.vistos.clear();
      if (!emergencia) sh.cola.length = 0;        // en emergencia se conserva el aviso que la explica
      if (yaSaludo || emergencia) sh.vistos.add("hola");
      if (yaSaludo && !emergencia) {
        sh.vistos.add("hola");
        decir(t("shRecalculada", fmtDist(E.ruta.total), E.tol), null, true);
      }
    },
  };
}
