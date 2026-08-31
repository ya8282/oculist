const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

try {
  console.log('1. Packaging extension for Chrome Web Store...');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'extension', 'manifest.json'), 'utf8'));
  const extVersion = manifest.version;
  const zipName = `oculist---high-visibility-finder-v${extVersion}.zip`;
  const zipPath = path.join(__dirname, 'dist', zipName);
  if (!fs.existsSync(path.join(__dirname, 'dist'))) {
    fs.mkdirSync(path.join(__dirname, 'dist'));
  }
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  // Zip the whole extension dir rather than an explicit file list — the old list
  // silently omitted welcome.js, which shipped a dead onboarding wizard. Everything
  // in extension/ is runtime source, so "all of it minus junk" is the safer default.
  execSync(`zip -r "${zipPath}" . -x ".*" -x "__MACOSX/*"`, { cwd: path.join(__dirname, 'extension') });

  // Fail loudly if anything referenced by the HTML didn't make it into the zip.
  const zipped = execSync(`unzip -Z1 "${zipPath}"`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  const required = ['manifest.json', 'background.js', 'settings-migration.js', 'content.js', 'popup.html', 'popup.js', 'welcome.html', 'welcome.js', 'icon16.png', 'icon48.png', 'icon128.png'];
  const missing = required.filter(f => !zipped.includes(f));
  if (missing.length) throw new Error(`Extension zip is missing required files: ${missing.join(', ')}`);
  console.log(`Extension zip created: dist/${zipName} (${zipped.length} files)`);

  console.log('Build completed successfully!');
} catch (err) {
  console.error('Build failed:', err);
  process.exit(1);
}
