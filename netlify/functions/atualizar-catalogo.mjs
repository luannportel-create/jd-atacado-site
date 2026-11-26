// Atualização agendada (a cada 15 min): lê preço, estoque e reservas no Hiper com até ~24 s de prazo
// (funções agendadas têm 30 s; a do site tem só 10 s) e salva o catálogo pronto para o site.
import { buscarCatalogo } from '../lib/hiper.mjs';
import { salvarCatalogo } from '../lib/cache.mjs';

export default async () => {
  const inicio = Date.now();
  const { produtos, semConferir } = await buscarCatalogo(inicio, 24000);
  if (!produtos.length) return; // não sobrescreve o catálogo bom com uma resposta vazia
  await salvarCatalogo({ atualizado: new Date().toISOString(), tempoMs: Date.now() - inicio, semConferir, origem: 'agendada', produtos });
  console.log(`catálogo salvo: ${produtos.length} produtos, ${semConferir} sem conferir, ${Date.now() - inicio} ms`);
};

export const config = { schedule: '*/15 * * * *' };
