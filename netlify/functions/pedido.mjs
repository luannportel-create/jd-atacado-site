// Cria o pedido de venda no Hiper a partir do carrinho do site (POST /api/pedido).
// O navegador manda só código e quantidade; o preço é recalculado aqui com os dados do Hiper,
// então ninguém consegue mandar um pedido com preço alterado.
// O pedido entra em aberto (não faturado): a equipe confere estoque, frete e pagamento antes de faturar.
import { IGNORAR, chamar, listarPaginado, precoParaQuantidade } from '../lib/hiper.mjs';

// O Hiper exige meio de pagamento no pedido. Como o site não pergunta, vai um padrão e a equipe ajusta
// no faturamento (HIPER_PAGAMENTO_PADRAO no Netlify: 1 Dinheiro, 12 PIX, 6 Crediário...).
const PAGAMENTO_PADRAO = () => Number(process.env.HIPER_PAGAMENTO_PADRAO) || 1;

// CLIENTE-CORINGA: o pedido via API sobrescreve o cadastro do cliente no Hiper com os dados enviados
// (comprovado no pedido LV75). Por isso todo pedido do site entra num cliente fixo, com o CNPJ da própria JD,
// e a equipe troca para o cliente real (CNPJ e telefone vêm no alerta do WhatsApp) antes de faturar.
// Os dados abaixo são sempre os mesmos, então a "sobrescrita" não altera nada.
const JD = { bairro: 'São Lázaro', cep: '69073570', codigoIbge: 1302603, complemento: '', logradouro: 'Rua Jonas Barreto', numero: '584' };
const CLIENTE_CORINGA = () => ({
  documento: '59422148000167',
  email: String(process.env.HIPER_EMAIL_PADRAO || 'pedidos-site@example.com').trim(),
  inscricaoEstadual: '',
  nomeDoCliente: 'PEDIDO DO SITE - TROCAR CLIENTE',
  nomeFantasia: 'PEDIDO DO SITE',
});

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
  const telefone = so(dados.telefone).slice(0, 13);
  const municipio = texto(dados.municipio, 60);
  const obs = texto(dados.obs, 400);
  const numero = texto(dados.numero, 30).replace(/[^\w-]/g, '');
  if (!nome) return { erro: 'Informe o nome do responsável.' };
  if (!documentoValido(dados.documento)) return { erro: 'CNPJ ou CPF inválido.' };
  if (telefone.length < 10) return { erro: 'Informe o telefone com DDD.' };
  if (!municipio) return { erro: 'Informe o município.' };
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
    `TROCAR CLIENTE PARA: ${nome} - CNPJ/CPF ${so(dados.documento)}`,
    `Tel: ${telefone}`,
    `Município: ${municipio}`,
    'Pagamento: a combinar',
    obs && `Obs: ${obs}`,
  ].filter(Boolean).join(' | ');

  return {
    total,
    itens: itens.map(({ _cod, ...i }) => ({ ...i, cod: _cod })),
    pedido: {
      cliente: CLIENTE_CORINGA(),
      enderecoDeCobranca: JD,
      enderecoDeEntrega: JD,
      itens: itens.map(({ _cod, ...i }) => i),
      meiosDePagamento: [{ idMeioDePagamento: PAGAMENTO_PADRAO(), parcelas: 1, valor: total }],
      numeroPedidoDeVenda: numero,
      observacaoDoPedidoDeVenda: observacao.slice(0, 500),
      valorDoFrete: 0,
    },
  };
}

export default async (req, context) => {
  if (req.method !== 'POST') return resposta(405, { erro: 'Use POST.' });
  // Desliga o envio ao Hiper sem mexer no código: HIPER_PEDIDOS_ATIVOS=nao no Netlify.
  if (String(process.env.HIPER_PEDIDOS_ATIVOS || '').toLowerCase() === 'nao') return resposta(503, { erro: 'envio automático ao Hiper desligado' });
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
