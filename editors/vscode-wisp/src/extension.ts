import * as vscode from 'vscode';
import {LanguageClient,TransportKind,type LanguageClientOptions,type ServerOptions} from 'vscode-languageclient/node';

let client:LanguageClient|undefined;
export async function activate(context:vscode.ExtensionContext):Promise<void>{
  const serverModule=context.asAbsolutePath('dist/server.js');
  const serverOptions:ServerOptions={run:{module:serverModule,transport:TransportKind.ipc},debug:{module:serverModule,transport:TransportKind.ipc}};
  const clientOptions:LanguageClientOptions={documentSelector:[{scheme:'file',language:'wisp'}],synchronize:{fileEvents:vscode.workspace.createFileSystemWatcher('**/*.wisp')}};
  client=new LanguageClient('wisp','Wisp Language Server',serverOptions,clientOptions);
  await client.start();
  context.subscriptions.push({dispose:()=>{void client?.stop();}});
}
export async function deactivate():Promise<void>{await client?.stop();}
