// hermeticidad.test -- WHAT: el proyecto es atómico y hermético.
// Nada de lo versionado depende de otra carpeta local: ni rutas absolutas a carpetas de trabajo
// de la máquina (VPS, Dev, ContaPyme, PatyIA, Users), ni rutas relativas que salgan del proyecto,
// ni dependencias file:/link:, ni submódulos por ruta local, ni symlinks. Lo que se consume de
// otro proyecto llega como vendor descargado de un CDN fijado a SHA.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
// Excepciones explícitas (ruta o prefijo de carpeta), cada una con su motivo.
const IGNORAR = [];

// Raíces de trabajo locales: un proyecto nunca debe nombrarlas.
const ABSOLUTA = /(?<![\w.])(?:[A-Za-z]:(?:\\\\|\\|\/\/?)(?:VPS|Dev|ContaPyme[\w-]*|PatyIA|Users)(?![\w-])|\/(?:mnt\/)?[cdCD]\/(?:VPS|Dev|ContaPyme[\w-]*|PatyIA|Users)(?![\w-]))/g;
// Cadenas relativas ('../x', "..\\x", `../x`) y enlaces markdown ](../x).
const RELATIVA = /(['"`])((?:\.\.(?:\/|\\\\|\\))+[^'"`\s]*)\1|\]\(((?:\.\.\/)+[^)\s]*)\)/g;
// Segmentos de subida encadenados como argumentos de join/resolve.
const SEGMENTOS = /(['"])\.\.\1(?:\s*,\s*(['"])\.\.\2)+/g;
// Dependencias por ruta local en manifiestos.
const DEP_LOCAL = /"(?:file|link|portal):(?!\/\/)[^"]*"/g;

function archivosVersionados(raiz) {
  try {
    const out = execFileSync('git', ['ls-files', '-s', '-z'], { cwd: raiz, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\0').filter(Boolean).map((l) => {
      const [meta, ruta] = l.split('\t');
      return { modo: meta.split(' ')[0], ruta };
    });
  } catch {
    const lista = [];
    const andar = (rel) => {
      for (const n of readdirSync(join(raiz, rel), { withFileTypes: true })) {
        if (n.name === 'node_modules' || n.name === '.git' || n.name.startsWith('.tmp')) continue;
        const r = rel ? rel + '/' + n.name : n.name;
        if (n.isSymbolicLink()) lista.push({ modo: '120000', ruta: r });
        else if (n.isDirectory()) andar(r);
        else lista.push({ modo: '100644', ruta: r });
      }
    };
    andar('');
    return lista;
  }
}

/**
 * Violaciones de hermeticidad (archivo:línea + motivo) en lo versionado del proyecto `raiz`:
 * rutas absolutas a carpetas de trabajo locales, rutas relativas que salen del proyecto hacia
 * algo que no existe dentro, dependencias `file:`/`link:`, submódulos por ruta local y symlinks.
 */
function revisarHermeticidad(raiz, ignorar = []) {
  const violaciones = [];
  const archivos = archivosVersionados(raiz);
  // Sufijos de todo lo versionado: una URL relativa que "sube" pero cuyo destino existe dentro
  // del proyecto (p. ej. '../../components/x.js' servido desde dist/cdn/) es interna.
  const sufijos = new Set();
  for (const { ruta } of archivos) {
    const partes = ruta.split('/');
    for (let i = 0; i < partes.length; i++) {
      for (let j = i + 1; j <= partes.length; j++) sufijos.add(partes.slice(i, j).join('/'));
    }
  }
  const interna = (rel) => {
    const cola = rel.replace(/^(?:\.\.\/)+/, '').split(/[?#$<*{]/)[0].replace(/\/+$/, '').replace(/\/[^/]*\.\.\.$|\.\.\.$/, '');
    if (cola === '' || cola === '.' || sufijos.has(cola)) return true;
    // el fuente puede versionarse con otra extensión que la servida (.ts → .js, .scss → .css)
    const base = cola.replace(/\.(?:min\.)?(js|mjs|css)$/, '');
    return base !== cola && ['.ts', '.mts', '.js', '.mjs', '.min.js', '.scss', '.css', '.min.css'].some((x) => sufijos.has(base + x));
  };
  const ignorado = (ruta) => ignorar.some((p) => (p instanceof RegExp ? p.test(ruta) : ruta === p || ruta.startsWith(p.endsWith('/') ? p : p + '/')));
  for (const { modo, ruta } of archivos) {
    if (ignorado(ruta)) continue;
    if (modo === '120000') { violaciones.push(ruta + ': symlink'); continue; }
    if (modo === '160000') continue; // submódulo: otro proyecto, se valida en su propio repo
    let buf;
    try {
      if (statSync(join(raiz, ruta)).size > 8 * 1024 * 1024) continue;
      buf = readFileSync(join(raiz, ruta));
    } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue; // binario
    const texto = buf.toString('utf8');
    const dir = posix.dirname(ruta);
    texto.split('\n').forEach((linea, i) => {
      const donde = ruta + ':' + (i + 1);
      for (const m of linea.matchAll(ABSOLUTA)) violaciones.push(donde + ': ruta absoluta ' + m[0]);
      for (const m of linea.matchAll(RELATIVA)) {
        const rel = (m[2] ?? m[3]).replace(/\\\\|\\/g, '/');
        if (posix.normalize(posix.join(dir, rel)).startsWith('..') && !interna(rel)) violaciones.push(donde + ': sale del proyecto ' + rel);
      }
      // join(aqui, <dos puntos>, <dos puntos>…): más subidas que la profundidad del archivo sale del proyecto.
      const profundidad = dir === '.' ? 0 : dir.split('/').length;
      for (const m of linea.matchAll(SEGMENTOS)) {
        const n = m[0].match(/\.\./g).length;
        if (n > profundidad) violaciones.push(donde + ": sale del proyecto ('..' x" + n + ')');
      }
      if (/(^|\/)(package\.json|deno\.jsonc?)$/.test(ruta)) {
        for (const m of linea.matchAll(DEP_LOCAL)) violaciones.push(donde + ': dependencia local ' + m[0]);
      }
    });
    if (ruta === '.gitmodules') {
      for (const m of texto.matchAll(/url\s*=\s*(\S+)/g)) {
        if (!/^(https?:\/\/|git@|ssh:\/\/)/.test(m[1])) violaciones.push('.gitmodules: submódulo por ruta local ' + m[1]);
      }
    }
  }
  return violaciones;
}

Deno.test('hermeticidad: nada versionado referencia rutas fuera del proyecto', () => {
  const v = revisarHermeticidad(RAIZ, IGNORAR);
  if (v.length) throw new Error(v.length + ' referencia(s) fuera del proyecto:\n' + v.slice(0, 50).join('\n'));
});
