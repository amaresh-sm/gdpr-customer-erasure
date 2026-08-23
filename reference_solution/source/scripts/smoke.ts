const services = [
  ['gateway', 'http://localhost:3000/health'], ['customers', 'http://localhost:3001/health'],
  ['payments', 'http://localhost:3002/health'],
  ['privacy', 'http://localhost:3005/health'],
  ['webhooks', 'http://localhost:3010/health'],
] as const;

const checks = await Promise.all(services.map(async ([name, url]) => {
  try { const response = await fetch(url); return { name, ok: response.ok, status: response.status }; }
  catch (error) { return { name, ok: false, error: error instanceof Error ? error.message : String(error) }; }
}));
console.log(JSON.stringify(checks, null, 2));
if (checks.some((check) => !check.ok)) process.exitCode = 1;
