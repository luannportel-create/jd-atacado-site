# JD Mercado Atacado — site

Catálogo com pedido pelo WhatsApp. Publicado em https://jdmercadoatacado.netlify.app/

## Preço e estoque ao vivo (API do Hiper)
O site busca preço e estoque direto no Hiper, pela API da Loja Virtual (`netlify/functions/catalogo.mjs`, endereço `/api/catalogo`).
- A chave de segurança fica no Netlify, em **Project configuration → Environment variables → `HIPER_CHAVE`**. Ela nunca vai para o navegador.
- A resposta fica guardada por 10 minutos: mudança de preço no Hiper aparece no site em até ~10 min, **sem republicar e sem gastar créditos de publicação**.
- Só aparecem produtos marcados para a loja virtual no Hiper, ativos e não removidos. Preço vem da tabela escolhida em Vendas → Loja virtual.
- Preço por quantidade (preço de atacado do Hiper) aparece no card e é aplicado no pedido.
- Se a API falhar ou vier quase vazia, o site usa o catálogo gravado (`catalogo.js`, gerado da última planilha).

## Atualizar preços e estoque pela planilha (reserva, se a API estiver desligada)
1. No Hiper, exporte a **Listagem de produtos** em CSV (colunas: Produto; Preço de venda; Estoque; Código de barras).
2. No GitHub, abra este repositório → **Add file → Upload files** → arraste o arquivo `Listagemdeprodutos_....csv` → **Commit changes**.
3. O Netlify publica sozinho. O site usa sempre a planilha mais recente (maior número no nome do arquivo).

- Estoque zerado ou negativo → aparece como **Fora de estoque**, com foto fosca e botão "Avisar quando chegar".
- A quantidade em estoque não aparece no site, e a planilha não fica acessível pelo endereço do site.
- Cada envio gera uma publicação (15 créditos do plano grátis do Netlify): envie no máximo 1–2 vezes por semana.

## Nome, categoria e foto de cada produto
Ficam em `dados/produtos.json`, pelo código do Hiper. Produto novo que ainda não está lá entra no site com o nome do Hiper na categoria "Outros".
Fotos ficam em `imagens/`, em `.webp`, 400×400 px.

Para testar localmente: `node scripts/gerar-catalogo.js` e abrir `index.html`.
