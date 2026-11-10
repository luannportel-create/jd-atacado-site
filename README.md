# JD Mercado Atacado — site

Catálogo com pedido pelo WhatsApp. Publicado em https://jdmercadoatacado.netlify.app/

## Como alterar preços e produtos
Tudo fica em `index.html`, na lista `const raw=[ ... ]`. Cada produto é uma linha:

```
["Categoria","Nome do produto","Embalagem",preço],
```

- Preço com ponto, não vírgula: `129.9`. Use `null` para "Preço sob consulta".
- Embalagem no formato `30x1kg`, `24x320g`, `12x1L`, `20kg` ou `25x100`: o site calcula sozinho o preço por kg ou por unidade.
- A foto é ligada pelo nome do produto na lista `photos`. Fotos ficam em `imagens/`, em `.webp`, 400×400 px.

Cada alteração enviada para o GitHub é publicada automaticamente pelo Netlify.
