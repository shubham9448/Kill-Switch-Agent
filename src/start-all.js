// npm start : runs the shop, the agent and (with --sim) the traffic simulator together, with labelled logs.
import { spawn } from 'node:child_process';

const procs = [
  ['app  ', ['src/app.js']],
  ['agent', ['src/agent/index.js']],
];
if (process.argv.includes('--sim')) procs.push(['sim  ', ['src/simulate.js']]);

const children = procs.map(([name, args], i) => {
  const start = () => {
    const c = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const pipe = (s) => s.on('data', (d) => d.toString().split('\n').filter(Boolean).forEach((l) => console.log(`[${name}] ${l}`)));
    pipe(c.stdout); pipe(c.stderr);
    return c;
  };
  // Give the app a moment to open the database and port before the others start.
  return new Promise((r) => setTimeout(() => r(start()), i ? 1500 : 0));
});

const stop = async () => { for (const c of await Promise.all(children)) c.kill(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
