require('dotenv').config({ quiet: true });
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Configuracao DESTA maquina (impressoras, balanca, porta do agente). Fica
// num arquivo local -- e nao no cadastro do usuario no WMS -- pra acompanhar
// o PC: qualquer usuario que logar aqui usa as impressoras/balanca daqui.
// ProgramData porque, instalado como .exe, a pasta do programa nao e
// gravavel. CONFIG_DIR no .env sobrescreve (util em desenvolvimento).
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(process.env.PROGRAMDATA || os.homedir(), 'AgenteWMS');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const FUNCOES = ['etiqueta', 'cupom'];
const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];

// Sem arquivo salvo ainda, cai no .env (comportamento antigo do agente), pra
// nao quebrar quem ja usa antes de abrir o app de configuracao.
function configPadrao() {
  return {
    porta: Number(process.env.HTTP_PORT) || 3001,
    iniciarComWindows: true,
    impressoras: {
      etiqueta: process.env.PRINTER_NAME || 'LABEL',
      cupom: process.env.PRINTER_NAME_CUPOM || 'CUPOM',
    },
    balanca: {
      porta: process.env.SERIAL_PORT || 'auto',
      baudRate: Number(process.env.BAUD_RATE) || 9600,
    },
  };
}

function normalizar(bruto) {
  const padrao = configPadrao();
  const cfg = bruto && typeof bruto === 'object' ? bruto : {};

  const porta = Number(cfg.porta);
  const impressoras = {};
  for (const funcao of FUNCOES) {
    const nome = cfg.impressoras?.[funcao];
    impressoras[funcao] =
      nome === null ? null : typeof nome === 'string' && nome.trim() ? nome : padrao.impressoras[funcao];
  }
  const portaBalanca = cfg.balanca?.porta;
  const baudRate = Number(cfg.balanca?.baudRate);

  return {
    porta: Number.isInteger(porta) && porta >= 1024 && porta <= 65535 ? porta : padrao.porta,
    iniciarComWindows: typeof cfg.iniciarComWindows === 'boolean' ? cfg.iniciarComWindows : padrao.iniciarComWindows,
    impressoras,
    balanca: {
      porta: typeof portaBalanca === 'string' && portaBalanca.trim() ? portaBalanca : padrao.balanca.porta,
      baudRate: BAUD_RATES.includes(baudRate) ? baudRate : padrao.balanca.baudRate,
    },
  };
}

function carregar() {
  try {
    return normalizar(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Falha ao ler config do agente, usando .env:', err.message);
    return normalizar(null);
  }
}

let configAtual = carregar();

function obterConfig() {
  return structuredClone(configAtual);
}

// Mescla o parcial no que ja existe e grava. Devolve a config final.
function salvarConfig(parcial) {
  const novo = normalizar({
    ...configAtual,
    ...parcial,
    impressoras: { ...configAtual.impressoras, ...parcial.impressoras },
    balanca: { ...configAtual.balanca, ...parcial.balanca },
  });
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(novo, null, 2));
  configAtual = novo;
  return obterConfig();
}

// Nome da impressora do Windows para a funcao, ou erro claro se esta maquina
// nao tiver nenhuma configurada pra ela.
function impressoraPara(funcao) {
  const nome = configAtual.impressoras[funcao];
  if (!nome) {
    throw new Error(`Esta maquina nao tem impressora de ${funcao} configurada.`);
  }
  return nome;
}

// Impressoras que o Windows enxerga: USB/locais, compartilhadas de outro PC
// (\\PC\NOME) e de rede. Pro agente sao todas iguais -- so um nome de fila.
function listarImpressorasWindows() {
  const script =
    'Get-Printer | Select-Object Name,PortName,Type,Shared,PrinterStatus | ConvertTo-Json -Compress';
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      const texto = stdout.trim();
      if (!texto) return resolve([]);
      let lista;
      try {
        lista = JSON.parse(texto);
      } catch {
        return reject(new Error('resposta inesperada do Get-Printer'));
      }
      // ConvertTo-Json devolve objeto (nao array) quando so tem 1 impressora.
      if (!Array.isArray(lista)) lista = [lista];
      resolve(
        lista.map((p) => ({
          nome: p.Name,
          porta: p.PortName || null,
          // Type: 0/"Local" = instalada nesta maquina; 1/"Connection" = compartilhada de outro PC.
          compartilhadaDeOutroPc: p.Type === 1 || p.Type === 'Connection',
          // PrinterStatus: 0/"Normal" = pronta. Outros valores = offline, erro, sem papel...
          pronta: p.PrinterStatus === 0 || p.PrinterStatus === 'Normal',
        }))
      );
    });
  });
}

module.exports = {
  FUNCOES,
  BAUD_RATES,
  CONFIG_DIR,
  CONFIG_FILE,
  obterConfig,
  salvarConfig,
  impressoraPara,
  listarImpressorasWindows,
};
