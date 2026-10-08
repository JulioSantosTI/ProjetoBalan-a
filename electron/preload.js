const { contextBridge, ipcRenderer } = require('electron');

// Unica ponte entre a janela (HTML) e o processo principal.
contextBridge.exposeInMainWorld('agente', {
  statusSenha: () => ipcRenderer.invoke('auth:status'),
  entrar: (senha) => ipcRenderer.invoke('auth:entrar', senha),
  bloquear: () => ipcRenderer.invoke('auth:bloquear'),
  obterEstado: () => ipcRenderer.invoke('estado:obter'),
  estadoBalanca: () => ipcRenderer.invoke('balanca:estado'),
  salvarImpressoras: (impressoras) => ipcRenderer.invoke('impressoras:salvar', impressoras),
  testarImpressora: (dados) => ipcRenderer.invoke('impressoras:testar', dados),
  salvarBalanca: (balanca) => ipcRenderer.invoke('balanca:salvar', balanca),
  salvarAgente: (dados) => ipcRenderer.invoke('agente:salvar', dados),
  sair: (senha) => ipcRenderer.invoke('app:sair', senha),
  aoPedirSenhaSair: (fn) => ipcRenderer.on('sair:pedir-senha', () => fn()),
  aoBloquear: (fn) => ipcRenderer.on('sessao:bloqueada', () => fn()),
});
