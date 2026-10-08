// Dentro do app (Electron) o HTML e renderizado pelo proprio Chromium do
// Electron -- o instalador nao precisa levar/baixar outro Chromium. Rodando
// direto com "npm start" (desenvolvimento), usa puppeteer como antes.
const EM_ELECTRON = Boolean(process.versions.electron);

// Unidades fisicas de CSS (mm, in, cm, pt) sao sempre resolvidas pelo
// navegador a 96dpi, independente da resolucao real da impressora -- e a
// definicao do "pixel de referencia" do CSS. Se o HTML do site usa "mm"
// (ex: width:100mm, pensando no tamanho fisico real da etiqueta), o
// viewport tambem precisa ser montado nessa mesma referencia de 96dpi;
// caso contrario o layout do site so preenche uma fracao do canvas.
// O fator de escala (dpi/96) faz o Chromium capturar na resolucao real da
// impressora (ex: 203dpi) SEM mexer em como o CSS calcula "mm"/"in".
const CSS_DPI = 96;

// --- Electron ---------------------------------------------------------------

// Janela offscreen (nunca aparece na tela e ignora a escala do monitor do
// Windows). JavaScript desligado de proposito: so desenhamos HTML/CSS
// estatico, nao executamos script de quem chamou a API.
async function renderizarComElectron(html, { larguraPx, alturaPx, dpi, timeoutMs }) {
  const { BrowserWindow } = require('electron');
  const escala = dpi / CSS_DPI;

  const win = new BrowserWindow({
    show: false,
    width: larguraPx,
    height: alturaPx,
    useContentSize: true,
    frame: false,
    webPreferences: {
      offscreen: true,
      javascript: false,
      sandbox: true,
      zoomFactor: escala,
    },
  });

  let timer;
  try {
    const wc = win.webContents;
    wc.setFrameRate(10);
    // Janela offscreen entrega cada quadro desenhado no evento "paint". Depois
    // que o HTML carrega, pede um quadro novo (invalidate) e usa esse.
    const quadro = new Promise((resolve, reject) => {
      let carregado = false;
      timer = setTimeout(() => reject(new Error(`render do HTML passou de ${timeoutMs}ms`)), timeoutMs);
      wc.on('paint', (_e, _area, imagem) => {
        if (carregado && !imagem.isEmpty()) resolve(imagem);
      });
      // Diferente do puppeteer, a janela do Electron desenha barra de rolagem
      // quando o HTML passa do tamanho da etiqueta -- ela sairia impressa.
      wc.once('dom-ready', () => {
        wc.insertCSS('::-webkit-scrollbar { display: none !important; }').catch(() => {});
      });
      wc.once('did-finish-load', () => {
        carregado = true;
        // Da tempo do CSS acima ser aplicado antes de pegar o quadro.
        setTimeout(() => wc.invalidate(), 30);
      });
      wc.once('did-fail-load', (_e, _cod, desc) => reject(new Error(`falha ao carregar HTML: ${desc}`)));
    });
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
    const imagem = await quadro;
    return imagem.crop({ x: 0, y: 0, width: larguraPx, height: alturaPx }).toPNG();
  } finally {
    clearTimeout(timer);
    win.destroy();
  }
}

// --- Puppeteer (desenvolvimento) --------------------------------------------

// Mantem um unico Chromium aberto (abrir/fechar a cada impressao seria
// lento, ~1-2s so pra subir o processo). Abrimos/fechamos so a aba (page)
// por requisicao. Se o Chromium cair sozinho (falta de memoria, crash --
// acontece depois de rodar um tempo), o evento "disconnected" limpa o
// cache pra proxima chamada relancar um novo, em vez de ficar preso pra
// sempre reusando uma instancia morta (era a causa do erro "Connection closed").
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    const puppeteer = require('puppeteer');
    browserPromise = puppeteer.launch({ headless: 'new' }).then((browser) => {
      browser.on('disconnected', () => {
        console.warn('Chromium do renderizador desconectou/caiu -- sera relancado na proxima impressao.');
        browserPromise = null;
      });
      return browser;
    });
  }
  return browserPromise;
}

async function renderizarComPuppeteer(html, { larguraPx, alturaPx, dpi, timeoutMs }) {
  const deviceScaleFactor = dpi / CSS_DPI;
  const larguraCss = Math.round(larguraPx / deviceScaleFactor);
  const alturaCss = Math.round(alturaPx / deviceScaleFactor);

  // Tenta 2x: se o Chromium ja tiver caido bem no meio dessa chamada (o
  // evento "disconnected" ainda nao rodou a tempo de limpar o cache pra
  // essa requisicao especifica), a 1a tentativa falha com "Connection
  // closed" -- forca relancar e tenta mais uma vez antes de desistir.
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    let browser;
    try {
      browser = await getBrowser();
      const page = await browser.newPage();
      try {
        await page.setJavaScriptEnabled(false);
        await page.setViewport({ width: larguraCss, height: alturaCss, deviceScaleFactor });
        await page.setContent(html, { waitUntil: 'load', timeout: timeoutMs });
        return await page.screenshot({
          type: 'png',
          clip: { x: 0, y: 0, width: larguraCss, height: alturaCss },
        });
      } finally {
        await page.close().catch(() => {});
      }
    } catch (err) {
      browserPromise = null; // forca relancar um Chromium novo
      if (tentativa === 2) throw err;
    }
  }
}

// ---------------------------------------------------------------------------

async function renderizarHtmlParaPng(html, { larguraPx, alturaPx, dpi = CSS_DPI, timeoutMs = 10000 }) {
  const opts = { larguraPx, alturaPx, dpi, timeoutMs };
  return EM_ELECTRON ? renderizarComElectron(html, opts) : renderizarComPuppeteer(html, opts);
}

async function fecharBrowser() {
  if (EM_ELECTRON || !browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}

// Chama getBrowser() de proposito assim que o servidor sobe, pra Chromium
// ja estar pronto quando a primeira impressao de verdade chegar (subir do
// zero leva uns 5-10s, o que faria a primeira request do site parecer travada).
// No Electron o Chromium ja esta de pe junto com o app.
function aquecerBrowser() {
  return EM_ELECTRON ? Promise.resolve() : getBrowser();
}

module.exports = { renderizarHtmlParaPng, fecharBrowser, aquecerBrowser };
