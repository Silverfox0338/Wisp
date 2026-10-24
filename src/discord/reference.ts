import routes from './reference-routes.json' with {type:'json'};
import {WispError} from '../diagnostics.js';
import {host,record,type HostFunction,type Value} from '../runtime/interpreter.js';

export interface ReferenceRoute {method:string;route:string;description:string}
export const referenceRoutes=routes as Record<string,Record<string,ReferenceRoute>>;

function segment(value:Value,label:string):string {
  if((typeof value!=='string'&&typeof value!=='number')||!String(value).trim()||String(value).length>200||/[\\/]/.test(String(value))||String(value)==='.'||String(value)==='..'){
    throw new WispError('DISCORD005',`${label} must be a nonempty Discord path value`);
  }
  if(typeof value==='number'&&(!Number.isSafeInteger(value)||value<0)){
    throw new WispError('DISCORD005',`${label} must be a safe nonnegative integer`);
  }
  return encodeURIComponent(String(value));
}

function mapOrNull(value:Value,label:string):Value {
  if(value===null)return null;
  if(typeof value!=='object'||Array.isArray(value))throw new WispError('DISCORD005',`${label} must be a map`);
  return value;
}

/** Named wrappers for the HTTP endpoints in the bundled Discord reference. */
export function referenceApi(request:HostFunction):Record<string,Record<string,HostFunction>> {
  const groups:Record<string,Record<string,HostFunction>>={};
  for(const [namespace,entries] of Object.entries(referenceRoutes)){
    const operations:Record<string,HostFunction>={};
    for(const [name,endpoint] of Object.entries(entries)){
      const placeholders=[...endpoint.route.matchAll(/\{([^}]+)\}/g)].map(match=>match[1]!);
      operations[name]=host((...args)=>{
        const hasBody=endpoint.method==='POST'||endpoint.method==='PUT'||endpoint.method==='PATCH';
        if(args.length<placeholders.length||args.length>placeholders.length+(hasBody?4:3)){
          throw new WispError('DISCORD005',`${namespace}.${name} expects ${placeholders.length} path values, followed by optional options, query, reason, and files`);
        }
        let path=endpoint.route;
        placeholders.forEach((placeholder,index)=>{path=path.replace(`{${placeholder}}`,segment(args[index]!,placeholder));});
        const input=mapOrNull(args[placeholders.length]??null,'Options');
        const body=hasBody?input:null;
        const query=hasBody?mapOrNull(args[placeholders.length+1]??null,'Query'):input;
        const reason=hasBody?args[placeholders.length+2]??null:args[placeholders.length+1]??null;
        const files=hasBody?args[placeholders.length+3]??null:args[placeholders.length+2]??null;
        return request.call(endpoint.method,path,body,query,reason,files);
      });
    }
    groups[namespace]=record(operations) as Record<string,HostFunction>;
  }
  return groups;
}
