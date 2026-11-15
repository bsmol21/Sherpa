// Idioma de la interfaz y de Sherpa (texto y voz): "es" o "en".
// Se elige en el menu de inicio (y se recuerda en este navegador).
//   t(clave, ...datos)  texto en el idioma actual; las entradas con datos son
//                       funciones. Si falta una clave en ingles se usa la de espanol.
//   data-t / data-t-html / data-t-title en el HTML: se traducen solos.
//   alCambiarIdioma(f): para redibujar lo que se genera desde JS.
// Los textos de los datos (geologia, suelo, polvo) vienen en espanol del
// pipeline; aqui se traducen al ingles a partir de sus claves.

const GUARDADO = "pathfinder.idioma";
let actual = "es";
const oyentes = [];

export const idioma = () => actual;
export const locale = () => (actual === "en" ? "en-US" : "es-ES");

export function idiomaGuardado() {
  try {
    const v = localStorage.getItem(GUARDADO);
    return v === "en" || v === "es" ? v : null;
  } catch (e) { return null; }
}
export function ponerIdioma(l, guardar = true) {
  actual = l === "en" ? "en" : "es";
  if (guardar) { try { localStorage.setItem(GUARDADO, actual); } catch (e) { /* sin almacenamiento */ } }
  document.documentElement.lang = actual;
  traducirDOM();
  for (const f of oyentes) f(actual);
}
export function alCambiarIdioma(f) { oyentes.push(f); }

export function t(clave, ...a) {
  const v = TEXTOS[actual][clave] ?? TEXTOS.es[clave];
  if (v === undefined) return clave;
  return typeof v === "function" ? v(...a) : v;
}
export function traducirDOM(raiz = document) {
  for (const el of raiz.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  for (const el of raiz.querySelectorAll("[data-t-html]")) el.innerHTML = t(el.dataset.tHtml);
  for (const el of raiz.querySelectorAll("[data-t-title]")) el.title = t(el.dataset.tTitle);
  document.title = t("titulo");
}

// ------------------------------------------------------------ formatos
export const num = (v, d = 0) => Number(v).toLocaleString(locale(),
  { minimumFractionDigits: d, maximumFractionDigits: d });
export const dist = (m) => (m < 1000 ? `${Math.max(0, Math.round(m / 10) * 10)} m` : `${num(m / 1000, 1)} km`);
export const minutos = (m) => (!isFinite(m) || m > 600 ? "> 10 h"
  : m >= 60 ? `${Math.floor(m / 60)} h ${Math.round(m % 60)} min` : `${Math.max(0, Math.round(m))} min`);

// Refugios: el servidor los llama "Refugio A", "Refugio B"...
export const letraRef = (ref) => ref.nombre.replace(/^Refugio\s*/i, "") || String(ref.id);
export const nombreRef = (ref) => (actual === "en" ? `Shelter ${letraRef(ref)}` : `Refugio ${letraRef(ref)}`);
const refMin = (ref) => (actual === "en" ? `Shelter ${letraRef(ref)}` : `refugio ${letraRef(ref)}`);

// ------------------------------------------------------------ datos
const GEO_INTERES_EN = {
  "Son macizos levantados por un impacto gigante: de la corteza más antigua de Marte.":
    "These massifs were uplifted by a giant impact: some of the oldest crust on Mars.",
  "Es corteza antigua de las tierras altas, muy craterizada.": "This is ancient, heavily cratered highland crust.",
  "Es terreno de transición entre las tierras altas y las bajas, modelado por erosión y sedimentos.":
    "This is transition terrain between the highlands and lowlands, shaped by erosion and sediments.",
  "Es material expulsado por un cráter de impacto: trae a la superficie roca de las profundidades.":
    "This is material ejected by an impact crater: it brings deep rock to the surface.",
  "Son coladas de lava.": "These are lava flows.",
  "Es el flanco de un volcán.": "This is the flank of a volcano.",
};
const millones = (s) => num(+s.replace(/\./g, ""));
// Unidad geologica: {nombre, edad, interes} en el idioma actual
export function geoTxt(u) {
  if (actual !== "en") return { nombre: u.nombre, edad: u.edad, interes: u.interes };
  let edad = u.edad || "";
  let m = edad.match(/entre ([\d.]+) y ([\d.]+) millones/);
  if (m) edad = `between ${millones(m[1])} and ${millones(m[2])} million years old`;
  else if ((m = edad.match(/menos de ([\d.]+) millones/))) edad = `less than ${millones(m[1])} million years old`;
  const nombre = u.descripcion || `unit ${u.codigo}`;   // nombre USGS en ingles (periodos con mayuscula)
  return { nombre, edad, interes: GEO_INTERES_EN[u.interes] ?? "" };
}
const SUELO_EN = {
  fino: ["loose fine material", "Very fine dust or sand, uncompacted: boots sink in and kick up dust."],
  arena: ["sand", "Loose or lightly compacted sand: easy walking, but more effort."],
  compacto: ["compact soil with gravel", "Coarse sand, gravel or slightly cemented soil: good footing."],
  roca: ["rocky or cemented ground", "Boulders, outcrops or cemented crusts: firm footing and scientific interest."],
};
// Clase de suelo: {nombre, descripcion}
export function sueloTxt(c) {
  const en = actual === "en" && SUELO_EN[c.clave];
  return en ? { nombre: en[0], descripcion: en[1] } : { nombre: c.nombre, descripcion: c.descripcion };
}
const POLVO_EN = { bajo: "low", moderado: "moderate", alto: "high" };
const POLVO_TXT_EN = {
  "la superficie expone su material real, no una capa de polvo": "the surface shows its real material, not a dust layer",
  "hay algo de polvo fino sobre el suelo": "there is some fine dust on the ground",
  "el suelo está cubierto de polvo fino; la inercia baja puede ser solo polvo":
    "the ground is covered in fine dust; low inertia may be just dust",
};
export function polvoTxt(p) {
  return actual === "en" ? { nivel: POLVO_EN[p.nivel] ?? p.nivel, texto: POLVO_TXT_EN[p.texto] ?? p.texto }
    : { nivel: p.nivel, texto: p.texto };
}
const NOTAS_EN = {
  "Mapa global: los contactos pueden estar corridos varios kilometros. Edades aproximadas (modelo de conteo de crateres).":
    "Global map: unit boundaries may be offset by several kilometres. Approximate ages (crater-count model).",
  "Inercia ±20 %; cada píxel de 100 m mezcla materiales. El polvo es un valor regional.":
    "Inertia ±20 %; each 100 m pixel mixes materials. Dust is a regional value.",
};
// Fuentes y notas de las capas
export function notaTxt(s) {
  if (actual !== "en" || !s) return s ?? "";
  if (NOTAS_EN[s]) return NOTAS_EN[s];
  return s.replace("escala 1:20.000.000", "scale 1:20,000,000")
    .replace("inercia térmica de Jezero", "Jezero thermal inertia")
    .replace("índice de cobertura de polvo", "dust cover index")
    .replace(/ y /g, " and ").replace(/píxel/g, "pixel").replace("~3,5 km", "~3.5 km");
}

// ------------------------------------------------------------ textos
const TEXTOS = {
  es: {
    titulo: "PathFinder · Visor de rutas",
    // menu de inicio
    menuSub: "Rutas seguras para caminar por Marte",
    menuIdioma: "Idioma · Language",
    menuCargando: "Cargando terreno…",
    menuEmpezar: "Empezar",
    menuVoz: "Sherpa te hablará en este idioma (texto y voz).",
    cambiarIdioma: "Cambiar idioma",
    errorTerreno: "No se pudo cargar el terreno. ¿Está corriendo visor_rutas.py?",
    // panel
    panelSub: "Haz clic en el terreno para colocar los puntos. La ruta se recalcula sola.",
    clicColoca: "Clic coloca",
    btnInicio: "● Inicio", btnDestino: "● Destino",
    intercambiar: "Intercambiar inicio y destino",
    pendMax: "Pendiente máxima (tolerancia)",
    verProhibido: "Marcar en rojo las zonas más empinadas que el límite",
    exag: "Exageración vertical",
    polvoAire: "Polvo en suspensión",
    alturaSol: "Altura del sol",
    remolinos: "Remolinos de polvo",
    capaGeo: "Capa geológica (mapa global USGS)",
    capaSuelo: "Tipo de suelo (inercia térmica THEMIS)",
    eligePuntos: "Elige el inicio y el destino.",
    recorrer: "▶ Recorrer ruta", dejarRecorrer: "■ Dejar de recorrer",
    vistaGeneral: "Vista general del mapa", descargarCsv: "Descargar la ruta como CSV",
    ayudaOrbita: "<b>Explorar:</b> arrastra para girar, clic derecho para desplazar, rueda para acercar. <kbd>R</kbd> recorre la ruta.",
    ayudaRuta: "<b>Recorriendo:</b> rueda = acercar/alejar · <kbd>Espacio</kbd> pausa · <kbd>←</kbd><kbd>→</kbd> avanzar/retroceder " +
      "(<kbd>Shift</kbd> = más) · <kbd>↑</kbd><kbd>↓</kbd> velocidad · <kbd>C</kbd> cámara · arrastra para mirar alrededor · " +
      "doble clic centra la mirada · <kbd>Esc</kbd> salir. En primera persona: <kbd>V</kbd> voz de Sherpa · <kbd>Tab</kbd> mostrar este panel. " +
      "Simular: <kbd>1</kbd> tormenta · <kbd>2</kbd> evento solar · <kbd>3</kbd> fatiga · <kbd>4</kbd> SpO₂ baja · " +
      "<kbd>0</kbd> reiniciar · <kbd>A</kbd> aceptar ruta al refugio.",
    puntoInicio: (p) => `Inicio: ${p ?? "sin elegir"}`,
    puntoDestino: (p) => `Destino: ${p ?? "sin elegir"}`,
    fueraMapa: "Ese punto está fuera del mapa o sin datos.",
    calculando: "Calculando ruta…",
    sinServidor: "No se pudo contactar con el servidor. ¿Sigue abierto visor_rutas.py?",
    rutaOk: (p) => `Ruta con pendiente máxima de ${p}°`,
    rutaEmergencia: (ref) => `Ruta de emergencia al ${refMin(ref)}`,
    errFueraMapa: (q) => `El ${q === "inicio" ? "inicio" : "destino"} está fuera del mapa.`,
    errSinDatos: (q) => `El ${q === "inicio" ? "inicio" : "destino"} cae en una zona sin datos.`,
    errSinRuta: (p) => `No existe ruta con pendiente máxima de ${p}°. Prueba subir la tolerancia o mover los puntos ` +
      "(puede que uno esté rodeado de paredes empinadas).",
    stDist: "Distancia sobre el terreno", stRecta: "En línea recta", stDesvio: "Desvío",
    stSubida: "Subida / bajada", stPend: "Pendiente máx. / media", stPie: "A pie (~1,2 m/s)",
    polvoNiv: ["Despejado", "Algo de polvo", "Calima", "Tormenta", "Gran tormenta"],
    camaras: ["Primera persona", "Persecución", "Aérea"],
    altura: "altura", pendiente: "pendiente", geologia: "geología", suelo: "suelo", inercia: "inercia",
    inerciaEn: (u) => `Inercia en ${u}.`,
    delMapa: "% del mapa",
    polvoSup: (nivel, emis, radio) => `Polvo superficial de la zona: <b>${nivel}</b> (emisividad ${emis}, radio ${radio} km)`,
    // HUD inferior
    tPlay: "Reproducir / pausar (Espacio)", tCamara: "Cambiar cámara (C)", tVel: "Velocidad (↑/↓)",
    tSalir: "Salir del recorrido (Esc)", tPerfil: "Haz clic o arrastra para saltar a un punto de la ruta",
    simular: "Simular:",
    evTormenta: "⛈ Tormenta", evSolar: "☢ Evento solar", evFatiga: "♥ Fatiga",
    tTormenta: "Tormenta de polvo (1)", tSolar: "Evento de partículas solares (2)", tFatiga: "Agotamiento (3)",
    tHipoxia: "Baja de oxígeno en sangre (4)", tReiniciar: "Reiniciar signos vitales y clima (0)",
    irRefugio: (ref) => `Ir al ${refMin(ref)} (A)`,
    niveles: { normal: "Normal", precaucion: "Precaución", alerta: "Alerta", critico: "Crítico" },
    vitLinea: (nivel, fc, seguro) => `<b>${nivel}</b> · ♥ ${fc} · tiempo seguro ${seguro}`,
    refA: (ref, eta) => `${nombreRef(ref)} a ${eta}`,
    preparando: (p, n) => `Preparando rutas de emergencia (${p}/${n})…`,
    // casco
    asistente: "asistente de ruta", vozSi: "voz: sí", vozNo: "voz: no",
    tVoz: "Activar o silenciar la voz (V)",
    enLinea: "En línea · siguiendo la ruta",
    puntos: { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SO", 270: "O", 315: "NO" },
    hRuta: "RUTA", hRecorrido: "Recorrido", hRestante: "Restante", hPie: "A pie", hAltitud: "Altitud",
    hPend: "Pendiente", hGeo: "Geología", hSuelo: "Suelo",
    destinoAlcanzado: "Destino alcanzado",
    sigue: (d) => `Sigue la ruta · ${d}`,
    gira: (der, d) => `Gira ${der ? "a la derecha" : "a la izquierda"} · ${d}`,
    avisoPend: (p, d) => `⚠ Pendiente de ${p}° en ${d}`,
    hEntorno: "ENTORNO", hTempExt: "Temp. ext.", hPolvo: "Polvo",
    hVitales: "VITALES", hPulso: "Pulso", lpm: "lpm", hEsfuerzo: "Esfuerzo", hTempCorp: "Temp. corp.",
    hFatiga: "Fatiga", hDosis: "Dosis", hSeguro: "T. seguro", limita: (x) => `limita: ${x}`,
    hVasAl: "Vas al", hRefugio: "Refugio", aSalvo: "a salvo", hTormenta: "Tormenta", encima: "encima",
    estNivel: { precaucion: "▲ PRECAUCIÓN", alerta: "■ ALERTA", critico: "■ EMERGENCIA" },
    estEmergencia: (ref) => `■ RUTA DE EMERGENCIA → ${nombreRef(ref)}`,
    estSalvo: (ref) => `● A SALVO EN ${nombreRef(ref).toUpperCase()}`,
    estPropuesta: (ref, eta) => ` · Ir al ${refMin(ref)} (${eta}): pulsa A`,
    relativo: { delante: "delante de ti", detras: "detrás de ti", der: "a tu derecha", izq: "a tu izquierda" },
    // Sherpa
    shHola: (d, tp) => `Hola, soy Sherpa. Te guiaré por ${d} de ruta, cerca de ${tp} a pie. Sigue al holograma.`,
    shFin: "Has llegado al destino. Buen trabajo.",
    shCasi: (refugio, d) => `${refugio ? "El refugio" : "El destino"} está a ${d}.`,
    shMitad: (d, tp) => `Mitad del camino. Quedan ${d}, cerca de ${tp}.`,
    shHito: (h, d) => `Llevas el ${h} %. Quedan ${d}.`,
    shGiro: (d, der) => `En ${d} gira ${der ? "a la derecha" : "a la izquierda"}.`,
    shCuesta: (p, d) => `Atención: tramo de ${p}° en ${d}. Acorta el paso.`,
    shTormentaVis: "Tormenta de polvo: la visibilidad es baja. No te salgas de la ruta.",
    shSolBajo: (tc) => `El sol está muy bajo; la temperatura exterior es de ${tc} °C.`,
    shRemolino: (d, rel) => `Remolino de polvo a ${d}, ${rel}.`,
    shRecalculada: (d, p) => `Ruta recalculada: ${d} con pendiente máxima de ${p}°.`,
    shGeo: (n, e) => `Geología: caminas sobre la ${n}${e ? `, de ${e}` : ""}.`,
    shGeoCambio: (n, e, i) => `Según el mapa geológico, aquí cambia el terreno: entras en la ${n}${e ? `, de ${e}` : ""}. ` +
      `${i ? i + " " : ""}Buen punto para tomar una muestra.`,
    shSueltoAqui: (n) => `Pisas ${n}: riesgo de hundirte. Paso corto y firme.`,
    shSuelto: (n, d) => `${n.charAt(0).toUpperCase() + n.slice(1)} en ${d}: riesgo de hundirte. Paso corto y firme.`,
    shSuelo: (n) => `Suelo: la inercia térmica indica ${n} bajo tus pies.`,
    shPolvoSup: (nivel, txt) => ` Polvo superficial ${nivel} en la zona: ${txt}.`,
    shRoca: (n) => `Pisas ${n}: apoyo firme. La roca expuesta es buen punto para tomar una muestra.`,
    // vitales
    causa: {
      fatiga: (v) => `fatiga al ${v} %`, temp: (v) => `temperatura corporal de ${v} °C`,
      spo2: (v) => `oxígeno en sangre al ${v} %`, fc: (v) => `pulso de ${v}`, dosis: (v) => `dosis de ${v} mSv`,
      solar: "evento de partículas solares", dentro: "estás dentro de la tormenta",
      alcanza: (m) => `la tormenta te alcanza en ${m}`, tormenta: (m) => `tormenta a ${m}`,
      sinRefugio: "ningún refugio alcanzable con margen", margenSolo: (m) => `margen de solo ${m}`, margen: (m) => `margen de ${m}`,
    },
    limites: { fatiga: "fatiga", tAlta: "temperatura alta", tBaja: "temperatura baja", spo2: "oxígeno en sangre", radiacion: "radiación" },
    viIrA: (auto, causa, ref, eta, sinMargen) => `${auto ? "Emergencia" : "De acuerdo"}: ${auto ? causa + ". " : ""}` +
      `Te llevo al ${refMin(ref)}, a ${eta} a pie. Sigue al holograma.` +
      (sinMargen ? " No llegas con margen a ningún refugio: baja el ritmo y aviso a la base." : ""),
    viPropuesta: (causa, ref, eta) => `Alerta: ${causa}. Te propongo ir al ${refMin(ref)}, a ${eta}. Pulsa A para aceptar.`,
    viPulso: (fc) => `Pulso alto: ${fc}. Baja el ritmo.`,
    viFatiga: (f) => `Fatiga al ${f} %. Haz pausas cortas y bebe agua.`,
    viTormentaRef: (tt, ref, eta) => `Tormenta de polvo a ${tt}. El refugio más cercano que sirve es el ${refMin(ref)}, a ${eta}.`,
    viMargen: (s, ref, eta) => `Tu tiempo seguro es de ${s}; el ${refMin(ref)} está a ${eta}. Conviene ir acercándote.`,
    viLlegada: (ref, motivo) => `Llegaste al ${refMin(ref)}. Estás a salvo: quédate aquí ${motivo}.`,
    viMotivo: { tormenta: "hasta que pase la tormenta", solar: "hasta que termine el evento solar", descanso: "y descansa hasta recuperarte" },
    viAvisoTormenta: (m) => `Aviso meteorológico: tormenta de polvo desde el noroeste. Te alcanza en unos ${m} minutos.`,
    viAvisoSolar: (m) => `Alerta de clima espacial: llamarada solar. Las partículas llegan en ${m} minutos. Busca refugio.`,
    viAgotamiento: "Detecto signos de agotamiento: pulso alto y fatiga en aumento.",
    viHipoxia: "Atención: tu oxígeno en sangre está bajando.",
  },

  en: {
    titulo: "PathFinder · Route viewer",
    menuSub: "Safe walking routes on Mars",
    menuIdioma: "Idioma · Language",
    menuCargando: "Loading terrain…",
    menuEmpezar: "Start",
    menuVoz: "Sherpa will talk to you in this language (text and voice).",
    cambiarIdioma: "Change language",
    errorTerreno: "Could not load the terrain. Is visor_rutas.py running?",
    panelSub: "Click on the terrain to place the points. The route recalculates automatically.",
    clicColoca: "Click places",
    btnInicio: "● Start", btnDestino: "● Destination",
    intercambiar: "Swap start and destination",
    pendMax: "Maximum slope (tolerance)",
    verProhibido: "Mark in red the areas steeper than the limit",
    exag: "Vertical exaggeration",
    polvoAire: "Airborne dust",
    alturaSol: "Sun elevation",
    remolinos: "Dust devils",
    capaGeo: "Geologic layer (USGS global map)",
    capaSuelo: "Soil type (THEMIS thermal inertia)",
    eligePuntos: "Choose the start and the destination.",
    recorrer: "▶ Walk the route", dejarRecorrer: "■ Stop walking",
    vistaGeneral: "Map overview", descargarCsv: "Download the route as CSV",
    ayudaOrbita: "<b>Explore:</b> drag to rotate, right-click to pan, wheel to zoom. <kbd>R</kbd> walks the route.",
    ayudaRuta: "<b>Walking:</b> wheel = zoom in/out · <kbd>Space</kbd> pause · <kbd>←</kbd><kbd>→</kbd> forward/back " +
      "(<kbd>Shift</kbd> = more) · <kbd>↑</kbd><kbd>↓</kbd> speed · <kbd>C</kbd> camera · drag to look around · " +
      "double-click recenters the view · <kbd>Esc</kbd> exit. In first person: <kbd>V</kbd> Sherpa's voice · <kbd>Tab</kbd> show this panel. " +
      "Simulate: <kbd>1</kbd> storm · <kbd>2</kbd> solar event · <kbd>3</kbd> fatigue · <kbd>4</kbd> low SpO₂ · " +
      "<kbd>0</kbd> reset · <kbd>A</kbd> accept the shelter route.",
    puntoInicio: (p) => `Start: ${p ?? "not chosen"}`,
    puntoDestino: (p) => `Destination: ${p ?? "not chosen"}`,
    fueraMapa: "That point is outside the map or has no data.",
    calculando: "Calculating route…",
    sinServidor: "Could not reach the server. Is visor_rutas.py still running?",
    rutaOk: (p) => `Route with a maximum slope of ${p}°`,
    rutaEmergencia: (ref) => `Emergency route to ${refMin(ref)}`,
    errFueraMapa: (q) => `The ${q === "inicio" ? "start" : "destination"} is outside the map.`,
    errSinDatos: (q) => `The ${q === "inicio" ? "start" : "destination"} is in an area with no data.`,
    errSinRuta: (p) => `There is no route with a maximum slope of ${p}°. Try raising the tolerance or moving the points ` +
      "(one of them may be surrounded by steep walls).",
    stDist: "Distance over terrain", stRecta: "Straight line", stDesvio: "Detour",
    stSubida: "Ascent / descent", stPend: "Max. / mean slope", stPie: "On foot (~1.2 m/s)",
    polvoNiv: ["Clear", "Some dust", "Haze", "Storm", "Great storm"],
    camaras: ["First person", "Chase", "Aerial"],
    altura: "elevation", pendiente: "slope", geologia: "geology", suelo: "soil", inercia: "inertia",
    inerciaEn: (u) => `Inertia in ${u}.`,
    delMapa: "% of the map",
    polvoSup: (nivel, emis, radio) => `Surface dust in the area: <b>${nivel}</b> (emissivity ${emis}, radius ${radio} km)`,
    tPlay: "Play / pause (Space)", tCamara: "Change camera (C)", tVel: "Speed (↑/↓)",
    tSalir: "Exit the walk (Esc)", tPerfil: "Click or drag to jump to a point on the route",
    simular: "Simulate:",
    evTormenta: "⛈ Storm", evSolar: "☢ Solar event", evFatiga: "♥ Fatigue",
    tTormenta: "Dust storm (1)", tSolar: "Solar particle event (2)", tFatiga: "Exhaustion (3)",
    tHipoxia: "Low blood oxygen (4)", tReiniciar: "Reset vitals and weather (0)",
    irRefugio: (ref) => `Go to ${refMin(ref)} (A)`,
    niveles: { normal: "Normal", precaucion: "Caution", alerta: "Alert", critico: "Critical" },
    vitLinea: (nivel, fc, seguro) => `<b>${nivel}</b> · ♥ ${fc} · safe time ${seguro}`,
    refA: (ref, eta) => `${nombreRef(ref)} in ${eta}`,
    preparando: (p, n) => `Preparing emergency routes (${p}/${n})…`,
    asistente: "route assistant", vozSi: "voice: on", vozNo: "voice: off",
    tVoz: "Turn the voice on or off (V)",
    enLinea: "Online · following the route",
    puntos: { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" },
    hRuta: "ROUTE", hRecorrido: "Covered", hRestante: "Remaining", hPie: "On foot", hAltitud: "Altitude",
    hPend: "Slope", hGeo: "Geology", hSuelo: "Soil",
    destinoAlcanzado: "Destination reached",
    sigue: (d) => `Follow the route · ${d}`,
    gira: (der, d) => `Turn ${der ? "right" : "left"} · ${d}`,
    avisoPend: (p, d) => `⚠ ${p}° slope in ${d}`,
    hEntorno: "ENVIRONMENT", hTempExt: "Outside temp.", hPolvo: "Dust",
    hVitales: "VITALS", hPulso: "Heart rate", lpm: "bpm", hEsfuerzo: "Effort", hTempCorp: "Body temp.",
    hFatiga: "Fatigue", hDosis: "Dose", hSeguro: "Safe time", limita: (x) => `limited by: ${x}`,
    hVasAl: "Heading to", hRefugio: "Shelter", aSalvo: "safe", hTormenta: "Storm", encima: "overhead",
    estNivel: { precaucion: "▲ CAUTION", alerta: "■ ALERT", critico: "■ EMERGENCY" },
    estEmergencia: (ref) => `■ EMERGENCY ROUTE → ${nombreRef(ref)}`,
    estSalvo: (ref) => `● SAFE AT ${nombreRef(ref).toUpperCase()}`,
    estPropuesta: (ref, eta) => ` · Go to ${refMin(ref)} (${eta}): press A`,
    relativo: { delante: "ahead of you", detras: "behind you", der: "to your right", izq: "to your left" },
    shHola: (d, tp) => `Hi, I'm Sherpa. I'll guide you along ${d} of route, about ${tp} on foot. Follow the hologram.`,
    shFin: "You have reached the destination. Good job.",
    shCasi: (refugio, d) => `The ${refugio ? "shelter" : "destination"} is ${d} away.`,
    shMitad: (d, tp) => `Halfway there. ${d} to go, about ${tp}.`,
    shHito: (h, d) => `You're at ${h} %. ${d} to go.`,
    shGiro: (d, der) => `In ${d}, turn ${der ? "right" : "left"}.`,
    shCuesta: (p, d) => `Caution: ${p}° section in ${d}. Shorten your stride.`,
    shTormentaVis: "Dust storm: visibility is low. Stay on the route.",
    shSolBajo: (tc) => `The sun is very low; the outside temperature is ${tc} °C.`,
    shRemolino: (d, rel) => `Dust devil ${d} away, ${rel}.`,
    shRecalculada: (d, p) => `Route recalculated: ${d} with a maximum slope of ${p}°.`,
    shGeo: (n, e) => `Geology: you're walking on the ${n}${e ? `, ${e}` : ""}.`,
    shGeoCambio: (n, e, i) => `According to the geologic map, the terrain changes here: you're entering the ${n}${e ? `, ${e}` : ""}. ` +
      `${i ? i + " " : ""}Good spot to take a sample.`,
    shSueltoAqui: (n) => `You're stepping on ${n}: risk of sinking. Short, firm steps.`,
    shSuelto: (n, d) => `${n.charAt(0).toUpperCase() + n.slice(1)} in ${d}: risk of sinking. Short, firm steps.`,
    shSuelo: (n) => `Soil: thermal inertia indicates ${n} under your feet.`,
    shPolvoSup: (nivel, txt) => ` Surface dust in the area is ${nivel}: ${txt}.`,
    shRoca: (n) => `You're on ${n}: firm footing. Exposed rock is a good spot to take a sample.`,
    causa: {
      fatiga: (v) => `fatigue at ${v} %`, temp: (v) => `body temperature of ${v} °C`,
      spo2: (v) => `blood oxygen at ${v} %`, fc: (v) => `heart rate of ${v}`, dosis: (v) => `dose of ${v} mSv`,
      solar: "solar particle event", dentro: "you are inside the storm",
      alcanza: (m) => `the storm reaches you in ${m}`, tormenta: (m) => `storm in ${m}`,
      sinRefugio: "no shelter reachable with margin", margenSolo: (m) => `only ${m} of margin`, margen: (m) => `${m} of margin`,
    },
    limites: { fatiga: "fatigue", tAlta: "high temperature", tBaja: "low temperature", spo2: "blood oxygen", radiacion: "radiation" },
    viIrA: (auto, causa, ref, eta, sinMargen) => `${auto ? "Emergency" : "Understood"}: ${auto ? causa + ". " : ""}` +
      `I'm taking you to ${refMin(ref)}, ${eta} on foot. Follow the hologram.` +
      (sinMargen ? " You can't reach any shelter with margin: slow down, I'm notifying base." : ""),
    viPropuesta: (causa, ref, eta) => `Alert: ${causa}. I suggest going to ${refMin(ref)}, ${eta} away. Press A to accept.`,
    viPulso: (fc) => `High heart rate: ${fc}. Slow down.`,
    viFatiga: (f) => `Fatigue at ${f} %. Take short breaks and drink water.`,
    viTormentaRef: (tt, ref, eta) => `Dust storm in ${tt}. The nearest suitable shelter is ${refMin(ref)}, ${eta} away.`,
    viMargen: (s, ref, eta) => `Your safe time is ${s}; ${refMin(ref)} is ${eta} away. You should start moving closer.`,
    viLlegada: (ref, motivo) => `You've reached ${refMin(ref)}. You're safe: stay here ${motivo}.`,
    viMotivo: { tormenta: "until the storm passes", solar: "until the solar event ends", descanso: "and rest until you recover" },
    viAvisoTormenta: (m) => `Weather alert: dust storm from the northwest. It will reach you in about ${m} minutes.`,
    viAvisoSolar: (m) => `Space weather alert: solar flare. The particles arrive in ${m} minutes. Seek shelter.`,
    viAgotamiento: "I'm detecting signs of exhaustion: high heart rate and rising fatigue.",
    viHipoxia: "Caution: your blood oxygen is dropping.",
  },
};
