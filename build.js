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

  // Fail loudly if the zip's contents don't exactly match extension/'s contents.
  // A hardcoded required-file list (the old approach here) only proves known files
  // are present, it can't notice a new file extension/ gains later, since nothing
  // compared the zip's set against the real directory (oculist-1os). "missing from
  // zip" is the direction that catches a real packaging failure. "unexpected in
  // zip" can't catch a stray file in practice, since the zip is unlinked and
  // regenerated from extension/ on every run, so its membership is a pure
  // function of extension/ minus the excludes: it's a consistency check that the
  // exclude below still agrees with zip's own "-x" excludes, which matters
  // because that exact disagreement is the bug fixed here.
  //
  // Expected paths come from `find`, not a hand-rolled walk, so the exclusions are
  // anchored the same way zip's "-x" patterns are: "./.*" matches a top-level dotfile
  // or anything beneath a top-level dot-dir (mirroring "-x .*"), and "./__MACOSX/*"
  // matches contents of a top-level __MACOSX dir (mirroring "-x __MACOSX/*"). A walk
  // excluding dotfiles/__MACOSX at every depth diverged from zip for nested dotfiles
  // (e.g. subdir/.eslintrc) and produced false build failures.
  const zipped = execSync(`unzip -Z1 "${zipPath}"`, { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .filter(f => !f.endsWith('/')); // directory entries, not files

  const actual = execSync('find . -type f -not -path "./.*" -not -path "./__MACOSX/*"', {
    cwd: path.join(__dirname, 'extension'),
    encoding: 'utf8'
  })
    .split('\n')
    .filter(Boolean)
    .map(f => f.replace(/^\.\//, ''));

  const zippedSet = new Set(zipped);
  const actualSet = new Set(actual);
  const missing = actual.filter(f => !zippedSet.has(f));
  const unexpected = zipped.filter(f => !actualSet.has(f));
  if (missing.length || unexpected.length) {
    const problems = [];
    if (missing.length) problems.push(`missing from zip: ${missing.join(', ')}`);
    if (unexpected.length) problems.push(`unexpected in zip: ${unexpected.join(', ')}`);
    throw new Error(`Extension zip does not match extension/ contents (${problems.join('; ')})`);
  }
  console.log(`Extension zip created: dist/${zipName} (${zipped.length} files)`);

  console.log('Build completed successfully!');
} catch (err) {
  console.error('Build failed:', err);
  process.exit(1);
}
