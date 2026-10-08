const path = require('path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, dialog } = require('electron');
const { senhaDefinida, senhaConfere, definirSenha } = require('./senhaMaster');

// Chamado pelo instalador (build/installer.nsh) logo depois de copiar os
// arquivos: grava a senha digitada na instalacao e sai, sem abrir nada.
// A senha chega por variavel de ambiente para nao aparecer na linha de comando.
if (process.argv.includes('--definir-senha')) {
  try {
    definirSenha(process.env.AGENTE_WMS_NOVA_SENHA || '');
    process.exit(0);
  } catch (err) {
    console.error('Falha ao definir a senha do agente:', err.message);
    process.exit(1);
  }
}

const { SerialPort } = require('serialport');
const { obterConfig, salvarConfig, listarImpressorasWindows, BAUD_RATES, CONFIG_FILE } = require('../src/agenteConfig');
const { iniciarServidor, pararServidor, estadoBalanca } = require('../src/server');
const { imprimirHtml } = require('../src/printer');

// Aberto pelo Windows no login (atalho de inicializacao) -> sobe so na bandeja.
const INICIAR_OCULTO = process.argv.includes('--oculto');
const ICONE = path.join(__dirname, '..', 'assets', 'icon.png');

let janela = null;
let tray = null;
let autenticado = false;
let erroServidor = null;
let saindo = false;

// Um agente por maquina: abrir o atalho de novo so mostra a janela existente.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => mostrarJanela());
  app.whenReady().then(iniciar);
}

async function iniciar() {
  aplicarInicioComWindows(obterConfig().iniciarComWindows);

  try {
    await iniciarServidor();
  } catch (err) {
    erroServidor =
      err.code === 'EADDRINUSE'
        ? `A porta ${obterConfig().porta} ja esta em uso por outro programa. Troque a porta na aba Agente.`
        : err.message;
    console.error('Falha ao subir o servidor:', err.message);
  }

  criarTray();
  if (!INICIAR_OCULTO || erroServidor) mostrarJanela();
}

function criarJanela() {
  janela = new BrowserWindow({
    width: 960,
    height: 680,
    minWidth: 760,
    minHeight: 560,
    title: 'Agente WMS',
    icon: ICONE,
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  janela.removeMenu();
  janela.loadFile(path.join(__dirname, 'ui', 'index.html'));
  janela.once('ready-to-show', () => janela.show());

  // Fechar a janela so esconde: o agente continua imprimindo na bandeja.
  // Ao esconder, a senha volta a ser pedida na proxima abertura.
  janela.on('close', (e) => {
    if (saindo) return;
    e.preventDefault();
    janela.hide();
    autenticado = false;
    janela.webContents.send('sessao:bloqueada');
  });
}

function mostrarJanela() {
  if (!janela) criarJanela();
  else {
    janela.show();
    janela.focus();
  }
}

function criarTray() {
  const imagem = nativeImage.createFromPath(ICONE).resize({ width: 16, height: 16 });
  tray = new Tray(imagem);
  tray.setToolTip(`Agente WMS — porta ${obterConfig().porta}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir configuracoes', click: () => mostrarJanela() },
      { type: 'separator' },
      {
        label: 'Sair do agente',
        click: () => {
          // Sair para de imprimir nesta maquina: pede a senha master na janela.
          mostrarJanela();
          janela.webContents.send('sair:pedir-senha');
        },
      },
    ])
  );
  tray.on('double-click', () => mostrarJanela());
}

function aplicarInicioComWindows(ativo) {
  // Em desenvolvimento registraria o electron.exe solto -- so faz sentido instalado.
  if (!app.isPackaged) return;
  app.setLoginItemSettings({ openAtLogin: ativo, args: ['--oculto'] });
}

// Porta e balanca so sao lidas quando o servidor sobe: reinicia o app.
function reiniciarApp() {
  saindo = true;
  app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--oculto') });
  app.exit(0);
}

function exigirAutenticacao() {
  if (!autenticado) throw new Error('Sessao bloqueada: informe a senha master.');
}

function htmlTeste({ funcao, nome }) {
  const agora = new Date().toLocaleString('pt-BR');
  return `<div style="box-sizing:border-box;width:100%;height:100%;padding:3mm;border:0.6mm solid #000;font-family:Arial,sans-serif;display:flex;gap:3mm;align-items:center">
  <div style="flex:1;min-width:0">
    <div style="font-size:5mm;font-weight:bold">TESTE DE IMPRESSAO</div>
    <div style="font-size:3.5mm;margin-top:1.5mm">Funcao: <b>${funcao.toUpperCase()}</b></div>
    <div style="font-size:3mm;margin-top:1mm;word-break:break-all">${nome.replace(/[<>&"]/g, '')}</div>
    <div style="font-size:3mm;margin-top:1mm">${agora}</div>
  </div>
  <div style="width:20mm;height:20mm">{{QRCODE}}</div>
</div>`;
}

// --- IPC (janela -> processo principal) -------------------------------------

ipcMain.handle('auth:status', () => ({ senhaDefinida: senhaDefinida() }));

ipcMain.handle('auth:entrar', (_e, senha) => {
  autenticado = senhaConfere(senha);
  return autenticado;
});

ipcMain.handle('auth:bloquear', () => {
  autenticado = false;
});

ipcMain.handle('estado:obter', async () => {
  exigirAutenticacao();
  const [impressoras, portasSeriais] = await Promise.all([
    listarImpressorasWindows().catch(() => []),
    SerialPort.list().catch(() => []),
  ]);
  return {
    versao: app.getVersion(),
    configFile: CONFIG_FILE,
    config: obterConfig(),
    servidor: { ok: !erroServidor, erro: erroServidor },
    impressoras,
    portasSeriais: portasSeriais.map((p) => ({
      path: p.path,
      descricao: p.friendlyName || p.manufacturer || '',
    })),
    baudRates: BAUD_RATES,
    balanca: estadoBalanca(),
  };
});

ipcMain.handle('balanca:estado', () => {
  exigirAutenticacao();
  return estadoBalanca();
});

ipcMain.handle('impressoras:salvar', (_e, impressoras) => {
  exigirAutenticacao();
  return salvarConfig({ impressoras });
});

ipcMain.handle('impressoras:testar', async (_e, { funcao, nome, larguraMm, alturaMm }) => {
  exigirAutenticacao();
  await imprimirHtml({
    html: htmlTeste({ funcao, nome }),
    larguraMm,
    alturaMm,
    qrcode: { valor: `TESTE-${funcao}-${Date.now()}` },
    impressora: nome,
  });
  return true;
});

ipcMain.handle('balanca:salvar', (_e, balanca) => {
  exigirAutenticacao();
  salvarConfig({ balanca });
  reiniciarApp();
});

ipcMain.handle('agente:salvar', (_e, { porta, iniciarComWindows }) => {
  exigirAutenticacao();
  const antes = obterConfig();
  const depois = salvarConfig({ porta, iniciarComWindows });
  aplicarInicioComWindows(depois.iniciarComWindows);
  if (depois.porta !== antes.porta) reiniciarApp();
  return depois;
});

ipcMain.handle('app:sair', async (_e, senha) => {
  if (!senhaConfere(senha)) return false;
  saindo = true;
  await pararServidor().catch(() => {});
  app.exit(0);
  return true;
});

// Sem janelas abertas o app continua vivo na bandeja.
app.on('window-all-closed', () => {});

process.on('uncaughtException', (err) => {
  console.error('Erro inesperado:', err);
  if (app.isReady() && !app.isPackaged) dialog.showErrorBox('Agente WMS', err.stack || err.message);
});
