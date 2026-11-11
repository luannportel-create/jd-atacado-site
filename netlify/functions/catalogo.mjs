// Busca preço e estoque no Hiper (API da Loja Virtual) e devolve só o que o site precisa.
// A chave de segurança fica na variável de ambiente HIPER_CHAVE do Netlify e nunca vai para o navegador.
// A resposta fica em cache por 10 minutos, então o Hiper é consultado poucas vezes por hora.
const API = 'https://ms-ecommerce.hiper.com.br/api/v1';
const CACHE_SEGUNDOS = 600;
// Cadastros internos do Hiper que não são produtos de venda.
const IGNORAR = new Set(['3002']);

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

class ErroHiper extends Error {
  constructor(status, caminho, detalhe) {
    super(`Hiper respondeu HTTP ${status} em ${caminho.split('?')[0]}${detalhe ? ': ' + detalhe : ''}`);
    this.status = status;
  }
}

// Mensagem que o Hiper devolve no erro (campos "message"/"errors"), sem dados sensíveis.
async function detalheDoErro(r) {
  const t = await r.text().catch(() => '');
  try {
    const d = JSON.parse(t);
    const partes = [d.message, d.title, ...(Array.isArray(d.errors) ? d.errors : d.errors ? Object.values(d.errors).flat() : [])]
      .filter(Boolean).map(x => typeof x === 'string' ? x : JSON.stringify(x));
    return partes.join(' | ').slice(0, 300);
  } catch {
    return t.slice(0, 200);
  }
}

async function chamar(caminho) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const r = await fetch(API + caminho, { headers: { Authorization: `Bearer ${await obterToken(tentativa > 0)}` } });
    if (r.status === 401) continue; // token vencido: gera outro e tenta de novo
    if (r.status === 429) { await new Promise(ok => setTimeout(ok, 1000 * 2 ** tentativa)); continue; }
    if (!r.ok) throw new ErroHiper(r.status, caminho, await detalheDoErro(r));
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
        .filter(f => f.qtd > 1 && f.preco > 0 && f.preco < preco && f.preco >= preco * 0.5) // trava: ignora desconto acima de 50% (provável erro de cadastro)
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

async function listarPaginado() {
  const todos = [];
  const vistos = new Set();
  for (let pagina = 1; pagina <= 100; pagina++) {
    let lista;
    try {
      lista = extrairLista(await chamar(`/produtos/listagemDeProdutos?pontoDeSincronizacao=0&pagina=${pagina}`));
    } catch (e) {
      if (pagina > 1 && e.status === 400) break; // o Hiper responde 400 quando a página não existe
      throw e;
    }
    const novos = lista.filter(p => p && p.codigo != null && !vistos.has(p.id || p.codigo));
    if (!novos.length) break; // fim das páginas (ou a API repetiu a última página)
    novos.forEach(p => vistos.add(p.id || p.codigo));
    todos.push(...novos);
  }
  return todos;
}

export async function buscarCatalogo() {
  let todos;
  try {
    todos = await listarPaginado();
  } catch (e) {
    // Reserva: rota de sincronização (sem preços de atacado por faixa).
    if (e.status !== 400 && e.status !== 404) throw e;
    try {
      todos = extrairLista(await chamar('/produtos/pontoDeSincronizacao?pontoDeSincronizacao=0'));
    } catch (e2) {
      throw new Error(`${e.message} || reserva: ${e2.message}`);
    }
  }
  return todos
    .filter(p => p.ativo !== false && p.removido !== true && !IGNORAR.has(String(p.codigo)))
    .map(resumir);
}

// /api/catalogo?diag=1 mostra só a estrutura das respostas do Hiper (sem preços, estoque ou chave).
async function diagnostico() {
  const out = {};
  const forma = d => Array.isArray(d)
    ? { tipo: 'lista', itens: d.length, campos: d[0] ? Object.keys(d[0]) : [] }
    : { tipo: 'objeto', campos: Object.keys(d || {}), listas: Object.fromEntries(Object.entries(d || {}).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, { itens: v.length, campos: v[0] ? Object.keys(v[0]) : [] }])) };
  try { await obterToken(true); out.token = 'ok'; } catch (e) { out.token = e.message; return out; }
  for (const c of ['/produtos/listagemDeProdutos?pontoDeSincronizacao=0&pagina=1', '/produtos/listagemDeProdutos?pontoDeSincronizacao=0&pagina=0', '/produtos/pontoDeSincronizacao?pontoDeSincronizacao=0']) {
    try { out[c] = forma(await chamar(c)); } catch (e) { out[c] = e.message; }
  }
  return out;
}

// /api/catalogo?cod=3003 consulta um produto direto no Hiper, sem cache: compara o estoque da listagem
// com o da rota de estoque, para achar onde a mudança não chegou.
async function diagnosticoProduto(cod) {
  const out = { cod, consultadoEm: new Date().toISOString() };
  try {
    const todos = await listarPaginado();
    const p = todos.find(x => String(x.codigo) === cod);
    if (!p) return { ...out, listagem: 'produto não encontrado na listagem da Loja Virtual' };
    out.listagem = { nome: p.nome, ativo: p.ativo, removido: p.removido, preco: p.preco, quantidadeEmEstoque: p.quantidadeEmEstoque, quantidadeEmEstoqueReservado: p.quantidadeEmEstoqueReservado };
    try {
      const e = await chamar(`/estoques/pontoDeSincronizacao?ProdutoId=${encodeURIComponent(p.id)}`);
      out.rotaDeEstoque = { quantidadeEmEstoque: e.quantidadeEmEstoque, pontoDeSincronizacao: e.pontoDeSincronizacao };
    } catch (e) { out.rotaDeEstoque = e.message; }
  } catch (e) { out.erro = e.message; }
  return out;
}

export default async (req) => {
  const cod = new URL(req.url).searchParams.get('cod');
  if (cod && /^\d{1,10}$/.test(cod)) {
    return new Response(JSON.stringify(await diagnosticoProduto(cod), null, 1), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store' } });
  }
  if (new URL(req.url).searchParams.get('diag') === '1') {
    return new Response(JSON.stringify(await diagnostico(), null, 1), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
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
