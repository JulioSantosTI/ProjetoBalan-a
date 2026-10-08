const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { CONFIG_DIR } = require('../src/agenteConfig');

// Senha do agente (abrir as configuracoes e fechar o agente). Cada maquina
// tem a sua: e definida na instalacao (pagina "Senha do Agente WMS" do
// instalador, build/installer.nsh), que chama o app com --definir-senha.
//
// Fica so o HASH (scrypt + salt aleatorio), num arquivo proprio -- separado
// do config.json porque e gravado pelo instalador como administrador: o
// usuario comum consegue ler, mas nao apagar nem trocar a senha.
// Esqueceu a senha? Reinstale o agente e defina outra.
const ARQUIVO_SENHA = path.join(CONFIG_DIR, 'senha.json');
const TAMANHO_MINIMO = 6;

function hashSenha(senha, salt) {
  return crypto.scryptSync(String(senha), salt, 32).toString('hex');
}

function lerSenhaSalva() {
  try {
    const { salt, hash } = JSON.parse(fs.readFileSync(ARQUIVO_SENHA, 'utf8'));
    return typeof salt === 'string' && typeof hash === 'string' ? { salt, hash } : null;
  } catch {
    return null;
  }
}

function senhaDefinida() {
  return lerSenhaSalva() !== null;
}

function senhaConfere(senha) {
  const salva = lerSenhaSalva();
  if (!salva) return false;
  const esperado = Buffer.from(salva.hash, 'hex');
  const recebido = Buffer.from(hashSenha(senha, salva.salt), 'hex');
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}

function definirSenha(senha) {
  if (typeof senha !== 'string' || senha.length < TAMANHO_MINIMO) {
    throw new Error(`a senha precisa ter pelo menos ${TAMANHO_MINIMO} caracteres`);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(ARQUIVO_SENHA, JSON.stringify({ salt, hash: hashSenha(senha, salt) }));
}

module.exports = { senhaDefinida, senhaConfere, definirSenha, ARQUIVO_SENHA };
