const { SerialPort } = require('serialport');

SerialPort.list().then((portas) => {
  if (portas.length === 0) {
    console.log('Nenhuma porta serial encontrada. Verifique se o Irxon esta pareado via Bluetooth.');
    return;
  }
  console.log('Portas seriais disponiveis:\n');
  for (const p of portas) {
    console.log(`${p.path}  -  ${p.friendlyName || p.manufacturer || 'sem descricao'}`);
  }
});
