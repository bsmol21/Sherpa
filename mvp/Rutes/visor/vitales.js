// Signos vitales del astronauta, clima (tormenta de polvo y evento solar) y
// rutas de emergencia a los refugios.
//
// Idea (como el "walkback limit" de las caminatas Apollo, pero dinamico):
//   TIEMPO SEGURO = minutos que faltan para que algun signo vital llegue a un
//   limite de dano, al ritmo actual.
//   Para cada refugio se pide al servidor la ruta mas segura y su tiempo a pie.
//   Un refugio SIRVE si se llega con margen antes del tiempo seguro y si la
//   tormenta no cubre la ruta antes de que el astronauta pase por ella.
//   Niveles: NORMAL -> PRECAUCION (solo avisa) -> ALERTA (propone refugio y el
//   astronauta acepta) -> CRITICO (cambia la ruta solo).
//
// El reloj fisiologico es el tiempo REAL de la caminata: cada metro avanzado
// cuenta como 1/1,2 s (1,2 m/s con traje), aunque el visor vaya acelerado.
// Parado, el tiempo corre a velocidad real (sirve para ver la recuperacion).
//
// Los numeros son un modelo simple y explicable para la demo, no un modelo
// medico: ver los comentarios de cada bloque.

const VEL = 1.2;                 // m/s caminando con traje (igual que casco.js)
const G_MARTE = 3.71;            // m/s2
const MASA = 150;                // kg: astronauta + traje + equipo
const MET_REPOSO = 110;          // W
const MET_MAX = 900;             // W, esfuerzo maximo sostenible
const FC_REPOSO = 65, FC_MAX = 185;
const CAP_TERMICA = 80 * 3470;   // J/K (80 kg de cuerpo)
const LIM_DOSIS = 20;            // mSv: limite de dosis de la salida (valor de demo)
const GCR = 0.028;               // mSv/h: radiacion de fondo en la superficie (RAD/Curiosity ~0,67 mSv/dia)
const SEP_TASA = 12;             // mSv/h durante el evento solar (valor de demo)
const SEP_AVISO_MIN = 20;        // min entre la alerta y la llegada de las particulas
const SEP_DURACION_MIN = 180;
const TORMENTA_VEL = 2.5;        // m/s de avance del frente
const TORMENTA_LLEGA_MIN = 35;   // min hasta que el frente alcanza al astronauta al activarla
const MARGEN = 1.2;              // se exige llegar en 1,2 x el tiempo a pie...
const MARGEN_MIN = 3;            // ...mas 3 min

// Limites: [aviso, critico, dano]
const LIM = {
  fatiga: [70, 90, 100],         // %
  tAlta: [38.3, 38.8, 39.0],     // C
  tBaja: [36.0, 35.5, 35.0],     // C
  spo2: [92, 88, 85],            // %
};

export function crearVitales(ctx) {
  const { E, $, enRuta, aMapa, decir } = ctx;

  // ------------------------------------------------------------ estado
  const V = {
    t: 0,                        // s de simulacion
    fc: FC_REPOSO, met: MET_REPOSO, tc: 37.0, spo2: 97.5, fatiga: 0, dosis: 0,
    tasas: { fatiga: 0, tc: 0, spo2: 0 },     // por segundo, suavizadas
    tExt: -40, intensidad: 0, andando: false, enRefugio: null,
    tormenta: null,              // { d:[dx,dy], frente0, t0 }
    solar: null,                 // { t0 }
    fatigaExtra: false, hipoxia: false,
    seguro: Infinity, limita: null, tTormenta: Infinity,
    opciones: null,              // ultima respuesta del servidor + cuando
    mejor: null, respaldo: null, evaluadas: [],
    nivel: "normal", causa: "",
    propuesta: null,             // refugio propuesto en ALERTA (falta aceptar)
    emergencia: null,            // refugio al que se va
    preparando: null,            // texto mientras el servidor prepara los arboles
  };
  E.vit = V;
  let sPrev = null, rutaPrev = null;
  let pidiendo = false, ultimaPeticion = { t: -1e9, x: 1e9, y: 1e9 }, reintento = 0;
  const avisos = new Map();      // clave -> t (s sim) del ultimo aviso

  const fmtMin = (m) => !isFinite(m) || m > 600 ? "> 10 h"
    : m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.max(0, Math.round(m))} min`;
  const avisar = (clave, texto, urgente = false, cadaMin = 4) => {
    const t0 = avisos.get(clave);
    if (t0 !== undefined && V.t - t0 < cadaMin * 60) return;
    avisos.set(clave, V.t);
    decir(texto, null, urgente);
  };

  // ------------------------------------------------------ posicion
  function posMapa() {
    const p = enRuta(E.s);
    return aMapa(p.x, p.z);
  }
  function pendienteAqui() {
    const r = E.ruta, i = Math.min(ctx.indiceEn(E.s), r.x.length - 2);
    if (i < 0) return 0;
    const dxy = Math.hypot(r.x[i + 1] - r.x[i], r.y[i + 1] - r.y[i]) || 1;
    return (r.z[i + 1] - r.z[i]) / dxy;               // + subida, - bajada
  }

  // ------------------------------------------------------ clima
  const dot = (p, d) => p[0] * d[0] + p[1] * d[1];
  // Segundos de simulacion en que el frente cubre el punto p (x, y en m)
  function llegadaTormenta(p) {
    const T = V.tormenta;
    if (!T) return Infinity;
    return T.t0 + (dot(p, T.d) - T.frente0) / TORMENTA_VEL;
  }
  function tasaDosis() {
    let r = GCR;
    if (V.solar && V.t >= V.solar.t0 && V.t < V.solar.t0 + SEP_DURACION_MIN * 60) r += SEP_TASA;
    return V.enRefugio ? r * 0.1 : r;                 // refugio con blindaje portatil
  }
  // Polvo en la escena: sube al acercarse el frente y se cierra al cubrirte
  function polvoDeseado(p) {
    if (!V.tormenta) return null;
    const falta = (llegadaTormenta(p) - V.t) / 60;
    if (falta <= 0) return 0.9;
    if (falta < 15) return 0.25 + 0.4 * (1 - falta / 15);
    return null;
  }

  // ------------------------------------------------------ fisiologia
  // Un paso de h segundos.
  function paso(h, andando, pend) {
    // Esfuerzo (W): reposo + caminar en llano + subir (25 % de rendimiento
    // muscular) con la gravedad de Marte. En llano a 1,2 m/s da ~290 W, en
    // una subida del 20 % ~820 W: del orden de lo medido en caminatas lunares.
    let met = MET_REPOSO;
    if (andando) {
      met += MASA * VEL * (1.0 + G_MARTE * Math.max(0, pend) / 0.25 + 0.4 * Math.max(0, -pend - 0.15));
      if (V.tormenta && llegadaTormenta(posMapa()) <= V.t) met *= 1.25;   // viento y poca visibilidad
    }
    V.met = met;
    const I = Math.min(1.2, Math.max(0, (met - MET_REPOSO) / (MET_MAX - MET_REPOSO)));
    V.intensidad = I;

    // Fatiga (%): se acumula con esfuerzo por encima del 45 % y se recupera parado
    let df;
    if (I > 0.45) df = (I - 0.45) * 0.159;           // al 80 % de intensidad: 100 % en ~30 min
    else df = andando ? -0.01 : -0.05;
    if (V.fatigaExtra) df = Math.max(df, 0) * 3 + 0.03;
    V.fatiga = Math.min(100, Math.max(0, V.fatiga + df * h));

    // Temperatura corporal: calor producido (80 % del esfuerzo) contra el que
    // se pierde. El cuerpo regula fuerte hacia arriba (sudor, ropa refrigerada)
    // y poco hacia abajo; el frio exterior extremo suma perdidas.
    const frio = V.enRefugio ? 0 : 4 * Math.max(0, -50 - V.tExt);
    const perdida = 270 + (V.tc > 37 ? 400 : 120) * (V.tc - 37) + frio;
    V.tc += (0.8 * met - perdida) / CAP_TERMICA * h;

    // Pulso: lineal con el esfuerzo (como el modelo pulso-metabolismo de la
    // NASA) + deriva por fatiga y por calor; responde en ~40 s.
    const fcObj = FC_REPOSO + (FC_MAX - FC_REPOSO) * Math.min(1, I) + V.fatiga * 0.15 +
      Math.max(0, V.tc - 37) * 10 + (V.fatigaExtra ? 20 : 0);
    V.fc += (fcObj - V.fc) * (1 - Math.exp(-h / 40));

    // SpO2 (oxigeno en la sangre): baja un poco con el esfuerzo; con el evento
    // "SpO2 baja" cae ~0,4 %/min (problema respiratorio, fuga leve).
    const sObj = V.hipoxia ? 80 : 97.5 - 2 * Math.min(1, I);
    V.spo2 += (sObj - V.spo2) * (1 - Math.exp(-h / (V.hipoxia ? 2400 : 30)));

    V.dosis += tasaDosis() * h / 3600;
  }

  // Minutos hasta que cada signo llega a su limite de dano, al ritmo actual
  function tiempoSeguro() {
    const t = V.tasas, lista = [];
    if (t.fatiga > 1e-4 && V.fatiga > 5) lista.push(["fatiga", (LIM.fatiga[2] - V.fatiga) / t.fatiga / 60]);
    // (solo tendencias que ya se notan: evita falsas alarmas al empezar a caminar)
    if (t.tc > 1e-6 && V.tc > 37.3) lista.push(["temperatura alta", (LIM.tAlta[2] - V.tc) / t.tc / 60]);
    if (t.tc < -1e-6 && V.tc < 36.8) lista.push(["temperatura baja", (V.tc - LIM.tBaja[2]) / -t.tc / 60]);
    if (t.spo2 < -1e-5 && (V.spo2 < 95 || V.hipoxia)) lista.push(["oxígeno en sangre", (V.spo2 - LIM.spo2[2]) / -t.spo2 / 60]);
    // dosis: cuenta tambien un evento solar anunciado que aun no llega
    const S = V.solar;
    if (S && V.t < S.t0 + SEP_DURACION_MIN * 60) {
      const espera = Math.max(0, S.t0 - V.t) / 60;
      lista.push(["radiación", espera + (LIM_DOSIS - V.dosis) / (V.enRefugio ? SEP_TASA * 0.1 : SEP_TASA) * 60]);
    }
    let m = Infinity, cual = null;
    for (const [k, v] of lista) if (v < m) { m = Math.max(0, v); cual = k; }
    V.seguro = m; V.limita = cual;
  }

  // ------------------------------------------------------ refugios
  async function pedirOpciones(forzar = false) {
    if (pidiendo || !E.refugios || !E.ruta) return;
    const [x, y] = posMapa();
    const movido = Math.hypot(x - ultimaPeticion.x, y - ultimaPeticion.y);
    if (!forzar && (V.t - ultimaPeticion.t < 30 || movido < 30) && V.opciones) return;
    if (performance.now() < reintento) return;
    pidiendo = true;
    try {
      const r = await fetch("/api/emergencia", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ desde: [x, y], pendiente_maxima: E.tol }) });
      const res = await r.json();
      if (res.ok && !res.listo) {
        V.preparando = `Preparando rutas de emergencia (${res.progreso}/${res.total})…`;
        reintento = performance.now() + 2000;
      } else if (res.ok) {
        V.preparando = null;
        V.opciones = { ...res, t: V.t, s: E.s };
        ultimaPeticion = { t: V.t, x, y };
        evaluar();
      }
    } catch (e) {
      reintento = performance.now() + 4000;
    } finally {
      pidiendo = false;
    }
  }

  // Decide que refugios sirven y cual es el mejor
  function evaluar() {
    const O = V.opciones;
    if (!O) return;
    const enTormenta = V.tTormenta <= 0;
    V.evaluadas = O.rutas.map((r) => {
      const ref = E.refugios.find((f) => f.id === r.id);
      if (!r.alcanzable) return { ref, ruta: r, alcanzable: false, motivo: "sin ruta transitable" };
      const eta = r.tiempo_s / 60;
      let comprometido = false;
      if (V.tormenta && !enTormenta) {
        for (let i = 0; i < r.x.length; i += 3) {
          if (llegadaTormenta([r.x[i], r.y[i]]) < V.t + r.t[i] + 120) { comprometido = true; break; }
        }
      }
      const llega = eta * MARGEN + MARGEN_MIN < V.seguro;
      const motivo = comprometido ? "la tormenta cubre la ruta antes de que pases"
        : !llega ? `no llegas con margen (${fmtMin(eta)} a pie, tiempo seguro ${fmtMin(V.seguro)})` : "";
      return { ref, ruta: r, alcanzable: true, eta, comprometido, llega, sirve: !comprometido && llega, motivo };
    });
    const sirven = V.evaluadas.filter((o) => o.sirve).sort((a, b) => a.eta - b.eta);
    V.mejor = sirven[0] ?? null;
    // respaldo: si ninguno sirve, el que deja mas margen (o el mas cercano)
    const alc = V.evaluadas.filter((o) => o.alcanzable)
      .sort((a, b) => (a.comprometido - b.comprometido) || (a.eta - b.eta));
    V.respaldo = V.mejor ?? alc[0] ?? null;
  }

  // ------------------------------------------------------ niveles
  function decidirNivel() {
    const c = [];                  // [nivel, causa]
    const add = (n, txt) => c.push([n, txt]);
    const margen = V.mejor ? V.seguro - V.mejor.eta : -Infinity;
    if (V.fatiga >= LIM.fatiga[1]) add(3, `fatiga al ${Math.round(V.fatiga)} %`);
    else if (V.fatiga >= LIM.fatiga[0]) add(2, `fatiga al ${Math.round(V.fatiga)} %`);
    else if (V.fatiga >= 45) add(1, `fatiga al ${Math.round(V.fatiga)} %`);
    if (V.tc >= LIM.tAlta[1]) add(3, `temperatura corporal de ${V.tc.toFixed(1)} °C`);
    else if (V.tc >= LIM.tAlta[0]) add(2, `temperatura corporal de ${V.tc.toFixed(1)} °C`);
    if (V.tc <= LIM.tBaja[1]) add(3, `temperatura corporal de ${V.tc.toFixed(1)} °C`);
    else if (V.tc <= LIM.tBaja[0]) add(2, `temperatura corporal de ${V.tc.toFixed(1)} °C`);
    if (V.spo2 <= LIM.spo2[1]) add(3, `oxígeno en sangre al ${Math.round(V.spo2)} %`);
    else if (V.spo2 <= LIM.spo2[0]) add(2, `oxígeno en sangre al ${Math.round(V.spo2)} %`);
    if (V.fc >= FC_MAX * 0.9) add(2, `pulso de ${Math.round(V.fc)}`);
    else if (V.fc >= FC_MAX * 0.8) add(1, `pulso de ${Math.round(V.fc)}`);
    if (V.dosis >= LIM_DOSIS * 0.8) add(3, `dosis de ${V.dosis.toFixed(1)} mSv`);
    else if (V.dosis >= LIM_DOSIS * 0.5) add(2, `dosis de ${V.dosis.toFixed(1)} mSv`);
    if (V.solar && V.t < V.solar.t0 + SEP_DURACION_MIN * 60 && !V.enRefugio) add(2, "evento de partículas solares");
    if (V.tormenta && !V.enRefugio) {
      if (V.tTormenta <= 0) add(3, "estás dentro de la tormenta");
      else if (V.tTormenta < 30) add(2, `la tormenta te alcanza en ${fmtMin(V.tTormenta)}`);
      else add(1, `tormenta a ${fmtMin(V.tTormenta)}`);
    }
    if (V.opciones && isFinite(V.seguro)) {
      if (!V.mejor) add(3, "ningún refugio alcanzable con margen");
      else if (margen < 10) add(3, `margen de solo ${fmtMin(margen)}`);
      else if (margen < 25) add(2, `margen de ${fmtMin(margen)}`);
      else if (margen < 45) add(1, `margen de ${fmtMin(margen)}`);
    }
    c.sort((a, b) => b[0] - a[0]);
    const n = c.length ? c[0][0] : 0;
    V.nivel = ["normal", "precaucion", "alerta", "critico"][n];
    V.causa = c.filter((x) => x[0] === n).map((x) => x[1]).join(", ");
  }

  // ------------------------------------------------------ acciones
  function nombreCorto(ref) { return ref.nombre.replace("Refugio ", "refugio "); }

  function irA(op, auto) {
    V.emergencia = op.ref;
    V.propuesta = null;
    V.enRefugio = null;
    ctx.irARefugio(op.ruta, op.ref);
    sPrev = E.s; rutaPrev = E.ruta;
    const extra = V.mejor ? "" : " No llegas con margen a ningún refugio: baja el ritmo y aviso a la base.";
    decir(`${auto ? "Emergencia" : "De acuerdo"}: ${auto ? V.causa + ". " : ""}Te llevo al ${nombreCorto(op.ref)}, ` +
      `a ${fmtMin(op.eta)} a pie. Sigue al holograma.${extra}`, null, true);
  }

  function actuar() {
    if (V.enRefugio || V.emergencia) return;
    const op = V.mejor ?? V.respaldo;
    if (V.nivel === "critico" && op) return irA(op, true);
    if (V.nivel === "alerta" && op) {
      if (!V.propuesta || V.propuesta.ref.id !== op.ref.id) {
        V.propuesta = op;
        avisar(`prop${op.ref.id}`, `Alerta: ${V.causa}. Te propongo ir al ${nombreCorto(op.ref)}, a ` +
          `${fmtMin(op.eta)}. Pulsa A para aceptar.`, true, 3);
      } else V.propuesta = op;                        // datos frescos
      return;
    }
    V.propuesta = null;
    if (V.nivel === "precaucion") {
      if (V.fc >= FC_MAX * 0.8) avisar("fc", `Pulso alto: ${Math.round(V.fc)}. Baja el ritmo.`);
      if (V.fatiga >= 45) avisar("fat", `Fatiga al ${Math.round(V.fatiga)} %. Haz pausas cortas y bebe agua.`);
      if (V.tormenta && op) avisar("torm", `Tormenta de polvo a ${fmtMin(V.tTormenta)}. ` +
        `El refugio más cercano que sirve es el ${nombreCorto(op.ref)}, a ${fmtMin(op.eta)}.`, false, 6);
      if (V.mejor && V.seguro - V.mejor.eta < 45) avisar("marg", `Tu tiempo seguro es de ${fmtMin(V.seguro)}; ` +
        `el ${nombreCorto(V.mejor.ref)} está a ${fmtMin(V.mejor.eta)}. Conviene ir acercándote.`, false, 6);
    }
  }

  function vigilarLlegada() {
    if (!V.emergencia || !E.ruta) return;
    if (E.ruta.total - E.s <= 3) {
      V.enRefugio = V.emergencia;
      V.emergencia = null;
      const motivo = V.tormenta ? "hasta que pase la tormenta" : V.solar ? "hasta que termine el evento solar"
        : "y descansa hasta recuperarte";
      decir(`Llegaste al ${nombreCorto(V.enRefugio)}. Estás a salvo: quédate aquí ${motivo}.`, null, true);
    }
  }

  // ------------------------------------------------------ eventos de demo
  function evento(tipo) {
    const [x, y] = E.ruta ? posMapa() : [0, 0];
    if (tipo === "tormenta") {
      // El frente viene del noroeste (avanza hacia el sureste) y llega al
      // astronauta en TORMENTA_LLEGA_MIN.
      const d = [Math.SQRT1_2, -Math.SQRT1_2];
      V.tormenta = { d, t0: V.t, frente0: dot([x, y], d) - TORMENTA_VEL * TORMENTA_LLEGA_MIN * 60 };
      V.polvoAntes = E.polvo;
      decir(`Aviso meteorológico: tormenta de polvo desde el noroeste. Te alcanza en unos ${TORMENTA_LLEGA_MIN} minutos.`, null, true);
    } else if (tipo === "solar") {
      V.solar = { t0: V.t + SEP_AVISO_MIN * 60 };
      decir(`Alerta de clima espacial: llamarada solar. Las partículas llegan en ${SEP_AVISO_MIN} minutos. ` +
        "Busca refugio.", null, true);
    } else if (tipo === "fatiga") {
      V.fatigaExtra = !V.fatigaExtra;
      if (V.fatigaExtra) decir("Detecto signos de agotamiento: pulso alto y fatiga en aumento.", null, true);
    } else if (tipo === "hipoxia") {
      V.hipoxia = !V.hipoxia;
      if (V.hipoxia) decir("Atención: tu oxígeno en sangre está bajando.", null, true);
    } else if (tipo === "reiniciar") {
      Object.assign(V, { fc: FC_REPOSO, met: MET_REPOSO, tc: 37, spo2: 97.5, fatiga: 0, dosis: 0,
        tormenta: null, solar: null, fatigaExtra: false, hipoxia: false, propuesta: null,
        emergencia: null, enRefugio: null, nivel: "normal", causa: "" });
      V.tasas = { fatiga: 0, tc: 0, spo2: 0 };
      avisos.clear();
      if (V.polvoAntes != null) { ctx.ponerPolvo(V.polvoAntes); V.polvoAntes = null; }
    }
    ultimaPeticion.t = -1e9;
    pedirOpciones(true);
  }

  function aceptar() {
    if (V.propuesta) irA(V.propuesta, false);
  }

  // ------------------------------------------------------ ciclo
  let reloj = 0;
  function actualizar(dt) {
    if (!E.siguiendo || !E.ruta) { sPrev = null; return; }
    if (rutaPrev !== E.ruta || sPrev === null) { sPrev = E.s; rutaPrev = E.ruta; }
    const ds = E.s - sPrev;
    sPrev = E.s;
    const andando = ds > 1e-6 && !V.enRefugio;
    V.andando = andando;
    // Si se salta hacia atras por el perfil, no corre el tiempo
    let dtSim = andando ? ds / VEL : (ds < -1e-6 ? 0 : dt);
    const elev = E.solElev * Math.PI / 180;
    V.tExt = Math.round(-85 + 65 * Math.sin(elev) - 6 * E.polvo);
    const pend = pendienteAqui();
    const antes = { fatiga: V.fatiga, tc: V.tc, spo2: V.spo2 };
    let h = dtSim;
    while (h > 0) {                                   // pasos de como mucho 5 s
      const k = Math.min(5, h);
      paso(k, andando, pend);
      h -= k;
    }
    V.t += dtSim;
    if (dtSim > 0) {                                  // tendencias suavizadas (~60 s)
      const a = 1 - Math.exp(-dtSim / 60);
      for (const k of ["fatiga", "tc", "spo2"]) {
        V.tasas[k] += ((V[k] - antes[k]) / dtSim - V.tasas[k]) * a;
      }
    }
    // Clima en la posicion actual
    const p = posMapa();
    V.tTormenta = V.tormenta ? (llegadaTormenta(p) - V.t) / 60 : Infinity;
    const q = polvoDeseado(p);
    if (q != null && !V.enRefugio && Math.abs(q - E.polvo) > 0.02) ctx.ponerPolvo(E.polvo + (q - E.polvo) * Math.min(1, dt * 2));

    if ((reloj += dt) < 0.25) return;                 // decisiones 4 veces por segundo
    reloj = 0;
    tiempoSeguro();
    pedirOpciones();
    evaluar();
    decidirNivel();
    actuar();
    vigilarLlegada();
  }

  return {
    actualizar, evento, aceptar, llegadaTormenta, fmtMin,
    nuevaRutaNormal() { V.emergencia = null; V.enRefugio = null; V.propuesta = null; sPrev = null; V.opciones = null; },
  };
}
