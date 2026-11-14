// Vista desde el casco (solo en primera persona):
//   - HUD proyectado en el visor: brujula, radar con la ruta, datos de la ruta
//     y del traje, proxima maniobra y avisos de pendiente.
//   - Holograma de un astronauta que camina unos metros por delante, marcando la ruta.
//   - Sherpa: mini asistente que comenta el recorrido (con voz opcional).
// El marco del casco y el vidrio son HTML/CSS (ver index.html, #casco).

const DIST_HOLO = 12;           // m por delante del astronauta
const VEL_A_PIE = 1.2;          // m/s caminando con traje (para las estimaciones)
const AUTONOMIA_O2_H = 8;       // horas de oxigeno con el traje lleno
const AUTONOMIA_BAT_H = 10;

export function crearCasco(ctx) {
  const { THREE, E, $, camara, enRuta, indiceEn, aMapa, sueloMundo } = ctx;

  // ------------------------------------------------------- holograma
  const matHolo = new THREE.ShaderMaterial({
    uniforms: { color: { value: new THREE.Color(0x6ff3ff) }, t: { value: 0 }, opacidad: { value: 1 } },
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
      uniform vec3 color; uniform float t, opacidad;
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        #include <logdepthbuf_fragment>
        float borde = pow(1.0 - abs(dot(normalize(vN), normalize(vV))), 2.0);   // contorno brillante
        float lineas = 0.55 + 0.45 * sin(vY * 90.0 - t * 6.0);                  // lineas de barrido
        float banda = 1.0 - smoothstep(0.0, 0.04, abs(fract(vY * 0.6 - t * 0.45) - 0.5));
        float a = ((0.06 + 0.8 * borde) * lineas + banda * 0.3) * opacidad;
        gl_FragColor = vec4(color * (0.35 + 0.8 * borde), a);
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

  function actualizarHolo(dt) {
    holo.raiz.visible = activo;
    if (!activo) return;
    const s = Math.min(E.s + DIST_HOLO, E.ruta.total);
    const p = enRuta(s), a = enRuta(s - 1.5), b = enRuta(s + 1.5);
    let d = Math.atan2(b.x - a.x, b.z - a.z) - holo.rumbo;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    holo.rumbo += d * (1 - Math.exp(-dt * 8));
    holo.raiz.position.copy(p);
    holo.raiz.rotation.y = holo.rumbo;
    ctx.animarCaminata(holo, dt, E.reproduciendo && s < E.ruta.total);
    // parpadeo de proyeccion, con algun "fallo" ocasional
    const glitch = Math.sin(E.t * 1.7) > 0.985 ? 0.35 : 1;
    matHolo.uniforms.t.value = E.t;
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
  const fmtDist = (m) => m < 1000 ? `${Math.max(0, Math.round(m / 10) * 10)} m`
    : `${(m / 1000).toFixed(1).replace(".", ",")} km`;
  const fmtTiempo = (m) => {
    const min = m / VEL_A_PIE / 60;
    return min >= 60 ? `${Math.floor(min / 60)} h ${Math.round(min % 60)} min` : `${Math.round(min)} min`;
  };
  const relativo = (rad) => {
    const g = ang(rad) * 180 / Math.PI;
    return Math.abs(g) < 35 ? "delante de ti" : Math.abs(g) > 145 ? "detrás de ti"
      : g > 0 ? "a tu derecha" : "a tu izquierda";
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
    const horas = E.s / VEL_A_PIE / 3600;
    const elev = E.solElev * Math.PI / 180;
    return {
      o2: Math.max(0, 100 - horas / AUTONOMIA_O2_H * 100),
      bat: Math.max(0, 100 - horas / AUTONOMIA_BAT_H * 100),
      temp: Math.round(-85 + 65 * Math.sin(elev) - 6 * E.polvo),
    };
  };

  // ------------------------------------------------------- Sherpa
  const sh = { cola: [], txt: "", pos: 0, espera: 0, vistos: new Set(), voz: false };
  const shPanel = $("hcSherpa"), shTxt = $("hcSherpaTxt");
  function decir(texto, clave, urgente = false) {
    if (clave) { if (sh.vistos.has(clave)) return; sh.vistos.add(clave); }
    if (urgente) sh.cola.unshift(texto); else sh.cola.push(texto);
    if (sh.cola.length > 4) sh.cola.length = 4;          // que no se acumule
  }
  function hablar(texto) {
    if (!sh.voz || !("speechSynthesis" in window)) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = "es-ES"; u.rate = 1.05; u.pitch = 1.05;
    const voz = speechSynthesis.getVoices().find((v) => v.lang.startsWith("es"));
    if (voz) u.voice = voz;
    speechSynthesis.speak(u);
  }
  function actualizarSherpa(dt) {
    if (!sh.txt && sh.cola.length && activo) {
      sh.txt = sh.cola.shift(); sh.pos = 0; sh.espera = 0;
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
        shTxt.innerHTML = '<span class="tenue">En línea · siguiendo la ruta</span>';
      }
    }
  }

  // Sucesos que comenta Sherpa (se revisan 10 veces por segundo)
  let polvoAvisado = false;
  function vigilar(giro, cuesta, t) {
    const r = E.ruta, total = r.total, falta = total - E.s;
    decir(`Hola, soy Sherpa. Te guiaré por ${fmtDist(total)} de ruta, unas ${fmtTiempo(total)} a pie. ` +
      "Sigue al holograma.", "hola");
    if (falta <= 1) return decir("Has llegado al destino. Buen trabajo.", "fin", true);
    if (falta < 150) decir(`El destino está a ${fmtDist(falta)}.`, "casi");
    for (const h of [25, 50, 75]) {
      if (E.s >= total * h / 100 && E.s < total * h / 100 + 300) {
        decir(h === 50 ? `Mitad del camino. Quedan ${fmtDist(falta)}, unas ${fmtTiempo(falta)}.`
          : `Llevas el ${h} %. Quedan ${fmtDist(falta)}.`, `hito${h}`);
      }
    }
    if (giro && giro.d <= 120) {
      decir(`En ${fmtDist(giro.d)} gira ${giro.dif > 0 ? "a la derecha" : "a la izquierda"}.`,
        `giro${Math.round((E.s + giro.d) / 60)}`);
    }
    if (cuesta && cuesta.d <= 150) {
      decir(`Atención: tramo de ${cuesta.pend.toFixed(0)}° en ${fmtDist(cuesta.d)}. Acorta el paso.`,
        `pend${Math.floor(cuesta.i / 20)}`, true);
    }
    if (E.polvo > 0.6 && !polvoAvisado) {
      polvoAvisado = true;
      decir("Tormenta de polvo: la visibilidad es baja. No te salgas de la ruta.", null, true);
    } else if (E.polvo < 0.4) polvoAvisado = false;
    if (E.solElev < 8) decir(`El sol está muy bajo; la temperatura exterior es de ${t.temp} °C.`, "sol");
    if (t.o2 < 30) decir(`Oxígeno al ${Math.round(t.o2)} %. Vigila la reserva.`, "o2", true);
    // Remolinos de polvo cercanos
    for (const rem of ctx.remolinos) {
      const u = rem.userData;
      if (!rem.visible || u.vida > 0.85 || u.vida < 0.1) continue;
      const dx = u.wx - camara.position.x, dz = u.wz - camara.position.z, dist = Math.hypot(dx, dz);
      if (dist < 500) {
        const rumbo = Math.atan2(dx, -dz);
        decir(`Remolino de polvo a ${fmtDist(dist)}, ${relativo(rumbo - rumboCamara())}.`,
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
  const HOLO = "#6ff3ff", AVISO = "#ffb36b";

  function dibujarBrujula(rumbo) {
    const k = ajustarLienzo(brujula), g = brujula.getContext("2d"), W = brujula.width, H = brujula.height;
    g.clearRect(0, 0, W, H);
    const hd = rumbo * 180 / Math.PI, ppg = W / 110;                 // pixeles por grado
    const xDe = (deg) => W / 2 + ang((deg - hd) * Math.PI / 180) * 180 / Math.PI * ppg;
    g.strokeStyle = HOLO; g.fillStyle = HOLO; g.lineWidth = k;
    g.shadowColor = HOLO; g.shadowBlur = 6 * k;
    g.font = `${11 * k}px Consolas, ui-monospace, monospace`; g.textAlign = "center";
    const nombres = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SO", 270: "O", 315: "NO" };
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
    marca(Math.atan2(pb.x - pa.x, -(pb.z - pa.z)), HOLO, false);
    const [xm, ym] = aMapa(pa.x, pa.z);
    marca(Math.atan2(E.destino[0] - xm, E.destino[1] - ym), "#ff6b7a", true);
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
      g.strokeStyle = g.shadowColor = empinado ? AVISO : HOLO;
      g.globalAlpha = i < i0 ? 0.3 : 1;
      g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
    }
    g.globalAlpha = 1;
    // Holograma
    const ph = enRuta(Math.min(r.total, E.s + DIST_HOLO)), [hx, hy] = aPant(...aMapa(ph.x, ph.z));
    g.fillStyle = HOLO; g.beginPath(); g.arc(hx, hy, 3 * k, 0, Math.PI * 2); g.fill();
    g.restore();
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
  function escribirDatos(giro, cuesta, t) {
    const r = E.ruta, falta = Math.max(0, r.total - E.s), i = indiceEn(E.s);
    const pend = r.pend[Math.min(i, r.pend.length - 1)] ?? 0;
    $("hcRuta").innerHTML = `<h3>RUTA</h3>
      <div class="fila-hc"><span>Recorrido</span><b>${fmtDist(E.s)}</b></div>
      ${barra(E.s / r.total * 100)}
      <div class="fila-hc"><span>Restante</span><b>${fmtDist(falta)}</b></div>
      <div class="fila-hc"><span>A pie</span><b>${fmtTiempo(falta)}</b></div>
      <div class="fila-hc"><span>Altitud</span><b>${Math.round(r.z[i])} m</b></div>
      <div class="fila-hc"><span>Pendiente</span><b class="${pend > E.tol * 0.8 ? "aviso" : ""}">${pend.toFixed(1)}° / ${E.tol}°</b></div>
      ${barra(pend / E.tol * 100, pend > E.tol * 0.8)}`;
    $("hcTraje").innerHTML = `<h3>TRAJE</h3>
      <div class="fila-hc"><span>O₂</span><b class="${t.o2 < 30 ? "aviso" : ""}">${Math.round(t.o2)} %</b></div>
      ${barra(t.o2, t.o2 < 30)}
      <div class="fila-hc"><span>Batería</span><b>${Math.round(t.bat)} %</b></div>
      ${barra(t.bat, t.bat < 25)}
      <div class="fila-hc"><span>Temp. ext.</span><b>${t.temp} °C</b></div>
      <div class="fila-hc"><span>Polvo</span><b class="${E.polvo > 0.6 ? "aviso" : ""}">${Math.round(E.polvo * 100)} %</b></div>`;
    // Proxima maniobra
    let flecha = "↑", texto = falta < 2 ? "Destino alcanzado" : `Sigue la ruta · ${fmtDist(Math.min(falta, 300))}`;
    let giroDeg = 0;
    if (falta < 2) flecha = "◎";
    else if (giro) {
      giroDeg = Math.max(-90, Math.min(90, giro.dif * 180 / Math.PI));
      texto = `Gira ${giro.dif > 0 ? "a la derecha" : "a la izquierda"} · ${fmtDist(giro.d)}`;
    }
    $("hcFlecha").textContent = flecha;
    $("hcFlecha").style.transform = `rotate(${giroDeg}deg)`;
    $("hcManiobra").textContent = texto;
    $("hcAviso").textContent = cuesta ? `⚠ Pendiente de ${cuesta.pend.toFixed(0)}° en ${fmtDist(cuesta.d)}` : "";
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
    const giro = proximoGiro(), cuesta = proximaPendiente(), t = traje();
    escribirDatos(giro, cuesta, t);
    vigilar(giro, cuesta, t);
  }

  function alternarVoz() {
    sh.voz = !sh.voz;
    $("hcVoz").textContent = sh.voz ? "voz: sí" : "voz: no";
    if (!sh.voz && "speechSynthesis" in window) speechSynthesis.cancel();
    else if (sh.txt) hablar(sh.txt);
  }
  $("hcVoz").addEventListener("click", (ev) => { alternarVoz(); ev.currentTarget.blur(); });

  return {
    actualizar,
    alternarVoz,
    cambioModo(on) {
      if (!on && "speechSynthesis" in window) speechSynthesis.cancel();
      reloj = 1;                                  // refrescar datos en el siguiente cuadro
    },
    nuevaRuta() {                                 // ruta nueva: se olvidan los avisos anteriores
      const yaSaludo = sh.vistos.has("hola");
      sh.vistos.clear(); sh.cola.length = 0;
      if (yaSaludo) {
        sh.vistos.add("hola");
        decir(`Ruta recalculada: ${fmtDist(E.ruta.total)} con pendiente máxima de ${E.tol}°.`, null, true);
      }
    },
  };
}
