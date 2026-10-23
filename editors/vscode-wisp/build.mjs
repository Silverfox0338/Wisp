import {build} from 'esbuild';
await build({entryPoints:['src/extension.ts'],outfile:'dist/extension.js',bundle:true,platform:'node',format:'cjs',target:'node20',external:['vscode']});
await build({entryPoints:['src/server.ts'],outfile:'dist/server.js',bundle:true,platform:'node',format:'cjs',target:'node20'});
