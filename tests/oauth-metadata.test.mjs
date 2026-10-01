import assert from 'node:assert/strict';
import { test } from 'node:test';
import { oauthDiscovery } from '../build/oauth-discovery.ts';
import { readAuthConfig } from '../lib/auth.ts';
import { authorizationServerMetadata } from '../lib/oauth-metadata.ts';
import { beginSignIn, readBrowserConfig, safeReturnTo, TRANSACTION_COOKIE, unseal } from '../lib/browser-auth.ts';
const bindings={WORKOS_AUTHKIT_ISSUER:'https://auth.synthetic.authkit.app',WORKOS_MCP_AUDIENCE:'https://board.example.com/mcp',WORKOS_API_KEY:'synthetic-key',TASK_BOARD_AUTH_POLICY:JSON.stringify({version:1,owners:[],clients:[]})};
const config=readAuthConfig(bindings);
const metadata={issuer:config.issuer,authorization_endpoint:config.issuer+'/oauth2/authorize',token_endpoint:config.issuer+'/oauth2/token',jwks_uri:config.issuer+'/oauth2/jwks',registration_endpoint:config.issuer+'/oauth2/register',code_challenge_methods_supported:['S256'],response_types_supported:['code'],scopes_supported:['openid','profile','email'],client_id_metadata_document_supported:true};
const fetcher=async(url,options)=>{assert.equal(options.redirect,'error');assert.ok(options.signal);assert.equal(new URL(url).origin,config.issuer);return Response.json(metadata)};
test('retained Worker exposes root and path resource discovery with exact audience and no private policy',async()=>{
 for(const path of ['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp']){
  const response=await oauthDiscovery(new Request('https://board.example.com'+path),bindings,fetcher);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{resource:config.audience,authorization_servers:[config.issuer],bearer_methods_supported:['header'],scopes_supported:['openid','profile','email']});
 }
 assert.equal(await oauthDiscovery(new Request('https://board.example.com/mcp'),bindings,fetcher),null);
 assert.equal((await oauthDiscovery(new Request('https://board.example.com/.well-known/oauth-protected-resource',{method:'POST'}),bindings,fetcher)).status,405);
 assert.equal((await oauthDiscovery(new Request('https://board.example.com/.well-known/oauth-protected-resource'),{})).status,503);
});
test('compatibility discovery relays actual configured provider capabilities',async()=>{
 for(const path of ['/.well-known/oauth-authorization-server','/.well-known/oauth-authorization-server/mcp'])assert.deepEqual(await (await oauthDiscovery(new Request('https://board.example.com'+path),bindings,fetcher)).json(),metadata);
 const noDynamic={...metadata};delete noDynamic.registration_endpoint;delete noDynamic.client_id_metadata_document_supported;
 assert.deepEqual(await authorizationServerMetadata(config,async()=>Response.json(noDynamic)),noDynamic);
 const oidc={...metadata};delete oidc.code_challenge_methods_supported;
 assert.deepEqual(await authorizationServerMetadata(config,async()=>Response.json(oidc),true),oidc);
});
test('discovery rejects wrong issuer, nonPKCE OAuth, foreign endpoints, oversized and bad responses',async()=>{
 for(const bad of [{...metadata,issuer:'https://evil.example'},{...metadata,code_challenge_methods_supported:['plain']},{...metadata,token_endpoint:'https://evil.example/token'},{...metadata,registration_endpoint:'http://auth.synthetic.authkit.app/register'}])await assert.rejects(authorizationServerMetadata(config,async()=>Response.json(bad)),e=>e.status===503);
 await assert.rejects(authorizationServerMetadata(config,async()=>new Response('x'.repeat(64001))),e=>e.status===503);
 await assert.rejects(authorizationServerMetadata(config,async()=>new Response('',{status:500})),e=>e.status===503);
});
test('browser signin pins PKCE, state, nonce, audience, redirect and safe return paths',async()=>{
 const browser=readBrowserConfig({TASK_BOARD_ORIGIN:'https://board.example.com',WORKOS_BROWSER_CLIENT_ID:'client_synthetic_browser',TASK_BOARD_SESSION_SECRET:'A'.repeat(43)},config);
 let entry;const store={put:async(key,expiry)=>{entry={key,expiry}},consume:async()=>false};
 const req=new Request('https://board.example.com/auth/signin?return_to=%2F%2Fevil.example',{headers:{'sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document','sec-fetch-user':'?1'}});
 const response=await beginSignIn(req,browser,store);const url=new URL(response.headers.get('location'));
 assert.equal(url.origin,config.issuer);assert.equal(url.pathname,'/oauth2/authorize');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('resource'),config.audience);assert.equal(url.searchParams.get('redirect_uri'),browser.origin+'/auth/callback');assert.ok(url.searchParams.get('nonce'));assert.ok(url.searchParams.get('state'));
 const value=response.headers.get('set-cookie').split(';')[0].slice(TRANSACTION_COOKIE.length+1);const tx=await unseal(value,'transaction',browser);assert.equal(tx.returnTo,'/');assert.equal(tx.state,url.searchParams.get('state'));assert.ok(entry.key);assert.ok(entry.expiry);
 await assert.rejects(beginSignIn(new Request('https://board.example.com/auth/signin',{headers:{'sec-fetch-site':'cross-site'}}),browser,store),e=>e.status===403);
 await assert.rejects(beginSignIn(new Request('https://evil.example/auth/signin'),browser,store),e=>e.status===403);
 for(const path of ['//evil.example','/\\evil.example','/auth/signout','/\\[','/\\%5B'])assert.equal(safeReturnTo(path),'/');
 assert.equal(safeReturnTo('/?board=1#task'), '/?board=1#task');
});
