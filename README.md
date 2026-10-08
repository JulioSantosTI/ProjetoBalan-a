# Balanca via Irxon (Bluetooth) -> WebSocket local

Servidor Node.js que le a balanca atraves do adaptador Irxon (Bluetooth SPP,
aparece como porta COM virtual no Windows) e retransmite as leituras em tempo
real por WebSocket na porta 3000, para um site consumir.

## App Agente WMS (instalador .exe)

O agente roda como um aplicativo Windows (Electron): fica na bandeja perto do
relogio, inicia com o Windows e tem uma janela de configuracao protegida por
senha (impressoras de Etiqueta/Cupom, balanca, porta, teste de impressao).
A configuracao fica em `C:\ProgramData\AgenteWMS\config.json`, ou seja, e da
maquina, nao do usuario logado no WMS.

**Senha:** cada maquina tem a sua, definida na instalacao (pagina "Senha do
Agente WMS", com confirmar e mostrar senha -- `build/installer.nsh`). Fica so
o hash em `C:\ProgramData\AgenteWMS\senha.json`, gravado como administrador:
usuarios comuns nao conseguem apagar nem trocar. Esqueceu a senha? Reinstale
o agente e defina outra. Instalacao silenciosa (`/S`) mantem a senha atual.

- Abrir o app em desenvolvimento: `npm run app` (sem senha definida, a janela
  avisa; para testar: `set CONFIG_DIR=...` e
  `set AGENTE_WMS_NOVA_SENHA=... && npx electron . --definir-senha`)
- Gerar o instalador: `npm run dist` -> `dist\AgenteWMS-Setup-<versao>.exe`
- Publicar no WMS: copiar para `<STORAGE_ROOT>\agente\AgenteWMS-Setup.exe`
  no servidor do back (botao "Baixar instalador" da Gestao de impressoras).

Sem o app (so o servidor, como antes): `npm start`.

## Como rodar

1. Pareie o Irxon com o notebook pelo Bluetooth do Windows (Configuracoes >
   Dispositivos > Bluetooth). Depois de pareado, o Windows cria uma porta COM
   virtual para ele.

2. Descubra qual porta COM foi criada:

   ```bash
   npm run ports
   ```

3. Copie `.env.example` para `.env` (ja feito neste projeto) e ajuste:
   - `SERIAL_PORT`: a porta que apareceu no passo 2 (ex: `COM5`). Se deixar
     como `auto` (ou remover a linha), o servidor testa sozinho todas as
     portas disponiveis no start e a cada reconexao, e usa a primeira que
     realmente estiver mandando dados -- funciona tanto com a balanca
     ligada por cabo serial/USB quanto pareada via Bluetooth (Irxon), sem
     precisar trocar essa config quando o Windows muda o numero da porta.
   - `BAUD_RATE`: velocidade da serial da balanca (9600 e o mais comum, mas
     confira o manual da balanca se os dados vierem ilegiveis)

4. Instale as dependencias (so na primeira vez):

   ```bash
   npm install
   ```

5. Suba o servidor:

   ```bash
   npm start
   ```

   Abra `http://localhost:3000` no navegador para ver uma pagina de teste com
   o peso ao vivo e o log das linhas cruas recebidas da balanca.

## Calibrando o protocolo da balanca

O Irxon so repassa os bytes que a balanca manda pela serial dela -- ele nao
define o formato dos dados. Como ainda nao sabemos o formato exato da sua
balanca, o servidor:

- Mostra toda linha crua recebida no console e na pagina de teste (secao de
  log preto embaixo do peso).
- Tenta extrair um numero + unidade automaticamente (`src/parser.js`), o que
  cobre a maioria dos formatos tipo `ST,GS,+00012.34kg` ou `+0000.450 kg`.

Coloque algo na balanca, veja o que aparece no log de linhas cruas e me
mostre -- ajusto o `parsePeso` em `src/parser.js` para o formato exato da sua
balanca se o automatico nao pegar direito.

## Como o site consome os dados

Conectar via WebSocket em `ws://localhost:3000` (ou `ws://IP-DO-NOTEBOOK:3000`
se o site rodar em outra maquina na mesma rede). Mensagens chegam em JSON:

```json
{ "type": "status", "conectado": true, "porta": "COM5" }
{ "type": "peso", "peso": 12.34, "unidade": "kg", "estavel": true, "raw": "ST,GS,+00012.34kg", "timestamp": 1737200000000 }
{ "type": "linha", "raw": "ST,GS,+00012.34kg", "timestamp": 1737200000000 }
```

Exemplo minimo em JS:

```js
const ws = new WebSocket('ws://localhost:3000');
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'peso') console.log(msg.peso, msg.unidade);
};
```

Se a conexao com a balanca cair (Bluetooth fora de alcance, por exemplo), o
servidor tenta reconectar sozinho a cada 5 segundos e avisa os clientes
conectados via mensagem `type: "status"`.
