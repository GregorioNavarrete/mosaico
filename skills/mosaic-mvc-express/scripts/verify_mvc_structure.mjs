import fs from 'node:fs';
import path from 'node:path';

function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('Could not locate package.json for guia-mosaico.');
}

function main() {
  const root = findProjectRoot(process.cwd());
  const errors = [];
  const checks = [];

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.type !== 'module') errors.push('package.json must have "type": "module".');
  if (!pkg.scripts?.start?.includes('node src/server.js')) {
    errors.push('package.json scripts.start must invoke "node src/server.js".');
  }
  if (!pkg.scripts?.test) errors.push('package.json must define scripts.test.');

  const requiredDeps = ['express', 'ejs', 'multer', 'sharp', 'pdf-lib', 'd3-delaunay', 'helmet'];
  for (const dep of requiredDeps) {
    if (!pkg.dependencies?.[dep]) errors.push(`Missing dependency "${dep}" in package.json.`);
  }
  checks.push('package_json_ok');

  const requiredDirs = [
    'data',
    'storage/uploads',
    'storage/exports',
    'src/shared',
    'src/models',
    'src/controllers',
    'src/services',
    'src/middlewares',
    'src/routes',
    'src/views',
    'public/css',
    'public/js',
    'tests',
  ];
  for (const rel of requiredDirs) {
    if (!fs.existsSync(path.join(root, rel))) {
      errors.push(`Missing MVC directory: ${rel}`);
    }
  }
  checks.push('mvc_directories_ok');

  // Verify JSON data stores are valid JSON
  for (const jsonFile of ['projects.json', 'catalogs.json', 'stock.json', 'gallery.json']) {
    const p = path.join(root, 'data', jsonFile);
    if (!fs.existsSync(p)) {
      errors.push(`Missing JSON store file: data/${jsonFile}`);
    } else {
      try {
        JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        errors.push(`Invalid JSON in data/${jsonFile}: ${e.message}`);
      }
    }
  }
  checks.push('json_stores_valid');

  // Ensure storage/ is not exposed as express.static in src/app.js
  const appPath = path.join(root, 'src/app.js');
  if (!fs.existsSync(appPath)) {
    errors.push('Missing src/app.js');
  } else {
    const appCode = fs.readFileSync(appPath, 'utf8');
    if (/express\.static\([^)]*storage/.test(appCode)) {
      errors.push('Security violation: storage/ must NEVER be exposed via express.static.');
    }
  }

  // Ensure views/public CSS do not depend on external CDNs
  const scanOffline = (dirPath) => {
    if (!fs.existsSync(dirPath)) return;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) scanOffline(full);
      else if (/\.(ejs|html|css|js)$/i.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        if (/https?:\/\/(cdn\.tailwindcss\.com|unpkg\.com|fonts\.googleapis\.com)/i.test(text)) {
          errors.push(`Offline policy violation: external CDN reference in ${path.relative(root, full)}`);
        }
      }
    }
  };
  scanOffline(path.join(root, 'src/views'));
  scanOffline(path.join(root, 'public'));
  checks.push('offline_and_security_scan_ok');

  const result = { status: errors.length === 0 ? 'PASS' : 'FAIL', checks, errors };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length > 0) process.exit(1);
}

main();
