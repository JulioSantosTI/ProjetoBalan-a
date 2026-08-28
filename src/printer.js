const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { PNG } = require('pngjs');
const QRCode = require('qrcode');
const { renderizarHtmlParaPng } = require('./htmlRenderer');

const PRINTER_NAME = process.env.PRINTER_NAME || 'LABEL';
// Segunda impressora (cupom/recibo) -- mesma logica de impressao via HTML,
// so manda pra um nome de fila diferente. Ajuste pro nome real assim que
// ela for instalada no Windows (confira com "Get-Printer" no PowerShell,
// igual foi feito pra descobrir o nome "LABEL").
const PRINTER_NAME_CUPOM = process.env.PRINTER_NAME_CUPOM || 'CUPOM';
const PS_SCRIPT = path.join(__dirname, 'print-raw.ps1');

// Impressoras de ETIQUETA (como a POS-9250-L) normalmente falam TSPL, nao
// ESC/POS (esse e o protocolo de impressora de RECIBO). Sao linguagens
// diferentes: TSPL exige SIZE/GAP (dimensao da etiqueta) e um PRINT
// explicito no final, senao ela recebe tudo e nao imprime nada.
// Se a sua impressora entender ESC/POS em vez de TSPL, ajuste PRINT_PROTOCOL=escpos no .env.
const PRINT_PROTOCOL = (process.env.PRINT_PROTOCOL || 'tspl').toLowerCase();
// Tamanho da etiqueta e definido por quem chama a API (larguraMm/alturaMm
// em cada request) -- nao trava num tamanho fixo de proposito, porque a
// etiqueta fisica pode mudar. So existe um teto tecnico bem folgado
// (MAX_MM_TECNICO) pra impedir um valor absurdo (ex: alguem mandar
// 999999mm) de travar o servidor tentando renderizar/alocar memoria pra
// isso -- nao e uma trava de "tamanho de etiqueta permitido". Se vier um
// tamanho maior que a etiqueta fisica de verdade, o resultado e so uma
// etiqueta cortada, sem erro.
const MAX_MM_TECNICO = Number(process.env.MAX_MM_TECNICO) || 500;
// Usado so quando a request nao manda larguraMm/alturaMm.
const LABEL_WIDTH_MM = Number(process.env.LABEL_WIDTH_MM) || 100;
const LABEL_HEIGHT_MM = Number(process.env.LABEL_HEIGHT_MM) || 50;
const LABEL_GAP_MM = Number(process.env.LABEL_GAP_MM) || 2;
// DPI da impressora -- 203dpi (8 dots/mm) e o mais comum nessas termicas de
// etiqueta. Se o HTML sair maior/menor do que deveria na etiqueta fisica,
// provavelmente o DPI real e outro (ex: 300) -- ajuste no .env.
const PRINTER_DPI = Number(process.env.PRINTER_DPI) || 203;

function montarTextoTspl(texto) {
  const linhas = texto.split('\n');
  const comandosTexto = linhas
    .map((linha, i) => `TEXT 20,${20 + i * 30},"3",0,1,1,"${linha.replace(/"/g, "'")}"`)
    .join('\r\n');

  return Buffer.from(
    `SIZE ${LABEL_WIDTH_MM} mm,${LABEL_HEIGHT_MM} mm\r\n` +
      `GAP ${LABEL_GAP_MM} mm,0 mm\r\n` +
      `CLS\r\n` +
      `${comandosTexto}\r\n` +
      `PRINT 1,1\r\n`,
    'latin1'
  );
}

function montarTextoEscPos(texto) {
  const ESC = 0x1b;
  const GS = 0x1d;
  return Buffer.concat([
    Buffer.from([ESC, 0x40]), // ESC @ = reset
    Buffer.from(texto.replace(/\n/g, '\r\n') + '\r\n\r\n\r\n', 'latin1'),
    Buffer.from([GS, 0x56, 0x00]), // GS V 0 = corte total (ignorado se nao tiver guilhotina)
  ]);
}

function montarTexto(texto) {
  return PRINT_PROTOCOL === 'escpos' ? montarTextoEscPos(texto) : montarTextoTspl(texto);
}

// --- Validacao/sanitizacao -------------------------------------------------
// O modelo vem de uma requisicao HTTP externa (site de terceiro) e vira
// texto interpolado direto num comando TSPL. Sem isso, aspas/quebra de
// linha no "texto" ou "valor" do usuario conseguiriam fechar a string TSPL
// e injetar comandos arbitrarios na impressora.
const MAX_ELEMENTOS = 30;
const MAX_TEXTO = 300;
const TIPOS_VALIDOS = ['texto', 'barcode', 'qrcode'];
const FONTES_VALIDAS = ['1', '2', '3', '4', '5', '6', '7', '8'];
const CODIGOS_BARCODE_VALIDOS = ['128', '39', '93', 'EAN13', 'EAN8', 'UPCA', 'UPCE', 'CODABAR', 'MSI'];
const ECC_VALIDOS = ['L', 'M', 'Q', 'H'];
const MODOS_QR_VALIDOS = ['A', 'M'];
const ROTACOES_VALIDAS = [0, 90, 180, 270];

function escaparTspl(valor) {
  return String(valor)
    .slice(0, MAX_TEXTO)
    .replace(/["\r\n]/g, ' ') // aspas/quebra de linha fecham a string TSPL ou injetam novo comando
    .replace(/[\x00-\x1f]/g, ''); // remove demais caracteres de controle
}

function numeroEmFaixa(valor, campo, min, max) {
  const n = Number(valor);
  if (!Number.isFinite(n)) throw new Error(`"${campo}" precisa ser um numero`);
  if (n < min || n > max) throw new Error(`"${campo}" precisa estar entre ${min} e ${max}`);
  return n;
}

function valorDaLista(valor, padrao, lista, campo) {
  if (valor === undefined) return padrao;
  const v = String(valor);
  if (!lista.includes(v)) throw new Error(`"${campo}" invalido: use um de ${lista.join(', ')}`);
  return v;
}

function rotacaoValida(valor) {
  if (valor === undefined) return 0;
  const n = Number(valor);
  if (!ROTACOES_VALIDAS.includes(n)) throw new Error('"rotacao" invalida: use 0, 90, 180 ou 270');
  return n;
}

function textoObrigatorio(valor, campo) {
  if (typeof valor !== 'string' || !valor.trim()) throw new Error(`"${campo}" precisa ser uma string nao vazia`);
  return valor;
}

// Modelo generico: lista de elementos (texto, codigo de barras, qrcode)
// posicionados em coordenadas TSPL (pontos, nao mm -- 1mm ~ 8 pontos numa
// impressora 203dpi, comum nessas etiquetas). Pensado pra ser montado por
// quem consome a API (site externo), nao fixo no codigo.
function comandoElemento(el) {
  if (!el || typeof el !== 'object') throw new Error('elemento invalido');
  if (!TIPOS_VALIDOS.includes(el.tipo)) {
    throw new Error(`tipo de elemento desconhecido: "${el.tipo}" (use texto, barcode ou qrcode)`);
  }

  const x = numeroEmFaixa(el.x, 'x', 0, 4000);
  const y = numeroEmFaixa(el.y, 'y', 0, 4000);
  const rotacao = rotacaoValida(el.rotacao);

  switch (el.tipo) {
    case 'texto': {
      const texto = textoObrigatorio(el.texto, 'texto');
      const fonte = valorDaLista(el.fonte, '3', FONTES_VALIDAS, 'fonte');
      const escalaX = numeroEmFaixa(el.escalaX ?? 1, 'escalaX', 1, 10);
      const escalaY = numeroEmFaixa(el.escalaY ?? 1, 'escalaY', 1, 10);
      return `TEXT ${x},${y},"${fonte}",${rotacao},${escalaX},${escalaY},"${escaparTspl(texto)}"`;
    }
    case 'barcode': {
      const valor = textoObrigatorio(el.valor, 'valor');
      const codigo = valorDaLista(el.codigo, '128', CODIGOS_BARCODE_VALIDOS, 'codigo');
      const altura = numeroEmFaixa(el.altura ?? 60, 'altura', 1, 500);
      const legivel = el.legivel === false ? 0 : 1;
      const estreita = numeroEmFaixa(el.estreita ?? 2, 'estreita', 1, 10);
      const larga = numeroEmFaixa(el.larga ?? 4, 'larga', 1, 20);
      return `BARCODE ${x},${y},"${codigo}",${altura},${legivel},${rotacao},${estreita},${larga},"${escaparTspl(valor)}"`;
    }
    case 'qrcode': {
      const valor = textoObrigatorio(el.valor, 'valor');
      const ecc = valorDaLista(el.ecc, 'M', ECC_VALIDOS, 'ecc');
      const celula = numeroEmFaixa(el.celula ?? 4, 'celula', 1, 20);
      const modo = valorDaLista(el.modo, 'A', MODOS_QR_VALIDOS, 'modo');
      return `QRCODE ${x},${y},${ecc},${celula},${modo},${rotacao},"${escaparTspl(valor)}"`;
    }
  }
}

function montarModeloTspl({ elementos, larguraMm, alturaMm, gapMm }) {
  if (!Array.isArray(elementos) || elementos.length === 0) {
    throw new Error('"elementos" precisa ser uma lista com pelo menos 1 item');
  }
  if (elementos.length > MAX_ELEMENTOS) {
    throw new Error(`no maximo ${MAX_ELEMENTOS} elementos por etiqueta`);
  }

  const largura = numeroEmFaixa(larguraMm ?? LABEL_WIDTH_MM, 'larguraMm', 1, MAX_MM_TECNICO);
  const altura = numeroEmFaixa(alturaMm ?? LABEL_HEIGHT_MM, 'alturaMm', 1, MAX_MM_TECNICO);
  const gap = numeroEmFaixa(gapMm ?? LABEL_GAP_MM, 'gapMm', 0, 50);
  const comandos = elementos.map(comandoElemento).join('\r\n');

  return Buffer.from(
    `SIZE ${largura} mm,${altura} mm\r\n` +
      `GAP ${gap} mm,0 mm\r\n` +
      `CLS\r\n` +
      `${comandos}\r\n` +
      `PRINT 1,1\r\n`,
    'latin1'
  );
}

async function imprimirModelo({ elementos, larguraMm, alturaMm, gapMm } = {}) {
  await imprimirRaw(montarModeloTspl({ elementos, larguraMm, alturaMm, gapMm }));
}

// --- Impressao "o que voce ve e o que sai" (imagem/bitmap) -----------------
// Pro site desenhar a etiqueta como quiser (canvas, HTML, editor visual) e
// mandar exatamente aquilo pra impressora -- em vez de descrever a etiqueta
// em comandos TSPL, o site exporta um PNG (ex: canvas.toDataURL()) e a
// gente converte pra bitmap 1-bit preto/branco e imprime pixel a pixel.
// Alinhado com MAX_MM_TECNICO (500mm a ate 300dpi) -- teto tecnico, nao
// de negocio, so pra nao deixar passar um valor absurdo que trave o servidor.
const MAX_IMG_LARGURA_PX = 6000;
const MAX_IMG_ALTURA_PX = 6000;
// O padrao TSC oficial pro comando BITMAP e bit=1 -> preto. Essa impressora
// (testado fisicamente) faz o contrario: bit=1 saiu como branco e bit=0
// como preto, entao fundo virava um retangulo preto solido. Se trocar de
// impressora e o problema for o oposto, ajuste INVERTER_BITMAP=false no .env.
const INVERTER_BITMAP = process.env.INVERTER_BITMAP !== 'false';

function pngParaBitmap(pngBuffer, limiar) {
  let png;
  try {
    png = PNG.sync.read(pngBuffer);
  } catch (err) {
    throw new Error('imagem invalida: precisa ser um PNG valido');
  }

  const { width, height, data } = png;
  if (width < 1 || height < 1 || width > MAX_IMG_LARGURA_PX || height > MAX_IMG_ALTURA_PX) {
    throw new Error(`imagem precisa ter entre 1x1 e ${MAX_IMG_LARGURA_PX}x${MAX_IMG_ALTURA_PX}px`);
  }

  const larguraBytes = Math.ceil(width / 8);
  const bitmap = Buffer.alloc(larguraBytes * height, 0);

  // Cinza com precisao float (pra difusao de erro). Fundo transparente vira
  // branco (nao imprime) em vez de preto.
  const cinza = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (width * y + x) * 4;
      const alpha = data[idx + 3] / 255;
      const luminancia = 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
      cinza[y * width + x] = luminancia * alpha + 255 * (1 - alpha);
    }
  }

  // Floyd-Steinberg: pixel ja preto/branco puro (texto, QR, barcode) nao gera
  // erro pra difundir, entao fica identico ao corte seco. So imagens com tom
  // de cinza real (logo com opacidade, foto) ganham o efeito de meio-tom.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const antigo = cinza[i];
      const preto = antigo < limiar;
      const novo = preto ? 0 : 255;
      const marcarBit = INVERTER_BITMAP ? !preto : preto;
      if (marcarBit) bitmap[y * larguraBytes + (x >> 3)] |= 0x80 >> (x % 8);

      const erro = antigo - novo;
      if (x + 1 < width) cinza[i + 1] += (erro * 7) / 16;
      if (y + 1 < height) {
        if (x > 0) cinza[i + width - 1] += (erro * 3) / 16;
        cinza[i + width] += (erro * 5) / 16;
        if (x + 1 < width) cinza[i + width + 1] += (erro * 1) / 16;
      }
    }
  }

  return { width, height, larguraBytes, bitmap };
}

function montarBitmapTspl(pngBuffer, { x = 0, y = 0, larguraMm, alturaMm, gapMm, limiar = 128 } = {}) {
  const limiarValido = numeroEmFaixa(limiar, 'limiar', 0, 255);
  const { larguraBytes, bitmap, height } = pngParaBitmap(pngBuffer, limiarValido);

  const largura = numeroEmFaixa(larguraMm ?? LABEL_WIDTH_MM, 'larguraMm', 1, MAX_MM_TECNICO);
  const altura = numeroEmFaixa(alturaMm ?? LABEL_HEIGHT_MM, 'alturaMm', 1, MAX_MM_TECNICO);
  const gap = numeroEmFaixa(gapMm ?? LABEL_GAP_MM, 'gapMm', 0, 50);
  const px = numeroEmFaixa(x, 'x', 0, 4000);
  const py = numeroEmFaixa(y, 'y', 0, 4000);

  const cabecalho = Buffer.from(
    `SIZE ${largura} mm,${altura} mm\r\n` +
      `GAP ${gap} mm,0 mm\r\n` +
      `CLS\r\n` +
      `BITMAP ${px},${py},${larguraBytes},${height},0,`,
    'latin1'
  );
  const rodape = Buffer.from('\r\nPRINT 1,1\r\n', 'latin1');

  return Buffer.concat([cabecalho, bitmap, rodape]);
}

async function imprimirImagem({ imagemBase64, x, y, larguraMm, alturaMm, gapMm, limiar } = {}) {
  if (typeof imagemBase64 !== 'string' || !imagemBase64.trim()) {
    throw new Error('"imagemBase64" precisa ser uma string (PNG em base64)');
  }

  const semPrefixo = imagemBase64.replace(/^data:image\/png;base64,/, '');
  const pngBuffer = Buffer.from(semPrefixo, 'base64');
  if (pngBuffer.length === 0) throw new Error('imagem vazia ou base64 invalido');

  await imprimirRaw(montarBitmapTspl(pngBuffer, { x, y, larguraMm, alturaMm, gapMm, limiar }));
}

// --- Impressao a partir de HTML ---------------------------------------------
// O site manda um trecho de HTML/CSS (o "modelo" que muda), a gente
// renderiza num Chromium headless do tamanho exato da etiqueta fisica e
// imprime o resultado como bitmap -- reaproveita o mesmo pipeline da
// impressao por imagem. JavaScript fica desligado no render (ver
// htmlRenderer.js) pra nao executar script de terceiro no nosso processo.
const MAX_HTML_CHARS = 200000;

function mmParaPx(mm, dpi) {
  return Math.max(1, Math.round((mm / 25.4) * dpi));
}

const QRCODE_PLACEHOLDER = /\{\{QRCODE\}\}/g;
// Casa o elemento que envolve DIRETAMENTE o placeholder e mais nada dentro
// dele (ex: <div class="qrcode">{{QRCODE}}</div>) -- usado pra remover a
// div inteira quando nao tem valor, em vez de deixar uma caixa vazia
// ocupando espaco no layout. Se o placeholder nao estiver sozinho assim
// (tiver texto/outra tag junto), cai no fallback de so limpar o texto.
const QRCODE_WRAPPER = /<([a-zA-Z][\w-]*)\b[^>]*>\s*\{\{QRCODE\}\}\s*<\/\1>/;
const MAX_QRCODE_VALOR = 500;

// O render nao roda JavaScript, entao o site nao consegue gerar QR code no
// proprio HTML. Em vez disso, ele deixa um placeholder {{QRCODE}} no lugar
// onde o QR deve aparecer e manda o valor separado -- a gente gera a imagem
// aqui e substitui antes de renderizar. Sem valor, remove o elemento que
// envolve o placeholder inteiro (nao so o texto), pra nao sobrar espaco vazio.
async function substituirQrcode(html, qrcode) {
  if (!html.includes('{{QRCODE}}')) return html;

  if (qrcode !== undefined && (typeof qrcode !== 'object' || qrcode === null)) {
    throw new Error('"qrcode" precisa ser um objeto, ex: { "valor": "123456" }');
  }

  const valor = qrcode && typeof qrcode.valor === 'string' ? qrcode.valor.trim() : '';
  if (!valor) {
    if (QRCODE_WRAPPER.test(html)) return html.replace(QRCODE_WRAPPER, '');
    return html.replace(QRCODE_PLACEHOLDER, '');
  }

  if (valor.length > MAX_QRCODE_VALOR) {
    throw new Error(`"qrcode.valor" muito grande (max ${MAX_QRCODE_VALOR} caracteres)`);
  }

  const dataUrl = await QRCode.toDataURL(valor, {
    margin: 0,
    width: 300,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
  return html.replace(QRCODE_PLACEHOLDER, `<img src="${dataUrl}" />`);
}

// {{PESO}} vem preenchido pelo servidor (que chama isso passando o peso
// atual da balanca, real ou simulado) -- quem chama a API nao precisa
// mandar o valor, a menos que queira travar num numero especifico (ex: o
// peso exato que o site ja leu via WebSocket, evitando corrida se a
// balanca mudar entre a leitura e a impressao).
const PESO_PLACEHOLDER = /\{\{PESO\}\}/g;

function substituirPeso(html, peso, unidade) {
  if (!html.includes('{{PESO}}')) return html;
  const numero = Number(peso);
  if (!Number.isFinite(numero)) return html.replace(PESO_PLACEHOLDER, '');
  return html.replace(PESO_PLACEHOLDER, `${numero.toFixed(3)} ${unidade || 'kg'}`);
}

async function imprimirHtml({ html, larguraMm, alturaMm, gapMm, limiar, qrcode, peso, unidade, impressora } = {}) {
  if (typeof html !== 'string' || !html.trim()) {
    throw new Error('"html" precisa ser uma string nao vazia');
  }
  if (html.length > MAX_HTML_CHARS) {
    throw new Error(`"html" muito grande (max ${MAX_HTML_CHARS} caracteres)`);
  }

  let htmlFinal = await substituirQrcode(html, qrcode);
  htmlFinal = substituirPeso(htmlFinal, peso, unidade);

  const largura = numeroEmFaixa(larguraMm ?? LABEL_WIDTH_MM, 'larguraMm', 1, MAX_MM_TECNICO);
  const altura = numeroEmFaixa(alturaMm ?? LABEL_HEIGHT_MM, 'alturaMm', 1, MAX_MM_TECNICO);
  const larguraPx = mmParaPx(largura, PRINTER_DPI);
  const alturaPx = mmParaPx(altura, PRINTER_DPI);

  const pngBuffer = await renderizarHtmlParaPng(htmlFinal, { larguraPx, alturaPx, dpi: PRINTER_DPI });

  await imprimirRaw(montarBitmapTspl(pngBuffer, { larguraMm: largura, alturaMm: altura, gapMm, limiar }), impressora);
}

async function imprimirRaw(bytes, nomeImpressora = PRINTER_NAME) {
  const arquivoTemp = path.join(os.tmpdir(), `print-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
  await fs.writeFile(arquivoTemp, bytes);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS_SCRIPT, '-PrinterName', nomeImpressora, '-FilePath', arquivoTemp],
        (err, stdout, stderr) => {
          if (err) return reject(new Error(stderr || err.message));
          resolve();
        }
      );
    });
  } finally {
    await fs.unlink(arquivoTemp).catch(() => {});
  }
}

async function imprimirTexto(texto) {
  await imprimirRaw(montarTexto(texto));
}

module.exports = {
  imprimirTexto,
  imprimirModelo,
  imprimirImagem,
  imprimirHtml,
  imprimirRaw,
  PRINTER_NAME,
  PRINTER_NAME_CUPOM,
};
