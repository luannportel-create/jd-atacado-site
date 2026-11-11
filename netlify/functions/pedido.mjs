// Cria o pedido de venda no Hiper a partir do carrinho do site (POST /api/pedido).
// O navegador manda só código e quantidade; o preço é recalculado aqui com os dados do Hiper,
// então ninguém consegue mandar um pedido com preço alterado.
// O pedido entra em aberto (não faturado): a equipe confere estoque, frete e pagamento antes de faturar.
import { IGNORAR, chamar, listarPaginado, precoParaQuantidade } from '../lib/hiper.mjs';

// O Hiper exige meio de pagamento no pedido. Como o site não pergunta, vai um padrão e a equipe ajusta
// no faturamento (HIPER_PAGAMENTO_PADRAO no Netlify: 1 Dinheiro, 12 PIX, 6 Crediário...).
const PAGAMENTO_PADRAO = () => Number(process.env.HIPER_PAGAMENTO_PADRAO) || 1;
// E-mail que vai no pedido quando o cliente não informa (HIPER_EMAIL_PADRAO no Netlify). Sem ele, o campo não é enviado.
const EMAIL_PADRAO = () => String(process.env.HIPER_EMAIL_PADRAO || '').trim();

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
    `Tel: ${telefone}`,
    `Município: ${municipio}`,
    'Pagamento: a combinar',
    obs && `Obs: ${obs}`,
  ].filter(Boolean).join(' | ');

  return {
    total,
    itens: itens.map(({ _cod, ...i }) => ({ ...i, cod: _cod })),
    pedido: {
      // Só vai o que temos: campo vazio o Hiper recusa como "formato inválido".
      cliente: {
        documento: so(dados.documento),
        nomeDoCliente: nome,
        ...(EMAIL_PADRAO() ? { email: EMAIL_PADRAO() } : {}),
      },
      itens: itens.map(({ _cod, ...i }) => i),
      meiosDePagamento: [{ idMeioDePagamento: PAGAMENTO_PADRAO(), parcelas: 1, valor: total }],
      numeroPedidoDeVenda: numero,
      observacaoDoPedidoDeVenda: observacao.slice(0, 500),
      valorDoFrete: 0,
    },
  };
}

// Só na prévia: /api/pedido?teste=CNPJ tenta formatos de pedido (1 unidade do produto mais barato) do mais
// simples ao mais completo, para no primeiro que o Hiper aceitar e cancela esse pedido na hora.
async function testarFormatos(documento) {
  const produtos = (await listarPaginado()).filter(p => p.ativo !== false && p.removido !== true && !IGNORAR.has(String(p.codigo)) && Number(p.preco) > 0 && p.id);
  const p = produtos.sort((a, b) => a.preco - b.preco)[0];
  if (!p) return { erro: 'nenhum produto com preço' };
  const base = {
    itens: [{ produtoId: p.id, quantidade: 1, precoUnitarioBruto: Number(p.preco), precoUnitarioLiquido: Number(p.preco) }],
    meiosDePagamento: [{ idMeioDePagamento: 1, parcelas: 1, valor: Number(p.preco) }],
    numeroPedidoDeVenda: 'TESTE-SITE',
    observacaoDoPedidoDeVenda: 'TESTE AUTOMÁTICO DO SITE - cancelado automaticamente',
    valorDoFrete: 0,
  };
  const vazio = { bairro: '', cep: '', codigoIbge: 0, complemento: '', logradouro: '', numero: '' };
  const jd = { bairro: 'São Lázaro', cep: '69073570', codigoIbge: 1302603, complemento: '', logradouro: 'Rua Jonas Barreto', numero: '584' };
  const cliente = email => ({ documento: so(documento), email, inscricaoEstadual: '', nomeDoCliente: 'Cliente teste site', nomeFantasia: '' });
  const formatos = {
    '1_estrutura_completa_campos_vazios': { cliente: cliente(''), enderecoDeCobranca: vazio, enderecoDeEntrega: vazio, ...base },
    '2_com_email_de_teste': { cliente: cliente('teste@exemplo.com'), enderecoDeCobranca: vazio, enderecoDeEntrega: vazio, ...base },
    '3_com_email_e_endereco_da_JD': { cliente: cliente('teste@exemplo.com'), enderecoDeCobranca: jd, enderecoDeEntrega: jd, ...base },
  };
  const out = { produtoDoTeste: `${p.codigo} ${p.nome} R$ ${p.preco}` };
  for (const [nome, corpo] of Object.entries(formatos)) {
    try {
      const r = await chamar('/pedido-de-venda/', { metodo: 'POST', corpo });
      if (r?.errors?.length) { out[nome] = 'recusado: ' + r.errors.join(' | '); continue; }
      out[nome] = `ACEITO (id ${r?.id}) ${r?.message || ''}`;
      try {
        const c = await chamar(`/pedido-de-venda/cancelar/${encodeURIComponent(r.id)}`, { metodo: 'PUT' });
        out.cancelamento = c?.message || 'cancelamento enviado';
      } catch (e) { out.cancelamento = 'FALHOU, cancele no Hiper: ' + e.message; }
      break;
    } catch (e) { out[nome] = e.message; }
  }
  return out;
}

export default async (req, context) => {
  const teste = new URL(req.url).searchParams.get('teste');
  if (req.method === 'GET' && teste && context?.deploy?.context !== 'production') {
    if (!documentoValido(teste)) return resposta(400, { erro: 'CNPJ/CPF inválido' });
    try { return resposta(200, await testarFormatos(teste)); } catch (e) { return resposta(502, { erro: e.message }); }
  }
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
