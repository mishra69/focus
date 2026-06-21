#!/usr/bin/env node
// One-time VAPID keypair generator for Web Push (RFC 8292).
// Run: node gen-vapid.mjs
//   - Put VAPID_PUBLIC_KEY into wrangler.toml [vars] (it is public; safe to commit).
//   - Store the private JWK as a secret: npx wrangler secret put VAPID_PRIVATE_JWK
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;
const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey)); // 65-byte uncompressed point
const jwk = await subtle.exportKey('jwk', kp.privateKey);
const b64url = b => Buffer.from(b).toString('base64url');

console.log('\nVAPID_PUBLIC_KEY  (wrangler.toml [vars], also used as applicationServerKey):');
console.log(b64url(pubRaw));
console.log('\nVAPID_PRIVATE_JWK (run: npx wrangler secret put VAPID_PRIVATE_JWK , then paste this line):');
console.log(JSON.stringify(jwk));
console.log();
