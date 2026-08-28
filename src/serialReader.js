const { SerialPort } = require('serialport');
const { EventEmitter } = require('events');
const { parsePeso } = require('./parser');

// Le a porta serial sem assumir o terminador de linha (algumas balancas usam
// \r, outras \r\n). Acumula bytes e quebra em linhas manualmente, emitindo
// tanto a leitura interpretada quanto a linha crua para calibrar o parser.
class SerialReader extends EventEmitter {
  constructor({ path, baudRate }) {
    super();
    this.path = path;
    this.baudRate = baudRate;
    this.buffer = '';
    this.port = null;
  }

  start() {
    // rtscts:false pq alguns adaptadores (ex: conversores IR como o IR220)
    // usam o pino RTS como fonte de alimentacao, nao como flow control --
    // deixar o driver mexer nesse pino sozinho quebraria a energia do adaptador.
    this.port = new SerialPort({ path: this.path, baudRate: this.baudRate, rtscts: false });

    this.port.on('open', () => {
      // Adaptadores alimentados pelos proprios pinos serial (ex: IR220)
      // precisam de DTR e RTS em nivel alto pra ligar -- sem isso o
      // adaptador fica sem energia e nunca responde nada.
      this.port.set({ dtr: true, rts: true }, (err) => {
        if (err) this.emit('error', err);
      });
      this.emit('open');
    });

    this.port.on('data', (chunk) => {
      this.buffer += chunk.toString('latin1');
      const partes = this.buffer.split(/\r\n|\r|\n/);
      this.buffer = partes.pop();

      for (const linha of partes) {
        if (!linha.trim()) continue;
        this.emit('linha', linha);

        const leitura = parsePeso(linha);
        if (leitura) this.emit('peso', leitura);
      }
    });

    this.port.on('error', (err) => this.emit('error', err));
    this.port.on('close', () => this.emit('close'));

    return this;
  }

  // Algumas balancas nao transmitem sozinhas: so mandam o peso quando
  // recebem um comando de solicitacao pela serial (varia por modelo --
  // CRLF, "W", "P", "?", etc). Use isto pra "cutucar" a balanca.
  solicitar(comando) {
    if (this.port && this.port.isOpen) this.port.write(comando);
  }

  stop() {
    if (this.port && this.port.isOpen) this.port.close();
  }
}

module.exports = { SerialReader };
