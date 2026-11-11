// Busca preço e estoque no Hiper (API da Loja Virtual) e devolve só o que o site precisa.
// A resposta fica em cache por 10 minutos, então o Hiper é consultado poucas vezes por hora.
import { buscarCatalogo, chamar, disponivel, extrairLista, listarPaginado, obterToken } from '../lib/hiper.mjs';

const CACHE_SEGUNDOS = 600;

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
    out.listagem = { nome: p.nome, ativo: p.ativo, removido: p.removido, preco: p.preco, quantidadeEmEstoque: p.quantidadeEmEstoque, quantidadeEmEstoqueReservado: p.quantidadeEmEstoqueReservado, disponivel: disponivel(p) };
    try {
      const e = await chamar(`/estoques/pontoDeSincronizacao?ProdutoId=${encodeURIComponent(p.id)}`);
      out.rotaDeEstoque = { quantidadeEmEstoque: e.quantidadeEmEstoque, quantidadeEmEstoqueReservado: e.quantidadeEmEstoqueReservado, disponivel: disponivel(e), pontoDeSincronizacao: e.pontoDeSincronizacao };
      out.siteMostra = disponivel(e) > 0 ? 'disponível' : 'fora de estoque';
    } catch (e) { out.rotaDeEstoque = e.message; }
  } catch (e) { out.erro = e.message; }
  return out;
}

export default async (req, context) => {
  // Diagnósticos mostram quantidade em estoque: só funcionam na prévia, nunca no site oficial.
  const diagLiberado = context?.deploy?.context !== 'production';
  const cod = new URL(req.url).searchParams.get('cod');
  if (diagLiberado && cod && /^\d{1,10}$/.test(cod)) {
    return new Response(JSON.stringify(await diagnosticoProduto(cod), null, 1), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Netlify-CDN-Cache-Control': 'no-store' } });
  }
  if (diagLiberado && new URL(req.url).searchParams.get('diag') === '1') {
    return new Response(JSON.stringify(await diagnostico(), null, 1), { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  try {
    const inicio = Date.now();
    const { produtos, semConferir } = await buscarCatalogo(inicio);
    return new Response(JSON.stringify({ atualizado: new Date().toISOString(), tempoMs: Date.now() - inicio, semConferir, produtos }), {
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
