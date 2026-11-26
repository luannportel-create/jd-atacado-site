// Copia só os arquivos públicos do site para dist/ (o Netlify publica essa pasta).
// Assim node_modules, dados/ (planilha) e scripts/ nunca vão para o ar.
const fs = require('fs');
const path = require('path');
const raiz = path.join(__dirname, '..');
const dist = path.join(raiz, 'dist');
const publicos = ['index.html', 'catalogo.js', '404.html', 'favicon.ico', 'icon-512.png', 'apple-touch-icon.png',
  'robots.txt', 'sitemap.xml', '_headers', '_redirects', 'imagens'];
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
for (const item of publicos) {
  const origem = path.join(raiz, item);
  if (!fs.existsSync(origem)) { console.log('ausente:', item); continue; }
  fs.cpSync(origem, path.join(dist, item), { recursive: true });
}
console.log('dist/ pronto:', fs.readdirSync(dist).join(', '));
