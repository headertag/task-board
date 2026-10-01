import { registerHooks } from 'node:module';

// Replace platform plumbing only. Production route, session, JWT, identity, and
// storage code all execute unchanged; no authorization function is mocked.
const platform = {
  'cloudflare:workers': `export const env = new Proxy({}, { get: (_, key) => globalThis.__authRouteEnv?.[key] });`,
  'next/headers': `export async function headers() {
    if (!globalThis.__authRoutePageHeaders) throw new Error('No synthetic page request');
    return globalThis.__authRoutePageHeaders;
  }`,
  'next/navigation': `export function redirect(location) {
    const error = new Error('Synthetic Next redirect');
    error.location = location;
    throw error;
  }`,
};

registerHooks({
  resolve(specifier, context, next) {
    if (Object.hasOwn(platform, specifier)) {
      return { url: 'auth-route-test:' + specifier, shortCircuit: true };
    }
    try { return next(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        return next(specifier + '.ts', context);
      }
      throw error;
    }
  },
  load(url, context, next) {
    if (url.startsWith('auth-route-test:')) {
      return { format: 'module', source: platform[url.slice('auth-route-test:'.length)], shortCircuit: true };
    }
    return next(url, context);
  },
});
