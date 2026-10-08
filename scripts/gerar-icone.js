// Gera assets/icon.png (256x256): impressora branca sobre quadrado verde.
// Uso: node scripts/gerar-icone.js
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const N = 256;
const png = new PNG({ width: N, height: N });
const VERDE = [21, 128, 61];
const BRANCO = [255, 255, 255];

function pintar(x, y, [r, g, b], a = 255) {
  const i = (N * y + x) * 4;
  png.data[i] = r;
  png.data[i + 1] = g;
  png.data[i + 2] = b;
  png.data[i + 3] = a;
}

function dentroArredondado(x, y, x0, y0, x1, y1, raio) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + raio), x1 - raio);
  const cy = Math.min(Math.max(y, y0 + raio), y1 - raio);
  return (x - cx) ** 2 + (y - cy) ** 2 <= raio ** 2;
}

// [x0, y0, x1, y1, raio, cor]
const formas = [
  [56, 40, 200, 104, 10, BRANCO], // folha entrando
  [28, 92, 228, 184, 22, BRANCO], // corpo
  [72, 150, 184, 224, 8, BRANCO], // folha saindo
];
// Recortes verdes: fenda da folha e linhas impressas.
const recortes = [
  [56, 140, 200, 150, 0, VERDE],
  [88, 172, 168, 180, 3, VERDE],
  [88, 194, 150, 202, 3, VERDE],
  [184, 112, 204, 124, 6, VERDE], // luz
];

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    pintar(x, y, [0, 0, 0], 0);
    if (!dentroArredondado(x, y, 0, 0, N - 1, N - 1, 56)) continue;
    let cor = VERDE;
    for (const [x0, y0, x1, y1, r, c] of formas) if (dentroArredondado(x, y, x0, y0, x1, y1, r)) cor = c;
    for (const [x0, y0, x1, y1, r, c] of recortes) if (dentroArredondado(x, y, x0, y0, x1, y1, r)) cor = c;
    pintar(x, y, cor);
  }
}

const destino = path.join(__dirname, '..', 'assets', 'icon.png');
fs.mkdirSync(path.dirname(destino), { recursive: true });
fs.writeFileSync(destino, PNG.sync.write(png));
console.log('Icone gerado em', destino);
