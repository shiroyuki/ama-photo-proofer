const sharp = require('sharp');
const { copyFile } = require('node:fs/promises');
Promise.all([
  copyFile('resources/icon.svg', 'public/logo.svg'),
  sharp('resources/icon.svg').png().toFile('public/icon.png'),
  sharp('resources/icon.svg').resize(256, 256).png().toFile('public/logo-preview.png'),
]).catch(error => { console.error(error); process.exitCode = 1; });
