# JD Mercado Atacado — site

Catálogo com pedido pelo WhatsApp. Publicado em https://jdmercadoatacado.netlify.app/

## Atualizar preços e estoque (planilha do Hiper)
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
