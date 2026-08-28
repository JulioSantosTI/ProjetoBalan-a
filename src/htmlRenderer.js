const puppeteer = require('puppeteer');

// Mantem um unico Chromium aberto (abrir/fechar a cada impressao seria
// lento, ~1-2s so pra subir o processo). Abrimos/fechamos so a aba (page)
// por requisicao. Se o Chromium cair sozinho (falta de memoria, crash --
// acontece depois de rodar um tempo), o evento "disconnected" limpa o
// cache pra proxima chamada relancar um novo, em vez de ficar preso pra
// sempre reusando uma instancia morta (era a causa do erro "Connection closed").
let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
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

// Unidades fisicas de CSS (mm, in, cm, pt) sao sempre resolvidas pelo
// navegador a 96dpi, independente da resolucao real da impressora -- e a
// definicao do "pixel de referencia" do CSS. Se o HTML do site usa "mm"
// (ex: width:100mm, pensando no tamanho fisico real da etiqueta), o
// viewport tambem precisa ser montado nessa mesma referencia de 96dpi;
// caso contrario o layout do site so preenche uma fracao do canvas.
// deviceScaleFactor faz o Chromium capturar na resolucao real da
// impressora (ex: 203dpi) SEM mexer em como o CSS calcula "mm"/"in".
const CSS_DPI = 96;

// Renderiza HTML vindo de um site de terceiro. JavaScript fica desligado de
// proposito: so queremos desenhar HTML/CSS estatico pra tirar um screenshot,
// nao executar script arbitrario de quem chamou a API.
async function renderizarHtmlParaPng(html, { larguraPx, alturaPx, dpi = CSS_DPI, timeoutMs = 10000 }) {
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

async function fecharBrowser() {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}

// Chama getBrowser() de proposito assim que o servidor sobe, pra Chromium
// ja estar pronto quando a primeira impressao de verdade chegar (subir do
// zero leva uns 5-10s, o que faria a primeira request do site parecer travada).
function aquecerBrowser() {
  return getBrowser();
}

module.exports = { renderizarHtmlParaPng, fecharBrowser, aquecerBrowser };
