import type {StorageBackend} from '../storage/types.js';
import type {HttpClient,HttpLimits} from './http.js';
import type {Value} from './interpreter.js';
import {jsonApi,mathApi,storageApi,timeApi} from './stdlib.js';

export interface GlobalServices {storage:StorageBackend;db:Value;discord:Value;log:Value;http:HttpClient;files:Value}
/** Globals shared by commands, events, tasks, components, and offline tests. */
export function standardGlobals(services:GlobalServices,scope:string,limits:HttpLimits={}):Record<string,Value>{
  const {http,apis}=services.http.api(limits);
  return {storage:storageApi(services.storage,scope),db:services.db,time:timeApi(),math:mathApi(),json:jsonApi(),discord:services.discord,log:services.log,http,apis,files:services.files};
}
