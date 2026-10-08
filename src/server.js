require('dotenv').config();
const path = require('path');
const express = require('express');
const { WebSocketServer } = require('ws');
const { SerialReader } = require('./serialReader');
const { detectarPorta } = require('./autoDetect');
const { imprimirTexto, imprimirModelo, imprimirImagem, imprimirHtml } = require('./printer');
const { obterConfig, impressoraPara, listarImpressorasWindows } = require('./agenteConfig');
const { aquecerBrowser, fecharBrowser } = require('./htmlRenderer');

// Porta e balanca vem da config da maquina (app Agente WMS). Mudar qualquer
// uma delas exige reiniciar o agente -- o app faz isso sozinho ao salvar.
const configInicial = obterConfig();
const HTTP_PORT = configInicial.porta;
const SERIAL_PATH_CONFIG = configInicial.balanca.porta;
const AUTO = !SERIAL_PATH_CONFIG || SERIAL_PATH_CONFIG.toLowerCase() === 'auto';
const BAUD_RATE = configInicial.balanca.baudRate;
// Tempo maximo sem receber nenhuma linha da balanca antes de considerar a
// porta "desconectada" de verdade. Necessario porque portas COM virtuais
// (Bluetooth SPP) abrem com sucesso mesmo sem nenhum aparelho por perto --
// o evento "open" sozinho nao prova que a balanca esta respondendo.
const DATA_TIMEOUT_MS = Number(process.env.DATA_TIMEOUT_MS) || 8000;
// Algumas balancas so mandam o peso quando recebem um comando de
// solicitacao pela serial (nao transmitem sozinhas). Por padrao manda
// CRLF a cada 1s enquanto conectado -- ajuste REQUEST_COMMAND se sua
// balanca usar outro comando (ex: "W", "P", "?"), ou REQUEST_INTERVAL_MS=0
// para desligar (balancas que ja transmitem continuamente nao precisam disso).
const REQUEST_INTERVAL_MS = Number(process.env.REQUEST_INTERVAL_MS ?? 1000);
const REQUEST_COMMAND = Buffer.from(
  (process.env.REQUEST_COMMAND || '\\r\\n').replace(/\\r/g, '\r').replace(/\\n/g, '\n'),
  'latin1'
);

// Chave que o site externo precisa mandar no header X-API-Key pra imprimir.
// Sem isso configurado, as rotas de impressao ficam abertas pra qualquer
// requisicao que alcance o servidor -- so aceitavel em teste local.
const PRINT_API_KEY = process.env.PRINT_API_KEY;
if (!PRINT_API_KEY) {
  console.warn('AVISO: PRINT_API_KEY nao definida no .env -- rotas de impressao estao SEM autenticacao.');
}

// Intervalo minimo entre impressoes, pra um bug/abuso no site nao esgotar
// etiquetas fisicas mandando print em loop.
const INTERVALO_MIN_IMPRESSAO_MS = Number(process.env.INTERVALO_MIN_IMPRESSAO_MS) || 1500;
let ultimaImpressaoEm = 0;

function exigirApiKey(req, res, next) {
  if (!PRINT_API_KEY) return next();
  if (req.header('X-API-Key') !== PRINT_API_KEY) {
    return res.status(401).json({ ok: false, erro: 'API key invalida ou ausente (header X-API-Key)' });
  }
  next();
}

function limitarTaxaImpressao(req, res, next) {
  const agora = Date.now();
  if (agora - ultimaImpressaoEm < INTERVALO_MIN_IMPRESSAO_MS) {
    return res.status(429).json({ ok: false, erro: 'muitas impressoes em sequencia, aguarde um pouco' });
  }
  ultimaImpressaoEm = agora;
  next();
}

const app = express();
// Limite pequeno pro corpo padrao (texto/modelo em JSON); a rota de imagem
// usa um parser proprio com limite maior, ja que PNG em base64 pesa mais.
const jsonPequeno = express.json({ limit: '20kb' });
const jsonImagem = express.json({ limit: '3mb' });

// Permite que um site em outro dominio (fora do localhost) chame essa API
// pelo navegador. Restrinja com CORS_ORIGIN no .env em producao (ex:
// "https://meusite.com") -- "*" e so pra desenvolvimento/teste.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  // O WMS (site na internet) chama este agente em 127.0.0.1. O Chrome so
  // libera isso se o preflight confirmar que o acesso a rede local e esperado.
  if (req.header('Access-Control-Request-Private-Network') === 'true') {
    res.header('Access-Control-Allow-Private-Network', 'true');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.post('/imprimir', jsonPequeno, exigirApiKey, limitarTaxaImpressao, async (req, res) => {
  const texto = (req.body && req.body.texto) || '';
  if (!texto.trim()) return res.status(400).json({ ok: false, erro: 'texto vazio' });

  try {
    await imprimirTexto(texto);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao imprimir:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Modelo estruturado: texto, codigo de barras e qrcode combinados numa
// etiqueta so. Corpo esperado:
// { "elementos": [...], "larguraMm": 50, "alturaMm": 30, "gapMm": 2 }
app.post('/imprimir/modelo', jsonPequeno, exigirApiKey, limitarTaxaImpressao, async (req, res) => {
  try {
    await imprimirModelo(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao imprimir modelo:', err.message);
    res.status(400).json({ ok: false, erro: err.message });
  }
});

// "O que voce ve e o que sai": o site manda um PNG (ex: canvas.toDataURL())
// e a gente imprime pixel a pixel, em vez de descrever a etiqueta em
// comandos. Corpo esperado:
// { "imagemBase64": "data:image/png;base64,....", "larguraMm": 50, "alturaMm": 30 }
app.post('/imprimir/imagem', jsonImagem, exigirApiKey, limitarTaxaImpressao, async (req, res) => {
  try {
    await imprimirImagem(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao imprimir imagem:', err.message);
    res.status(400).json({ ok: false, erro: err.message });
  }
});

// O site manda um trecho de HTML/CSS (o "modelo" que muda) e a gente
// renderiza num Chromium headless do tamanho exato da etiqueta fisica
// (max 100x50mm) e imprime como bitmap. Corpo esperado:
// { "html": "<div style=\"...\">...</div>", "larguraMm": 100, "alturaMm": 50 }
// Se o HTML tiver {{PESO}} e o corpo nao mandar "peso" explicito, usa a
// ultima leitura que o servidor ja conhece (real ou via /peso/simular) --
// e o mesmo valor que aparece em GET /peso. Mandar "peso" explicito trava
// nesse valor (util se o site ja leu o peso via WebSocket antes de
// imprimir, evitando que a balanca mude entre a leitura e a impressao).
function corpoComPesoAtual(req) {
  const corpo = { ...req.body };
  if (corpo.peso === undefined && ultimaLeitura) {
    corpo.peso = ultimaLeitura.peso;
    corpo.unidade = ultimaLeitura.unidade;
  }
  return corpo;
}

app.post('/imprimir/etiqueta/html', jsonImagem, exigirApiKey, limitarTaxaImpressao, async (req, res) => {
  try {
    await imprimirHtml(corpoComPesoAtual(req));
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao imprimir html:', err.message);
    res.status(400).json({ ok: false, erro: err.message });
  }
});

// Segunda impressora (cupom/recibo) -- mesma coisa que /imprimir/etiqueta/html,
// so manda pro nome de fila configurado em PRINTER_NAME_CUPOM no .env em vez
// da impressora de etiqueta. Mesmo corpo, mesmos ganchos ({{QRCODE}},
// {{PESO}}), mesma logica de renderizacao.
app.post('/imprimir/cupom/html', jsonImagem, exigirApiKey, limitarTaxaImpressao, async (req, res) => {
  try {
    await imprimirHtml({ ...corpoComPesoAtual(req), impressora: impressoraPara('cupom') });
    res.json({ ok: true });
  } catch (err) {
    console.error('Erro ao imprimir cupom:', err.message);
    res.status(400).json({ ok: false, erro: err.message });
  }
});

// Impressoras que o Windows desta maquina enxerga + qual delas faz etiqueta e
// qual faz cupom. So leitura: a tela "Gestao de impressoras" do WMS mostra,
// mas alterar e so pelo app Agente WMS (protegido pela senha master).
app.get('/impressoras', async (req, res) => {
  try {
    const impressoras = await listarImpressorasWindows();
    res.json({ ok: true, impressoras, config: obterConfig().impressoras });
  } catch (err) {
    console.error('Erro ao listar impressoras:', err.message);
    res.status(500).json({ ok: false, erro: err.message });
  }
});

// Ultima leitura da balanca, pra quem nao quer manter WebSocket aberto e so
// precisa consultar o valor atual de vez em quando (ex: antes de imprimir).
// Mesma info que ja e transmitida em tempo real por WS, so que sob demanda.
app.get('/peso', (req, res) => {
  res.json({
    conectado,
    porta: portaAtual,
    peso: ultimaLeitura ? ultimaLeitura.peso : null,
    unidade: ultimaLeitura ? ultimaLeitura.unidade : null,
    estavel: ultimaLeitura ? ultimaLeitura.estavel : null,
    timestamp: ultimaLeitura ? ultimaLeitura.timestamp : null,
  });
});

// Liga o modo simulado (pausa a busca pela balanca real e marca
// "conectado: true") sem mandar nenhum peso ainda -- util pra testar a
// conexao em si (ex: o site abrir o WebSocket e ver "conectado") antes de
// mandar qualquer leitura. Depois disso, chame /peso/simular quantas vezes
// quiser pra mandar pesos.
app.post('/peso/simular/iniciar', jsonPequeno, exigirApiKey, (req, res) => {
  modoSimulado = true;
  conectado = true;
  portaAtual = portaAtual || 'SIMULADO';
  broadcast({ type: 'status', conectado: true, porta: portaAtual });
  res.json({ ok: true, modoSimulado, conectado, porta: portaAtual });
});

// Gera uma leitura de peso falsa (aleatoria a cada chamada, a menos que
// "peso" seja mandado no corpo) e transmite como se fosse real -- tanto no
// WebSocket quanto no GET /peso -- pra testar a integracao completa (site
// ou a propria pagina de teste) sem precisar da balanca fisica ligada.
// Tambem marca "conectado: true", manda o "status" atualizado, e PAUSA o
// loop de reconexao da balanca real (senao ele ficaria tentando abrir a
// porta serial de verdade a cada 5s e sobrescrevendo o "conectado" de
// volta pra false). Chame /peso/simular/parar quando for ligar a balanca
// de verdade, pra voltar a procurar ela normalmente.
// Corpo opcional: { "peso": 12.5, "unidade": "kg" }
app.post('/peso/simular', jsonPequeno, exigirApiKey, (req, res) => {
  const corpo = req.body || {};
  const peso = Number.isFinite(corpo.peso) ? corpo.peso : Math.round((Math.random() * 20 + 0.1) * 1000) / 1000;
  const unidade = typeof corpo.unidade === 'string' && corpo.unidade.trim() ? corpo.unidade.trim() : 'kg';

  modoSimulado = true;
  if (!conectado) {
    conectado = true;
    portaAtual = portaAtual || 'SIMULADO';
    broadcast({ type: 'status', conectado: true, porta: portaAtual });
  }

  ultimaLeitura = {
    type: 'peso',
    peso,
    unidade,
    estavel: true,
    raw: `SIMULADO,${peso}${unidade}`,
    timestamp: Date.now(),
  };
  broadcast(ultimaLeitura);

  res.json({ ok: true, modoSimulado, ...ultimaLeitura });
});

// Desliga o modo simulado e volta a procurar a balanca real normalmente.
// Chame isso quando for ligar a balanca de verdade pra valer.
app.post('/peso/simular/parar', jsonPequeno, exigirApiKey, (req, res) => {
  modoSimulado = false;
  conectado = false;
  ultimaLeitura = null;
  broadcast({ type: 'status', conectado: false, porta: portaAtual, erro: 'modo simulado desligado, procurando balanca real' });
  conectarBalanca();
  res.json({ ok: true, modoSimulado });
});

let server = null;
let wss = null;

// Sobe HTTP + WebSocket + balanca. Chamado pelo app Electron (electron/main.js)
// ou direto via "npm start" em desenvolvimento.
function iniciarServidor() {
  return new Promise((resolve, reject) => {
    server = app.listen(HTTP_PORT, () => {
      console.log(`Servidor rodando em http://localhost:${HTTP_PORT}`);
      console.log(`WebSocket disponivel em ws://localhost:${HTTP_PORT}`);
      aquecerBrowser()
        .then(() => console.log('Chromium pronto para impressao via HTML.'))
        .catch((err) => console.error('Falha ao aquecer o Chromium:', err.message));
      resolve();
    });
    server.once('error', reject);

    wss = new WebSocketServer({ server });
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({ type: 'status', conectado, porta: portaAtual }));
      if (ultimaLeitura) ws.send(JSON.stringify(ultimaLeitura));
    });

    conectarBalanca();
  });
}

async function pararServidor() {
  await fecharBrowser().catch(() => {});
  if (server) await new Promise((resolve) => server.close(() => resolve()));
}

// Estado da balanca pro app mostrar (mesma info do GET /peso).
function estadoBalanca() {
  return { conectado, porta: portaAtual, modoSimulado, ultimaLeitura };
}

function broadcast(mensagem) {
  if (!wss) return;
  const payload = JSON.stringify(mensagem);
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(payload);
  }
}

let ultimaLeitura = null;
let conectado = false;
let reconectando = false;
let portaAtual = AUTO ? null : SERIAL_PATH_CONFIG;
// Enquanto true, o loop de reconexao da balanca REAL fica pausado -- sem
// isso, ele ficaria tentando abrir a porta serial de verdade a cada 5s e
// sobrescrevendo o "conectado: true" simulado de volta pra false a cada
// tentativa que falhasse. Ativado por /peso/simular, desativado por
// /peso/simular/parar (volta a tentar achar a balanca real de verdade).
let modoSimulado = false;

function agendarReconexao() {
  if (reconectando) return;
  reconectando = true;
  console.warn('Tentando reconectar na balanca em 5s...');
  setTimeout(() => {
    reconectando = false;
    conectarBalanca();
  }, 5000);
}

async function conectarBalanca() {
  if (modoSimulado) return; // pausado enquanto estiver testando com peso simulado

  let porta = SERIAL_PATH_CONFIG;

  if (AUTO) {
    console.log('Procurando a balanca automaticamente (cabo serial ou Bluetooth pareado)...');
    porta = await detectarPorta({ baudRate: BAUD_RATE });
    if (!porta) {
      console.warn('Nenhuma porta respondeu. Verifique se a balanca esta ligada e o Bluetooth/cabo conectado.');
      broadcast({ type: 'status', conectado: false, porta: null, erro: 'balanca nao encontrada' });
      agendarReconexao();
      return;
    }
  }

  portaAtual = porta;
  const reader = new SerialReader({ path: porta, baudRate: BAUD_RATE });

  let watchdog = null;
  function resetWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      console.warn(`Nenhum dado recebido de ${porta} em ${DATA_TIMEOUT_MS}ms - balanca parece desconectada.`);
      conectado = false;
      broadcast({ type: 'status', conectado: false, porta, erro: 'sem dados da balanca' });
      reader.stop();
    }, DATA_TIMEOUT_MS);
  }

  let intervaloSolicitacao = null;

  reader.on('open', () => {
    console.log(`Porta ${porta} aberta (${BAUD_RATE} baud), aguardando dados da balanca...`);
    resetWatchdog();

    if (REQUEST_INTERVAL_MS > 0) {
      reader.solicitar(REQUEST_COMMAND);
      intervaloSolicitacao = setInterval(() => reader.solicitar(REQUEST_COMMAND), REQUEST_INTERVAL_MS);
    }
  });

  reader.on('linha', (linha) => {
    console.log('linha recebida:', linha);
    if (!conectado) {
      conectado = true;
      console.log(`Balanca respondendo em ${porta}`);
      broadcast({ type: 'status', conectado: true, porta });
    }
    resetWatchdog();
    broadcast({ type: 'linha', raw: linha, timestamp: Date.now() });
  });

  reader.on('peso', (leitura) => {
    ultimaLeitura = { type: 'peso', ...leitura, timestamp: Date.now() };
    broadcast(ultimaLeitura);
  });

  reader.on('error', (err) => {
    clearTimeout(watchdog);
    clearInterval(intervaloSolicitacao);
    console.error('Erro na porta serial:', err.message);
    conectado = false;
    broadcast({ type: 'status', conectado: false, porta, erro: err.message });
    agendarReconexao();
  });

  reader.on('close', () => {
    clearTimeout(watchdog);
    clearInterval(intervaloSolicitacao);
    conectado = false;
    broadcast({ type: 'status', conectado: false, porta });
    agendarReconexao();
  });

  reader.start();
}

module.exports = { iniciarServidor, pararServidor, estadoBalanca };

// "npm start" (sem o app): sobe direto, como antes.
if (require.main === module) {
  iniciarServidor().catch((err) => {
    console.error('Falha ao subir o servidor:', err.message);
    process.exit(1);
  });
  process.on('SIGINT', async () => {
    await pararServidor();
    process.exit(0);
  });
}
