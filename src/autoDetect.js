const { SerialPort } = require('serialport');

// Acha automaticamente em qual porta a balanca esta. Nao importa se ela
// chega via cabo serial/USB direto, adaptador Bluetooth pareado, ou um
// conversor IR (ex: IR220) -- todos aparecem como porta COM no Windows,
// entao a deteccao e a mesma: abre cada porta disponivel, habilita DTR/RTS
// (necessario pra ligar adaptadores alimentados pela propria serial),
// manda o comando de solicitacao e ve qual porta responde dentro do prazo.
async function detectarPorta({ baudRate, timeoutMs = 2500, comando = Buffer.from('\r\n') }) {
  const portas = await SerialPort.list();

  for (const info of portas) {
    const respondeu = await testarPorta(info.path, baudRate, timeoutMs, comando);
    if (respondeu) return info.path;
  }

  return null;
}

function testarPorta(path, baudRate, timeoutMs, comando) {
  return new Promise((resolve) => {
    let resolvido = false;

    const port = new SerialPort({ path, baudRate, rtscts: false }, (err) => {
      if (err) finalizar(false);
    });

    const timer = setTimeout(() => finalizar(false), timeoutMs);

    port.once('open', () => {
      port.set({ dtr: true, rts: true }, () => port.write(comando));
    });
    port.once('data', () => finalizar(true));
    port.once('error', () => finalizar(false));

    function finalizar(sucesso) {
      if (resolvido) return;
      resolvido = true;
      clearTimeout(timer);
      port.removeAllListeners();
      if (port.isOpen) port.close(() => resolve(sucesso));
      else resolve(sucesso);
    }
  });
}

module.exports = { detectarPorta };
