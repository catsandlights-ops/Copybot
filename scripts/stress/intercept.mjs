// Loaded into the app during a stress test (node --import): its internet requests go to the
// made-up market instead (Jupiter, Dexscreener); anything else is answered "not available" so
// optional features switch off. Not part of the app.
const world = `http://127.0.0.1:${process.env.STRESS_WORLD_PORT}`;
const real = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const s = typeof input === 'string' ? input : input?.url ?? String(input);
  let u;
  try {
    u = new URL(s);
  } catch {
    return real(input, init);
  }
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return real(input, init);
  if (u.hostname === 'lite-api.jup.ag' || u.hostname === 'api.jup.ag') return real(`${world}/jup${u.pathname}${u.search}`, init);
  if (u.hostname === 'api.dexscreener.com') return real(`${world}/dex${u.pathname}${u.search}`, init);
  return Promise.resolve(new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }));
};
