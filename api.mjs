// Frizz live - IA y búsqueda para Netlify (un solo archivo).
// La clave OPENAI_API_KEY va en Netlify > Site configuration > Environment variables.

// Núcleo de Frizz live: búsqueda web + respuestas cortas de IA (OpenAI).
// Lo usan server.js (Render o tu compu) y netlify/functions/api.mjs (Netlify).
// Sin dependencias: solo necesita Node 18 o más. Todas las claves viven aquí,
// en variables de entorno, y nunca se envían a la página.

const E = process.env;
const OPENAI_KEY = E.OPENAI_API_KEY;
const OPENAI_MODEL = E.OPENAI_MODEL || "gpt-4o-mini";  // barato y predecible; cámbialo si OpenAI renombra modelos
// ---- ahorro de saldo (todo se puede cambiar con variables en Render) ----
const IA_MAX_TOKENS = Number(E.IA_MAX_TOKENS) || 120;          // largo máximo de cada respuesta (~80 palabras)
const IA_LIMITE_DIARIO = Number(E.IA_LIMITE_DIARIO) || 300;    // preguntas a la IA por día, entre todos
const IA_LIMITE_IP_DIA = Number(E.IA_LIMITE_IP_DIA) || 30;     // preguntas a la IA por día, por persona
const OPENAI_REASONING = E.OPENAI_REASONING || "";             // solo para modelos que razonan (ej. "minimal")
const GOOGLE_KEY = E.GOOGLE_API_KEY, GOOGLE_CX = E.GOOGLE_CX; // Programmable Search Engine
const BRAVE_KEY = E.BRAVE_API_KEY;                      // alternativa: Brave Search API
const ORIGEN = E.ALLOWED_ORIGIN || "";                 // ej. https://frizzlive.netlify.app (o * para pruebas)

// ---------- utilidades ----------
const limpiar = s => String(s || "").replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const httpsUrl = u => { try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : ""; } catch { return ""; } };
const golpes = new Map(); // límite por IP: 20 peticiones por minuto
function limitado(ip) {
  const t = Date.now(), l = (golpes.get(ip) || []).filter(x => t - x < 60_000);
  l.push(t); golpes.set(ip, l);
  if (golpes.size > 5000) golpes.clear();
  return l.length > 20;
}

// ---------- memoria (caché) y presupuesto diario ----------
// Si alguien repite una pregunta en 24 h, se responde gratis desde la memoria.
const CACHE = new Map(), DIA_MS = 86_400_000;
const llave = (tipo, q) => tipo + "|" + q.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[¿?¡!.,;:]/g, "").replace(/\s+/g, " ").trim();
function deCache(k) { const v = CACHE.get(k); if (v && Date.now() - v.t < DIA_MS) return v.d; CACHE.delete(k); return undefined; }
function aCache(k, d) { if (CACHE.size > 1000) CACHE.delete(CACHE.keys().next().value); CACHE.set(k, { t: Date.now(), d }); }
const hoy = () => new Date().toISOString().slice(0, 10);
const USO = { dia: hoy(), ia: 0, tokens: 0, porIp: new Map() };
function puedeIA(ip) {
  if (USO.dia !== hoy()) { USO.dia = hoy(); USO.ia = 0; USO.tokens = 0; USO.porIp.clear(); }
  if (USO.ia >= IA_LIMITE_DIARIO) return "La IA ya respondió el máximo de preguntas de hoy. Mira la información verificada de abajo.";
  if ((USO.porIp.get(ip) || 0) >= IA_LIMITE_IP_DIA) return "Ya hiciste muchas preguntas a la IA hoy. Mira la información verificada de abajo.";
  return "";
}
function contarIA(ip, tokens) { USO.ia++; USO.tokens += tokens || 0; USO.porIp.set(ip, (USO.porIp.get(ip) || 0) + 1); }
// Enlaces a información verificada para quien quiera más detalle.
const verificar = q => [
  { titulo: "Wikipedia", url: "https://es.wikipedia.org/w/index.php?search=" + encodeURIComponent(q) },
  { titulo: "Google", url: "https://www.google.com/search?q=" + encodeURIComponent(q) },
];

// ---------- búsqueda web ----------
async function buscarWeb(q) {
  if (GOOGLE_KEY && GOOGLE_CX) {
    const u = new URL("https://www.googleapis.com/customsearch/v1");
    u.search = new URLSearchParams({ key: GOOGLE_KEY, cx: GOOGLE_CX, q, num: "8", hl: "es", lr: "lang_es" });
    const r = await fetch(u);
    if (!r.ok) throw new Error("Google " + r.status + " " + (await r.text()).slice(0, 200));
    const j = await r.json();
    return (j.items || []).map(i => ({ titulo: limpiar(i.title), url: httpsUrl(i.link), sitio: limpiar(i.displayLink), resumen: limpiar(i.snippet) })).filter(x => x.url);
  }
  if (BRAVE_KEY) {
    const u = new URL("https://api.search.brave.com/res/v1/web/search");
    u.search = new URLSearchParams({ q, count: "8", search_lang: "es", country: "mx" });
    const r = await fetch(u, { headers: { "X-Subscription-Token": BRAVE_KEY, Accept: "application/json" } });
    if (!r.ok) throw new Error("Brave " + r.status + " " + (await r.text()).slice(0, 200));
    const j = await r.json();
    return (j.web?.results || []).map(i => ({ titulo: limpiar(i.title), url: httpsUrl(i.url), sitio: limpiar(i.meta_url?.hostname || new URL(i.url).hostname), resumen: limpiar(i.description) })).filter(x => x.url);
  }
  const e = new Error("Falta configurar la búsqueda web (GOOGLE_API_KEY y GOOGLE_CX, o BRAVE_API_KEY).");
  e.codigo = "sin_busqueda";
  throw e;
}

// ---------- IA (OpenAI) ----------
async function preguntarIA(pregunta, resultados) {
  if (!OPENAI_KEY) { const e = new Error("Falta OPENAI_API_KEY."); e.codigo = "sin_ia"; throw e; }
  // Instrucciones cortas = menos tokens en cada pregunta.
  let sistema = "Asistente de Frizz live para estudiantes. Responde en español en máximo 2 oraciones (50 palabras), directo, sin saludos ni relleno. No inventes; si no sabes, dilo. Si la pregunta pide algo largo (ensayo, tarea completa, explicación detallada, pasos), da solo 1 oración de resumen y termina con [MAS].";
  let usuario = pregunta;
  if (resultados && resultados.length) {
    sistema += " Usa solo los resultados numerados y cita con [1], [2].";
    usuario = "Pregunta: " + pregunta + "\nResultados:\n" + resultados.map((r, i) => `[${i + 1}] ${String(r.titulo).slice(0, 90)}: ${String(r.resumen).slice(0, 220)}`).join("\n");
  }
  const cuerpo = { model: OPENAI_MODEL, max_completion_tokens: IA_MAX_TOKENS, messages: [{ role: "system", content: sistema }, { role: "user", content: usuario }] };
  if (OPENAI_REASONING) cuerpo.reasoning_effort = OPENAI_REASONING;
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + OPENAI_KEY },
    body: JSON.stringify(cuerpo),
  });
  if (!r.ok) throw new Error("OpenAI " + r.status + " " + (await r.text()).slice(0, 200));
  const j = await r.json();
  let texto = String(j.choices?.[0]?.message?.content || "").trim();
  const masDetalle = /\[MAS\]/i.test(texto) || j.choices?.[0]?.finish_reason === "length";
  texto = texto.replace(/\s*\[MAS\]\s*/gi, " ").trim();
  return { texto, masDetalle, tokens: j.usage?.total_tokens || 0 };
}

// ---------- rutas ----------
export async function manejar(ruta, metodo, leer, ip) {
  const R = (status, body) => ({ status, body });
  if (ruta === "/api/salud") return R(200, { frizz: true, web: !!((GOOGLE_KEY && GOOGLE_CX) || BRAVE_KEY), ia: !!OPENAI_KEY, hoy: { preguntasIA: USO.dia === hoy() ? USO.ia : 0, limite: IA_LIMITE_DIARIO, tokens: USO.dia === hoy() ? USO.tokens : 0 } });
  if (metodo !== "POST") return R(405, { error: "Usa POST" });
  ip = ip || "?";
  if (limitado(ip)) return R(429, { error: "Demasiadas preguntas seguidas. Espera un momento." });
  let b; try { b = await leer(); } catch { return R(400, { error: "Petición inválida" }); }
  const q = String(b.q ?? b.mensaje ?? "").trim().slice(0, 200);
  if (!q) return R(400, { error: "Escribe algo para buscar" });
  const salida = { q, verificar: verificar(q) };
  // Web con memoria de 24 h (ahorra cuota de Google/Brave).
  async function web() {
    const k = llave("web", q), c = deCache(k);
    if (c) return c;
    const w = await buscarWeb(q); aCache(k, w); return w;
  }
  // IA con memoria de 24 h y límites diarios (cuida tu saldo).
  async function ia(contexto) {
    const k = llave(contexto && contexto.length ? "ia+web" : "ia", q), c = deCache(k);
    if (c) return Object.assign({ cache: true }, c);
    const alto = puedeIA(ip); if (alto) { const e = new Error(alto); e.limite = true; throw e; }
    const r = await preguntarIA(q, contexto);
    contarIA(ip, r.tokens); console.log(`[IA] ${USO.dia} preguntas=${USO.ia} tokens=${USO.tokens}`);
    const d = { respuesta: r.texto, masDetalle: r.masDetalle }; aCache(k, d); return d;
  }
  const errIA = e => (e.limite ? e.message : e_publico(e.message));
  try {
    if (ruta === "/api/buscar") {
      salida.web = await web();
    } else if (ruta === "/api/ia" || ruta === "/api/chat") {
      const r = await ia(null);
      salida.respuesta = r.respuesta; salida.masDetalle = r.masDetalle;
      if (ruta === "/api/chat") salida.fuentes = salida.verificar;  // el asistente muestra estos enlaces
    } else if (ruta === "/api/todo") {
      // Primero la web; la IA responde corto apoyada en esos resultados reales.
      let w = [], errWeb = "";
      try { w = await web(); } catch (e) { if (e.codigo === "sin_busqueda") salida.sinWeb = true; else { errWeb = e.message; console.error(e.message); } }
      salida.web = w;
      if (errWeb) salida.errorWeb = e_publico(errWeb);
      try { const r = await ia(w.slice(0, 3)); salida.respuesta = r.respuesta; salida.masDetalle = r.masDetalle; }
      catch (e) { if (!e.limite) console.error(e.message); salida.errorIA = errIA(e); }
      if (!w.length && !salida.respuesta) return R(502, { error: salida.errorWeb || salida.errorIA || "Sin resultados", verificar: salida.verificar });
    } else return R(404, { error: "No existe" });
    return R(200, salida);
  } catch (e) {
    if (!e.limite) console.error(e.message);
    return R(e.limite ? 429 : e.codigo ? 503 : 502, { error: errIA(e), verificar: salida.verificar });
  }
}
// Nunca devuelve detalles internos (ni claves) a la página.
function e_publico(m) {
  if (/Falta/.test(m)) return m;
  if (/^(Google|Brave) /.test(m)) return "La búsqueda web no respondió. Revisa la clave y el saldo o cuota del servicio.";
  if (/^OpenAI /.test(m)) return "La IA no respondió. Revisa la clave y el saldo de OpenAI.";
  return "No se pudo completar la solicitud.";
}


// Función de Netlify: responde /api/* en el mismo sitio donde está tu página.
// La clave OPENAI_API_KEY se guarda en Netlify (Site configuration > Environment variables),
// nunca en index.html.

export default async (req, context) => {
  const ruta = new URL(req.url).pathname;
  const ip = (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "?";
  const leer = async () => {
    const t = await req.text();
    if (t.length > 10_000) throw new Error("grande");
    return t ? JSON.parse(t) : {};
  };
  try {
    const r = await manejar(ruta, req.method, leer, ip);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json; charset=utf-8" } });
  } catch (e) {
    console.error(e);
    return new Response(JSON.stringify({ error: "Error del servidor" }), { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } });
  }
};

export const config = { path: "/api/*" };
