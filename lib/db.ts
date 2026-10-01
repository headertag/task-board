import { env } from 'cloudflare:workers';
export function database(): D1Database {if(!env.DB)throw new Error('Task storage is unavailable');return env.DB;}

export function imageStorage(): R2Bucket|undefined {return (env as unknown as {IMAGES?:R2Bucket}).IMAGES;}
