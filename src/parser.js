// Tenta reconhecer o peso dentro de uma linha crua vinda da balanca.
// Formatos comuns cobertos:
//   "ST,GS,+00012.34kg"   (Toledo/Filizola: ST=estavel/US=instavel, GS=peso bruto)
//   "+0000.450 kg"
//   "12.345 kg"
//   "1,00108.8,00000.0,00108.8"  (CSV sem unidade: flag,bruto,tara,liquido)
// Quando nao reconhece nada, retorna null e quem chamou decide o que fazer
// com o dado bruto (normalmente so exibir pra gente calibrar o parser).
function parsePeso(linha) {
  const texto = linha.trim();
  if (!texto) return null;

  const csv = parseCsv(texto);
  if (csv) return csv;

  const matchPeso = texto.match(/([+-]?\d{1,6}(?:[.,]\d{1,3})?)\s*(kg|g|lb)?/i);
  if (!matchPeso) return null;

  const peso = parseFloat(matchPeso[1].replace(',', '.'));
  if (Number.isNaN(peso)) return null;

  const unidade = (matchPeso[2] || 'kg').toLowerCase();

  let estavel = null;
  if (/\bST\b/i.test(texto)) estavel = true;
  else if (/\bUS\b/i.test(texto)) estavel = false;

  return { peso, unidade, estavel, raw: texto };
}

// Formato CSV numerico puro, sem unidade nem letras (ex: balanca lida via
// app Flutter de referencia): "1,00108.8,00000.0,00108.8". O 2o campo e o
// peso bruto; o 1o campo costuma ser flag de estabilidade (1=estavel).
// So dispara se NENHUM campo tiver letra (evita roubar linhas tipo "ST,GS,...").
function parseCsv(texto) {
  const campos = texto.split(',').map((c) => c.trim());
  if (campos.length < 2) return null;
  if (campos.some((c) => /[a-z]/i.test(c))) return null;
  if (!campos.every((c) => /^[+-]?\d+(\.\d+)?$/.test(c))) return null;

  const peso = parseFloat(campos[1]);
  if (Number.isNaN(peso)) return null;

  const estavel = campos[0] === '1' ? true : campos[0] === '0' ? false : null;

  return { peso, unidade: 'kg', estavel, raw: texto };
}

module.exports = { parsePeso };
