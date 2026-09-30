import { copyFileSync,existsSync,mkdirSync } from 'node:fs';
mkdirSync('.openai',{recursive:true});
if(!existsSync('.openai/hosting.json'))copyFileSync('.openai/hosting.example.json','.openai/hosting.json');
console.log('Local example configuration is ready. Do not commit private deployment identifiers or credentials.');
