// Traffic simulator: pretends to be many shoppers hitting the checkout.
// Usage: npm run simulate            (default 20 requests/second, 500 users)
//        npm run simulate -- --rps 40 --users 1000
import { config } from './config.js';

const arg = (name, d) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : d;
};
const rps = arg('rps', 20);
const users = arg('users', 500);

let sent = 0, failed = 0, unreachable = 0;

async function visit() {
  const userId = `user-${Math.floor(Math.random() * users)}`;
  try {
    const res = await fetch(`${config.appUrl}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId }),
    });
    sent++;
    if (!res.ok) failed++;
  } catch {
    unreachable++;
  }
}

console.log(`[sim] ${rps} requests/second from ${users} users -> ${config.appUrl}`);
setInterval(() => { for (let i = 0; i < rps / 10; i++) visit(); }, 100);
setInterval(() => {
  console.log(`[sim] sent ${sent}, errors ${failed} (${sent ? ((100 * failed) / sent).toFixed(1) : 0}%)${unreachable ? `, app unreachable ${unreachable}` : ''}`);
  sent = failed = unreachable = 0;
}, 5000);
