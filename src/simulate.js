// Traffic simulator: pretends to be many shoppers, and optionally an attacker.
//   npm run simulate                      normal shoppers (20 requests/second, 500 users)
//   npm run simulate -- --rps 40 --users 1000
//   npm run attack                        only an attacker: 3 accounts from one IP exploiting a bug in the new checkout
//   npm run simulate -- --attack          shoppers and the attacker together
//   npm run simulate -- --junk            also send malformed requests (should be rejected, never counted as errors)
import { config } from './config.js';

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : d;
};
const has = (name) => process.argv.includes(`--${name}`);
const rps = arg('rps', 20);
const users = arg('users', 500);
const attackOnly = has('attack-only');
const attack = attackOnly || has('attack');
const junk = has('junk');

// Each simulated shopper has a stable fake IP, like real users on different networks.
const ipFor = (n) => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

const stats = { sent: 0, ok: 0, errors: 0, rejected: 0, unreachable: 0 };

async function send(body, ip) {
  try {
    const res = await fetch(`${config.appUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify(body),
    });
    stats.sent++;
    if (res.ok) stats.ok++;
    else if (res.status >= 500) stats.errors++;
    else stats.rejected++;
  } catch {
    stats.unreachable++;
  }
}

function shopper() {
  const n = Math.floor(Math.random() * users);
  return send({ userId: `user-${n}` }, ipFor(n + 1));
}

// The attacker picks accounts that get the new checkout, then sends a crafted coupon that crashes it.
const ATTACK_IP = '203.0.113.66';
let attackers = [];
async function pickAttackers() {
  for (let n = 900; attackers.length < 3 && n < 1000; n++) {
    const id = `user-${n}`;
    try {
      const flags = await (await fetch(`${config.appUrl}/api/shop/flags?user=${id}`)).json();
      if (flags.new_checkout) attackers.push(id);
    } catch { /* app not up yet */ }
  }
  if (!attackers.length) attackers = ['user-901', 'user-902', 'user-903'];
  console.log(`[sim] attacker using ${attackers.join(', ')} from ${ATTACK_IP}`);
}
const attackOnce = () => send({ userId: attackers[Math.floor(Math.random() * attackers.length)], coupon: 'X'.repeat(60) }, ATTACK_IP);

const junkOnce = () => send(Math.random() < 0.5 ? { userId: '<script>' } : { userId: 'user-1', coupon: { $gt: '' } }, '198.51.100.9');

if (!attackOnly) console.log(`[sim] ${rps} requests/second from ${users} shoppers -> ${config.appUrl}`);
if (attack) await pickAttackers();

setInterval(() => {
  if (!attackOnly) for (let i = 0; i < rps / 10; i++) shopper();
  if (attack) for (let i = 0; i < 1.5; i++) attackOnce(); // ~15 requests/second
  if (junk && Math.random() < 0.5) junkOnce();
}, 100);

setInterval(() => {
  const s = stats;
  console.log(`[sim] sent ${s.sent}: ${s.ok} ok, ${s.errors} errors (${s.sent ? ((100 * s.errors) / s.sent).toFixed(1) : 0}%), ${s.rejected} rejected` +
    (s.unreachable ? `, app unreachable ${s.unreachable}` : ''));
  Object.keys(s).forEach((k) => { s[k] = 0; });
}, 5000);
