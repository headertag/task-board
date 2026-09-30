import { registerHooks } from 'node:module';
registerHooks({resolve(specifier,context,next){try{return next(specifier,context)}catch(e){if(specifier.startsWith('.')&&!specifier.match(/\.[a-z]+$/))return next(specifier+'.ts',context);throw e}}});
