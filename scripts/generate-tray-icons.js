const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const polygon = [
  [13, 2],
  [3, 14],
  [12, 14],
  [11, 22],
  [21, 10],
  [12, 10],
];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function pointInPolygon(x, y) {
  let inside = false;
  for (let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current, current += 1) {
    const [currentX, currentY] = polygon[current];
    const [previousX, previousY] = polygon[previous];
    const crosses = (currentY > y) !== (previousY > y) &&
      x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX;
    if (crosses) inside = !inside;
  }
  return inside;
}

function render(size) {
  const samples = 8;
  const rowLength = 1 + (size * 4);
  const raw = Buffer.alloc(rowLength * size);
  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * rowLength;
    raw[rowOffset] = 0;
    for (let x = 0; x < size; x += 1) {
      let coverage = 0;
      for (let sampleY = 0; sampleY < samples; sampleY += 1) {
        for (let sampleX = 0; sampleX < samples; sampleX += 1) {
          const vectorX = ((x + ((sampleX + 0.5) / samples)) / size) * 24;
          const vectorY = ((y + ((sampleY + 0.5) / samples)) / size) * 24;
          if (pointInPolygon(vectorX, vectorY)) coverage += 1;
        }
      }
      const pixelOffset = rowOffset + 1 + (x * 4);
      raw[pixelOffset] = 0;
      raw[pixelOffset + 1] = 0;
      raw[pixelOffset + 2] = 0;
      raw[pixelOffset + 3] = Math.round((coverage / (samples * samples)) * 255);
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [['trayTemplate.png', 18], ['trayTemplate@2x.png', 36]]) {
  fs.writeFileSync(path.join(root, 'assets', name), render(size));
}
console.log('Generated transparent macOS menu bar template icons.');
