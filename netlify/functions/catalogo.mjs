// Busca preço e estoque no Hiper (API da Loja Virtual) e devolve só o que o site precisa.
// A chave de segurança fica na variável de ambiente HIPER_CHAVE do Netlify e nunca vai para o navegador.
// A resposta fica em cache por 10 minutos, então o Hiper é consultado poucas vezes por hora.
const API = 'https://ms-ecommerce.hiper.com.br/api/v1';
const CACHE_SEGUNDOS = 600;

let token = null;
let tokenExpira = 0;

function expiracaoDoToken(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : Date.now() + 30 * 60 * 1000;
  } catch {
    return Date.now() + 30 * 60 * 1000;
  }
}

async function obterToken(forcar = false) {
  if (!forcar && token && Date.now() < tokenExpira - 60 * 1000) return token;
  const chave = (process.env.HIPER_CHAVE || '').trim();
  if (!chave) throw new Error('HIPER_CHAVE não configurada no Netlify');
  const r = await fetch(`${API}/auth/gerar-token/${encodeURIComponent(chave)}`);
  const d = await r.json().catch(() => ({}));
  // A mensagem de erro não inclui a URL, para a chave nunca aparecer em logs.
  if (!r.ok || !d.token) throw new Error(`Hiper recusou a chave (HTTP ${r.status}${d.message ? ': ' + d.message : ''})`);
  token = d.token;
  tokenExpira = expiracaoDoToken(token);
  return token;
}

async function chamar(caminho) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const r = await fetch(API + caminho, { headers: { Authorization: `Bearer ${await obterToken(tentativa > 0)}` } });
    if (r.status === 401) continue; // token vencido: gera outro e tenta de novo
    if (r.status === 429) { await new Promise(ok => setTimeout(ok, 1000 * 2 ** tentativa)); continue; }
    if (!r.ok) throw new Error(`Hiper respondeu HTTP ${r.status} em ${caminho.split('?')[0]}`);
    return r.json();
  }
  throw new Error(`Hiper não respondeu em ${caminho.split('?')[0]}`);
}

// A documentação não mostra o envelope da listagem: aceita lista direta ou lista dentro de um campo.
function extrairLista(d) {
  if (Array.isArray(d)) return d;
  for (const k of ['produtos', 'itens', 'data', 'resultado', 'lista']) if (Array.isArray(d?.[k])) return d[k];
  const arr = d && Object.values(d).find(Array.isArray);
  return arr || [];
}

const titulo = s => String(s || '').toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()).trim();

function resumir(p) {
  // Nome do Hiper como "ARROZ X 30X1KG": separa a embalagem do fim, para produtos novos ainda sem cadastro no site.
  const nomeHiper = String(p.nome || '');
  const e = nomeHiper.match(/\s(\d+X\d+(?:,\d+)?\s*(?:KG|G|ML|L|UN|UND)?|\d+(?:,\d+)?\s*(?:KG|G|ML|L))$/i);
  const preco = Number(p.preco);
  const faixas = p.atacadoAtivo && Array.isArray(p.precoAtacado?.precos)
    ? p.precoAtacado.precos
        .map(f => ({ qtd: Number(f.quantidade), preco: Number(f.precoUnitario) }))
        .filter(f => f.qtd > 1 && f.preco > 0)
        .sort((a, b) => a.qtd - b.qtd)
    : [];
  return {
    cod: String(p.codigo),
    nome: titulo(e ? nomeHiper.slice(0, e.index) : nomeHiper),
    emb: e ? e[1].toLowerCase().replace(/l$/, 'L') : '',
    preco: Number.isFinite(preco) && preco > 0 ? preco : null,
    disp: Number(p.quantidadeEmEstoque) > 0, // a quantidade não sai daqui, só se tem ou não
    ...(faixas.length ? { atacado: faixas } : {}),
  };
}

export async function buscarCatalogo() {
  const todos = [];
  const vistos = new Set();
  for (let pagina = 1; pagina <= 100; pagina++) {
    const lista = extrairLista(await chamar(`/produtos/listagemDeProdutos?pontoDeSincronizacao=0&pagina=${pagina}`));
    const novos = lista.filter(p => p && p.codigo != null && !vistos.has(p.id || p.codigo));
    if (!novos.length) break; // fim das páginas (ou a API repetiu a última página)
    novos.forEach(p => vistos.add(p.id || p.codigo));
    todos.push(...novos);
  }
  return todos.filter(p => p.ativo !== false && p.removido !== true).map(resumir);
}

export default async () => {
  try {
    const produtos = await buscarCatalogo();
    return new Response(JSON.stringify({ atualizado: new Date().toISOString(), produtos }), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=0, must-revalidate',
        'Netlify-CDN-Cache-Control': `public, durable, s-maxage=${CACHE_SEGUNDOS}, stale-while-revalidate=3600`,
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ erro: e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
};

export const config = { path: '/api/catalogo' };
