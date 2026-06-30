const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

try {
  console.log('1. Running terser to minify oculist.js...');
  const oculistPath = path.join(__dirname, 'oculist.js');
  const tmpPath = path.join(__dirname, 'bookmarklet.min.tmp');
  const minifiedPath = path.join(__dirname, 'bookmarklet.min.js');
  const readmePath = path.join(__dirname, 'README.md');

  // Run terser minification
  execSync(`npx terser "${oculistPath}" -c -m -o "${tmpPath}"`);

  console.log('2. Reading minified code and URL-encoding it...');
  const minifiedCode = fs.readFileSync(tmpPath, 'utf8').trim();
  const encodedCode = 'javascript:' + encodeURIComponent(minifiedCode);

  console.log('3. Writing to bookmarklet.min.js...');
  fs.writeFileSync(minifiedPath, encodedCode, 'utf8');

  console.log('4. Synchronizing with README.md...');
  let readmeContent = fs.readFileSync(readmePath, 'utf8');
  
  // Split README into lines
  const lines = readmeContent.split(/\r?\n/);
  let replaced = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('javascript:')) {
      lines[i] = encodedCode;
      replaced = true;
      console.log(`Replaced bookmarklet code at line ${i + 1} of README.md`);
      break;
    }
  }

  if (!replaced) {
    throw new Error('Could not find the "javascript:" line in README.md to replace.');
  }

  fs.writeFileSync(readmePath, lines.join('\n'), 'utf8');

  console.log('5. Cleaning up temporary files...');
  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }

  console.log('6. Packaging extension for Chrome Web Store...');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'extension', 'manifest.json'), 'utf8'));
  const extVersion = manifest.version;
  const zipName = `oculist---high-visibility-finder-v${extVersion}.zip`;
  const zipPath = path.join(__dirname, 'dist', zipName);
  const extFiles = [
    'manifest.json',
    'background.js',
    'content.js',
    'popup.html',
    'popup.js',
    'welcome.html',
    'icon16.png',
    'icon48.png',
    'icon128.png',
  ];
  if (!fs.existsSync(path.join(__dirname, 'dist'))) {
    fs.mkdirSync(path.join(__dirname, 'dist'));
  }
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  const fileArgs = extFiles.map(f => `"${f}"`).join(' ');
  execSync(`zip -j "${zipPath}" ${fileArgs}`, { cwd: path.join(__dirname, 'extension') });
  console.log(`Extension zip created: dist/${zipName}`);

  console.log('Build completed successfully!');
} catch (err) {
  console.error('Build failed:', err);
  process.exit(1);
}
