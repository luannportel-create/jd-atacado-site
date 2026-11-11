// Cria o pedido de venda no Hiper a partir do carrinho do site (POST /api/pedido).
// O navegador manda só código e quantidade; o preço é recalculado aqui com os dados do Hiper,
// então ninguém consegue mandar um pedido com preço alterado.
// O pedido entra em aberto (não faturado): a equipe confere estoque, frete e pagamento antes de faturar.
import { IGNORAR, chamar, listarPaginado, precoParaQuantidade } from '../lib/hiper.mjs';

// Formas de pagamento aceitas no site → código do meio de pagamento no Hiper.
export const PAGAMENTOS = {
  pix: { id: 12, nome: 'PIX' },
  dinheiro: { id: 1, nome: 'Dinheiro' },
  cartao_debito: { id: 5, nome: 'Cartão de débito' },
  cartao_credito: { id: 4, nome: 'Cartão de crédito' },
  crediario: { id: 6, nome: 'Boleto / crediário (sujeito a aprovação)' },
};

const so = s => String(s || '').replace(/\D/g, '');
const texto = (s, max) => String(s || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

export function documentoValido(doc) {
  const d = so(doc);
  if (d.length === 11) {
    if (/^(\d)\1+$/.test(d)) return false;
    const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
    return dv(9) === +d[9] && dv(10) === +d[10];
  }
  if (d.length === 14) {
    if (/^(\d)\1+$/.test(d)) return false;
    const dv = n => { const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = w.reduce((a, x, i) => a + x * +d[i], 0); const r = s % 11; return r < 2 ? 0 : 11 - r; };
    return dv(12) === +d[12] && dv(13) === +d[13];
  }
  return false;
}

// Limite simples contra envio em massa: 5 pedidos por IP a cada 10 minutos (por instância da função).
const envios = new Map();
function limiteAtingido(ip) {
  const agora = Date.now();
  const lista = (envios.get(ip) || []).filter(t => agora - t < 10 * 60 * 1000);
  if (lista.length >= 5) return true;
  lista.push(agora);
  envios.set(ip, lista);
  return false;
}

const resposta = (status, corpo) => new Response(JSON.stringify(corpo), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

// Valida o que veio do navegador e monta o pedido no formato do Hiper, com preços do Hiper.
export function montarPedido(dados, produtosHiper) {
  if (texto(dados.site, 50)) return { erro: 'Pedido recusado.' }; // campo-isca: só robôs preenchem
  const nome = texto(dados.nome, 80);
  const estabelecimento = texto(dados.estabelecimento, 80);
  const telefone = so(dados.telefone).slice(0, 13);
  const municipio = texto(dados.municipio, 60);
  const obs = texto(dados.obs, 400);
  const numero = texto(dados.numero, 30).replace(/[^\w-]/g, '');
  const pagamento = PAGAMENTOS[dados.pagamento];
  if (!nome) return { erro: 'Informe o nome do responsável.' };
  if (!documentoValido(dados.documento)) return { erro: 'CNPJ ou CPF inválido.' };
  if (telefone.length < 10) return { erro: 'Informe o telefone com DDD.' };
  if (!municipio) return { erro: 'Informe o município.' };
  if (!pagamento) return { erro: 'Escolha a forma de pagamento.' };
  if (!Array.isArray(dados.itens) || !dados.itens.length || dados.itens.length > 80) return { erro: 'Pedido sem itens.' };

  const porCodigo = new Map(produtosHiper
    .filter(p => p.ativo !== false && p.removido !== true && !IGNORAR.has(String(p.codigo)))
    .map(p => [String(p.codigo), p]));
  const itens = [];
  for (const it of dados.itens) {
    const p = porCodigo.get(String(it.cod));
    const qtd = Number(it.qtd);
    if (!p) return { erro: `Produto ${texto(it.cod, 10)} não está mais disponível no catálogo.` };
    if (!Number.isInteger(qtd) || qtd < 1 || qtd > 999) return { erro: 'Quantidade inválida.' };
    const preco = precoParaQuantidade(p, qtd);
    if (!(preco > 0)) return { erro: `${p.nome} está sem preço; consulte pelo WhatsApp.` };
    itens.push({ produtoId: p.id, quantidade: qtd, precoUnitarioBruto: preco, precoUnitarioLiquido: preco, _cod: String(p.codigo) });
  }
  const total = Math.round(itens.reduce((s, i) => s + i.quantidade * i.precoUnitarioLiquido, 0) * 100) / 100;

  const observacao = [
    `Pedido pelo site ${numero}`.trim(),
    `Tel: ${telefone}`,
    `Município: ${municipio}`,
    estabelecimento && `Estabelecimento: ${estabelecimento}`,
    `Pagamento: ${pagamento.nome}`,
    obs && `Obs: ${obs}`,
  ].filter(Boolean).join(' | ');

  return {
    total,
    itens: itens.map(({ _cod, ...i }) => ({ ...i, cod: _cod })),
    pedido: {
      cliente: {
        documento: so(dados.documento),
        email: '',
        inscricaoEstadual: '',
        nomeDoCliente: estabelecimento || nome,
        nomeFantasia: estabelecimento,
      },
      itens: itens.map(({ _cod, ...i }) => i),
      meiosDePagamento: [{ idMeioDePagamento: pagamento.id, parcelas: 1, valor: total }],
      numeroPedidoDeVenda: numero,
      observacaoDoPedidoDeVenda: observacao.slice(0, 500),
      valorDoFrete: 0,
    },
  };
}

export default async (req, context) => {
  if (req.method !== 'POST') return resposta(405, { erro: 'Use POST.' });
  if (limiteAtingido(context?.ip || 'sem-ip')) return resposta(429, { erro: 'Muitos pedidos em sequência. Aguarde alguns minutos ou fale pelo WhatsApp.' });
  let dados;
  try { dados = await req.json(); } catch { return resposta(400, { erro: 'Pedido inválido.' }); }
  try {
    const montado = montarPedido(dados, await listarPaginado());
    if (montado.erro) return resposta(400, { erro: montado.erro });
    const r = await chamar('/pedido-de-venda/', { metodo: 'POST', corpo: montado.pedido });
    if (r?.errors?.length) return resposta(502, { erro: `Hiper recusou o pedido: ${r.errors.join(' | ').slice(0, 300)}` });
    return resposta(200, { ok: true, id: r?.id || null, mensagem: r?.message || null, total: montado.total, itens: montado.itens.map(i => ({ cod: i.cod, qtd: i.quantidade, preco: i.precoUnitarioLiquido })) });
  } catch (e) {
    return resposta(502, { erro: e.message });
  }
};

export const config = { path: '/api/pedido' };
