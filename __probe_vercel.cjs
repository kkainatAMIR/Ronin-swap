const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const results = [];

results.push('--- ls .vercel (if dir exists) ---');
try {
  results.push(fs.readdirSync('.vercel').join(', '));
} catch (e) {
  results.push('no .vercel dir: ' + e.code);
}

const which = spawnSync('npx', ['--yes', 'vercel', '--version'], {
  encoding: 'utf8',
  timeout: 20_000,
  cwd: process.cwd(),
});
results.push('--- npx vercel --version ---');
results.push('status=' + which.status);
results.push('out=' + which.stdout.trim());
results.push('err=' + which.stderr.trim().slice(0, 500));

results.push('--- package.json scripts ---');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
results.push(JSON.stringify(pkg.scripts || {}, null, 2));

results.push('--- Check for existing .env.local (keys only) ---');
try {
  const env = fs.readFileSync('.env.local', 'utf8');
  const keys = env.split(/\r?\n/).map(l => l.split('=')[0]).filter(Boolean);
  results.push(keys.join(', '));
} catch (e) {
  results.push('no .env.local: ' + e.code);
}

fs.writeFileSync('__vercel_probe_result.txt', results.join('\n'));
