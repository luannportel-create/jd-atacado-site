// Catálogo pronto guardado no Netlify Blobs: a atualização agendada grava, o site lê na hora.
// Se o Blobs não estiver disponível (ex.: teste local), as funções só devolvem null / não gravam.
const CHAVE = 'atual';

async function loja() {
  const { getStore } = await import('@netlify/blobs');
  return getStore('catalogo');
}

export async function lerCatalogoSalvo() {
  try { return await (await loja()).get(CHAVE, { type: 'json' }); } catch { return null; }
}

export async function salvarCatalogo(dados) {
  try { await (await loja()).setJSON(CHAVE, dados); return true; } catch (e) { console.log('Blobs indisponível:', e.message); return false; }
}
