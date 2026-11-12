// Acesso à API da Loja Virtual do Hiper, usado pelas funções do site (catálogo e pedido).
// A chave de segurança fica na variável de ambiente HIPER_CHAVE do Netlify e nunca vai para o navegador.
const API = 'https://ms-ecommerce.hiper.com.br/api/v1';
// Cadastros internos do Hiper que não são produtos de venda.
export const IGNORAR = new Set(['3002']);
// O site recebe o máximo disponível de cada item para travar o carrinho; o número só aparece para o cliente
// quando ele tenta passar dele. (Opcional: SITE_LIMITE_ESTOQUE para só enviar o máximo abaixo de um valor.)
const LIMITE_MAXIMO = () => Number(process.env.SITE_LIMITE_ESTOQUE) || Infinity;

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

export async function obterToken(forcar = false) {
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
    return (partes.length ? partes.join(' | ') : t).slice(0, 300);
  } catch {
    return t.slice(0, 200);
  }
}

// Chamada autenticada. Repete só quando o Hiper recusou sem processar (token vencido 401, limite 429),
// então um pedido (POST) nunca é enviado em dobro.
export async function chamar(caminho, { metodo = 'GET', corpo } = {}) {
  for (let tentativa = 0; tentativa < 3; tentativa++) {
    const headers = { Authorization: `Bearer ${await obterToken(tentativa > 0)}` };
    if (corpo !== undefined) headers['Content-Type'] = 'application/json';
    const r = await fetch(API + caminho, { method: metodo, headers, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
    if (r.status === 401) continue; // token vencido: gera outro e tenta de novo
    if (r.status === 429) { await new Promise(ok => setTimeout(ok, 1000 * 2 ** tentativa)); continue; }
    if (!r.ok) throw new ErroHiper(r.status, caminho, await detalheDoErro(r));
    return r.json();
  }
  throw new Error(`Hiper não respondeu em ${caminho.split('?')[0]}`);
}

// A documentação não mostra o envelope da listagem: aceita lista direta ou lista dentro de um campo.
export function extrairLista(d) {
  if (Array.isArray(d)) return d;
  for (const k of ['produtos', 'itens', 'data', 'resultado', 'lista']) if (Array.isArray(d?.[k])) return d[k];
  const arr = d && Object.values(d).find(Array.isArray);
  return arr || [];
}

// Orientação do Hiper: disponível = estoque total − reservado (a API não entrega o disponível pronto).
export const disponivel = p => (Number(p.quantidadeEmEstoque) || 0) - (Number(p.quantidadeEmEstoqueReservado) || 0);

const titulo = s => String(s || '').toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase()).trim();

// Faixas de preço por quantidade do Hiper. Trava: ignora desconto acima de 50% (provável erro de cadastro).
export function faixasDeAtacado(p) {
  const preco = Number(p.preco);
  if (!p.atacadoAtivo || !Array.isArray(p.precoAtacado?.precos)) return [];
  return p.precoAtacado.precos
    .map(f => ({ qtd: Number(f.quantidade), preco: Number(f.precoUnitario) }))
    .filter(f => f.qtd > 1 && f.preco > 0 && f.preco < preco && f.preco >= preco * 0.5)
    .sort((a, b) => a.qtd - b.qtd);
}

// Preço unitário para a quantidade pedida (o mesmo cálculo do carrinho do site).
export function precoParaQuantidade(p, qtd) {
  let v = Number(p.preco);
  for (const f of faixasDeAtacado(p)) if (qtd >= f.qtd && f.preco < v) v = f.preco;
  return Math.round(v * 100) / 100;
}

export function resumir(p) {
  // Nome do Hiper como "ARROZ X 30X1KG": separa a embalagem do fim, para produtos novos ainda sem cadastro no site.
  const nomeHiper = String(p.nome || '');
  const e = nomeHiper.match(/\s(\d+X\d+(?:,\d+)?\s*(?:KG|G|ML|L|UN|UND)?|\d+(?:,\d+)?\s*(?:KG|G|ML|L))$/i);
  const preco = Number(p.preco);
  const faixas = faixasDeAtacado(p);
  return {
    cod: String(p.codigo),
    nome: titulo(e ? nomeHiper.slice(0, e.index) : nomeHiper),
    emb: e ? e[1].toLowerCase().replace(/l$/, 'L') : '',
    preco: Number.isFinite(preco) && preco > 0 ? preco : null,
    disp: disponivel(p) > 0, // a quantidade não sai daqui, só se tem ou não
    ...(disponivel(p) > 0 && disponivel(p) <= LIMITE_MAXIMO() ? { max: Math.floor(disponivel(p)) } : {}),
    ...(faixas.length ? { atacado: faixas } : {}),
  };
}

const pagina = n => chamar(`/produtos/listagemDeProdutos?pontoDeSincronizacao=0&pagina=${n}`)
  .then(extrairLista)
  .catch(e => { if (n > 1 && e.status === 400) return []; throw e; }); // o Hiper responde 400 quando a página não existe

// Página 1 sozinha (gera o token); as seguintes de 4 em 4, em paralelo, até vir uma página vazia.
export async function listarPaginado() {
  const todos = [];
  const vistos = new Set();
  const juntar = lista => {
    const novos = lista.filter(p => p && p.codigo != null && !vistos.has(p.id || p.codigo));
    novos.forEach(p => vistos.add(p.id || p.codigo));
    todos.push(...novos);
    return novos.length;
  };
  if (!juntar(await pagina(1))) return todos;
  for (let n = 2; n <= 100; n += 4) {
    const grupo = await Promise.all([n, n + 1, n + 2, n + 3].map(pagina));
    let fim = false;
    for (const lista of grupo) if (!juntar(lista)) { fim = true; break; }
    if (fim) break;
  }
  return todos;
}

export async function buscarCatalogo(inicio = Date.now()) {
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
  const ativos = todos.filter(p => p.ativo !== false && p.removido !== true && !IGNORAR.has(String(p.codigo)));
  const semConferir = await corrigirReservas(ativos, inicio);
  return { produtos: ativos.map(resumir), semConferir };
}

// A listagem de produtos vem com a reserva zerada; a rota de estoque traz a reserva certa.
// Consulta a rota de estoque só para quem tem estoque físico (sem estoque já está fora de qualquer jeito),
// 16 por vez. O Netlify corta a função em 10 s: perto disso, para e os que faltaram ficam com o valor da listagem.
export async function corrigirReservas(produtos, inicio, simultaneas = 16, prazoMs = 7500) {
  const fila = produtos.filter(p => p.id && Number(p.quantidadeEmEstoque) > 0);
  let semConferir = 0;
  const trabalhador = async () => {
    while (fila.length) {
      const p = fila.shift();
      if (Date.now() - inicio > prazoMs) { semConferir++; continue; }
      try {
        const e = await chamar(`/estoques/pontoDeSincronizacao?ProdutoId=${encodeURIComponent(p.id)}`);
        if (e && e.quantidadeEmEstoque != null) {
          p.quantidadeEmEstoque = e.quantidadeEmEstoque;
          p.quantidadeEmEstoqueReservado = e.quantidadeEmEstoqueReservado ?? p.quantidadeEmEstoqueReservado;
        }
      } catch { semConferir++; }
    }
  };
  await Promise.all(Array.from({ length: simultaneas }, trabalhador));
  return semConferir;
}


// Confere no Hiper, na hora do pedido, se cada item tem disponível suficiente (estoque − reservado).
// Devolve os itens que passaram do disponível, com o máximo possível. Se a consulta de um item falhar, ele não bloqueia o pedido.
export async function conferirEstoque(itens) {
  const ajustes = [];
  await Promise.all(itens.map(async it => {
    try {
      const e = await chamar(`/estoques/pontoDeSincronizacao?ProdutoId=${encodeURIComponent(it.produtoId)}`);
      if (e?.quantidadeEmEstoque == null) return;
      const max = Math.max(0, Math.floor(disponivel(e)));
      if (it.quantidade > max) ajustes.push({ cod: it.cod, nome: it.nome, max });
    } catch { /* sem conferência para este item */ }
  }));
  return ajustes;
}
