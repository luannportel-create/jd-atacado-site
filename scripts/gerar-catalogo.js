// Gera catalogo.js a partir da planilha exportada do Hiper ("Listagem de produtos").
// Uso: node scripts/gerar-catalogo.js   (o Netlify roda isto sozinho a cada publicação)
//
// - Usa a planilha Listagemdeprodutos_*.csv mais recente (na raiz ou em dados/).
// - Preço e estoque vêm da planilha; nome, embalagem, categoria e foto vêm de dados/produtos.json.
// - Produto novo que não está em produtos.json entra com o nome do Hiper e categoria "Outros".
// - A quantidade em estoque NÃO vai para o site, só se tem ou não tem.
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const lista = d => fs.existsSync(d) ? fs.readdirSync(d).filter(f => /^Listagemdeprodutos.*\.csv$/i.test(f)).map(f => path.join(d, f)) : [];
const planilhas = [...lista(raiz), ...lista(path.join(raiz, 'dados'))]
  .sort((a, b) => (path.basename(a).match(/\d+/) || [0])[0].localeCompare((path.basename(b).match(/\d+/) || [0])[0], undefined, { numeric: true }));
if (!planilhas.length) throw new Error('Nenhuma planilha Listagemdeprodutos*.csv encontrada.');
const arquivo = planilhas[planilhas.length - 1];

let buf = fs.readFileSync(arquivo);
let texto = buf.toString('utf8');
if (texto.includes('�')) texto = buf.toString('latin1'); // exportação em ANSI
texto = texto.replace(/^﻿/, '');

const cfg = JSON.parse(fs.readFileSync(path.join(raiz, 'dados', 'produtos.json'), 'utf8'));
const num = s => Number(String(s).trim().replace(/\./g, '').replace(',', '.'));
const titulo = s => s.toLowerCase().replace(/(^|\s)(\S)/g, (m, a, b) => a + b.toUpperCase());

const produtos = [];
const novos = [];
for (const linha of texto.split(/\r?\n/)) {
  const col = linha.split(';');
  const m = (col[0] || '').match(/^\s*(\d+)\s*-\s*(.+?)\s*$/);
  if (!m || col.length < 3) continue; // cabeçalho, totais, linhas vazias
  const [, codigo, descricao] = m;
  if ((cfg.ignorar || []).includes(codigo)) continue;
  const preco = num(col[1]);
  const estoque = num(col[2]);
  let info = cfg.produtos[codigo];
  if (!info) {
    // Produto novo: separa a embalagem do fim da descrição (ex.: "ARROZ X 30X1KG").
    const e = descricao.match(/\s(\d+X\d+(?:,\d+)?\s*(?:KG|G|ML|L|UN|UND)?|\d+(?:,\d+)?\s*(?:KG|G|ML|L))$/i);
    info = { nome: titulo(e ? descricao.slice(0, e.index) : descricao), emb: e ? e[1].toLowerCase().replace(/l$/, 'L') : '', cat: 'Outros' };
    novos.push(`${codigo} - ${descricao}`);
  }
  produtos.push({
    cod: codigo, nome: info.nome, emb: info.emb, cat: info.cat,
    preco: Number.isFinite(preco) && preco > 0 ? preco : null,
    disp: estoque > 0,
    foto: info.foto || null,
  });
}

// Produtos cadastrados em dados/produtos.json que ainda não estão na planilha: entram ocultos e
// aparecem quando a API do Hiper os entregar, já com nome, categoria e foto certos.
const naPlanilha = new Set(produtos.map(p => p.cod));
for (const [cod, info] of Object.entries(cfg.produtos)) {
  if (naPlanilha.has(cod) || (cfg.ignorar || []).includes(cod)) continue;
  produtos.push({ cod, nome: info.nome, emb: info.emb, cat: info.cat, preco: null, disp: false, foto: info.foto || null, oculto: true });
}

const ordem = [...cfg.categorias, 'Outros'];
produtos.sort((a, b) => (ordem.indexOf(a.cat) - ordem.indexOf(b.cat)) || a.nome.localeCompare(b.nome, 'pt-BR') || a.emb.localeCompare(b.emb));

const saida = '// Gerado automaticamente por scripts/gerar-catalogo.js a partir de ' + path.basename(arquivo) + '. Não edite à mão.\n'
  + 'window.CATALOGO_DATA=' + JSON.stringify(path.basename(arquivo)) + ';\n'
  + 'window.CATALOGO=' + JSON.stringify(produtos) + ';\n';
fs.writeFileSync(path.join(raiz, 'catalogo.js'), saida);

console.log(`Planilha: ${path.basename(arquivo)}`);
console.log(`${produtos.length} produtos (${produtos.filter(p => p.disp).length} em estoque, ${produtos.filter(p => !p.disp).length} fora de estoque, ${produtos.filter(p => !p.foto).length} sem foto)`);
if (novos.length) console.log(`Produtos novos sem cadastro em dados/produtos.json (entram em "Outros"):\n  ${novos.join('\n  ')}`);
