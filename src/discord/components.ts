import {randomBytes} from 'node:crypto';
import {ActionRowBuilder,ButtonBuilder,ButtonStyle,ChannelSelectMenuBuilder,ModalBuilder,RoleSelectMenuBuilder,StringSelectMenuBuilder,TextInputBuilder,TextInputStyle,UserSelectMenuBuilder,type MessageActionRowComponentBuilder} from 'discord.js';
import {WispError} from '../diagnostics.js';
import type {RuntimeComponent,Value} from '../runtime/interpreter.js';
import {Storage,type ComponentState} from '../storage/sqlite.js';

function string(value:Value|undefined,label:string,max:number):string{if(typeof value!=='string'||!value.trim()||value.length>max)throw new WispError('COMPONENT001',`${label} must be a nonempty string of at most ${max} characters`);return value;}
function integer(value:Value|undefined,label:string,minimum:number,maximum:number):number{if(typeof value!=='number'||!Number.isInteger(value)||value<minimum||value>maximum)throw new WispError('COMPONENT001',`${label} must be an integer from ${minimum} to ${maximum}`);return value;}
function optionalString(value:Value|undefined,label:string,max:number):string|undefined{return value===undefined?undefined:string(value,label,max);}
function fields(component:RuntimeComponent,allowed:string[]):void{for(const key of Object.keys(component.fields))if(!allowed.includes(key))throw new WispError('COMPONENT001',`Unsupported ${component.kind} field ${key}`);}
function state(value:Value|undefined):Record<string,Value>{if(value===undefined)return {};if(value===null||Array.isArray(value)||typeof value!=='object')throw new WispError('COMPONENT001','Component state must be a map');return value as Record<string,Value>;}

export class ComponentRegistry {
  constructor(private readonly storage:Storage,private readonly guildId:string,private readonly userId:string){}
  private register(component:RuntimeComponent):string {
    const owner=component.fields.owner??'any';if(owner!=='any'&&owner!=='user')throw new WispError('COMPONENT001','owner must be "any" or "user"');
    const expires=component.fields.expires===undefined?3600:integer(component.fields.expires,'expires',1,604800);
    const id=`ss:${randomBytes(16).toString('hex')}`;
    this.storage.putComponent({id,kind:component.kind,name:component.name,guildId:this.guildId,ownerId:owner==='user'?this.userId:null,expiresAt:Date.now()+expires*1000,state:state(component.fields.state)});
    return id;
  }
  resolve(id:string,kind:string,guildId:string|null,userId:string):ComponentState {
    if(!/^ss:[a-f0-9]{32}$/.test(id))throw new WispError('COMPONENT002','This component does not belong to Wisp');
    const item=this.storage.getComponent(id);
    if(!item)throw new WispError('COMPONENT002','This component has expired or is unavailable');
    if(item.kind!==kind||item.guildId!==guildId)throw new WispError('COMPONENT002','Component scope mismatch');
    if(item.ownerId&&item.ownerId!==userId)throw new WispError('COMPONENT002','This control belongs to another user');
    return item;
  }
  buildRows(components:RuntimeComponent[]):ActionRowBuilder<MessageActionRowComponentBuilder>[] {
    if(!components.length||components.length>25)throw new WispError('COMPONENT001','Reply requires 1 to 25 components');
    const rows:ActionRowBuilder<MessageActionRowComponentBuilder>[]=[];
    let current=new ActionRowBuilder<MessageActionRowComponentBuilder>();let count=0;
    const flush=()=>{if(count){rows.push(current);current=new ActionRowBuilder<MessageActionRowComponentBuilder>();count=0;}};
    for(const component of components){
      let builder:MessageActionRowComponentBuilder;
      if(component.kind==='button'){
        fields(component,['label','style','owner','expires','state']);
        const style=component.fields.style??'primary';
        const styles:Record<string,ButtonStyle>={primary:ButtonStyle.Primary,secondary:ButtonStyle.Secondary,success:ButtonStyle.Success,danger:ButtonStyle.Danger};
        if(typeof style!=='string'||!Object.hasOwn(styles,style))throw new WispError('COMPONENT001','Button style must be primary, secondary, success, or danger');
        builder=new ButtonBuilder().setCustomId(this.register(component)).setLabel(string(component.fields.label,'Button label',80)).setStyle(styles[style]!);
      }else if(component.kind==='select'){
        fields(component,['placeholder','min','max','owner','expires','state']);
        const choices=component.choices??[];if(choices.length<1||choices.length>25)throw new WispError('COMPONENT001','String select requires 1 to 25 choices');
        const min=component.fields.min===undefined?1:integer(component.fields.min,'Select min',0,25),max=component.fields.max===undefined?1:integer(component.fields.max,'Select max',1,25);
        if(min>max||max>choices.length)throw new WispError('COMPONENT001','Invalid select min/max');
        const menu=new StringSelectMenuBuilder().setCustomId(this.register(component)).setMinValues(min).setMaxValues(max);
        const placeholder=optionalString(component.fields.placeholder,'Select placeholder',150);if(placeholder)menu.setPlaceholder(placeholder);
        const seen=new Set<string>();for(const choice of choices){for(const key of Object.keys(choice.fields))if(key!=='label'&&key!=='description')throw new WispError('COMPONENT001',`Unsupported choice field ${key}`);if(seen.has(choice.value))throw new WispError('COMPONENT001','Duplicate select choice');seen.add(choice.value);menu.addOptions({value:string(choice.value,'Choice value',100),label:string(choice.fields.label,'Choice label',100),...(choice.fields.description?{description:string(choice.fields.description,'Choice description',100)}:{})});}
        builder=menu;
      }else if(['user_select','role_select','channel_select'].includes(component.kind)){
        fields(component,['placeholder','min','max','owner','expires','state']);
        const min=component.fields.min===undefined?1:integer(component.fields.min,'Select min',0,25),max=component.fields.max===undefined?1:integer(component.fields.max,'Select max',1,25);if(min>max)throw new WispError('COMPONENT001','Invalid select min/max');
        const menu=component.kind==='user_select'?new UserSelectMenuBuilder():component.kind==='role_select'?new RoleSelectMenuBuilder():new ChannelSelectMenuBuilder();
        menu.setCustomId(this.register(component)).setMinValues(min).setMaxValues(max);
        const placeholder=optionalString(component.fields.placeholder,'Select placeholder',150);if(placeholder)menu.setPlaceholder(placeholder);
        builder=menu;
      }else throw new WispError('COMPONENT001','Modal must be shown with show modal');
      if(component.kind!=='button'||count===5)flush();
      current.addComponents(builder);count++;
      if(component.kind!=='button')flush();
      if(rows.length>5)throw new WispError('COMPONENT001','Discord allows at most 5 action rows');
    }
    flush();if(rows.length>5)throw new WispError('COMPONENT001','Discord allows at most 5 action rows');return rows;
  }
  buildModal(component:RuntimeComponent):ModalBuilder {
    if(component.kind!=='modal')throw new WispError('COMPONENT001','Expected a modal');
    fields(component,['title','owner','expires','state']);
    const inputs=component.inputs??[];if(inputs.length<1||inputs.length>5)throw new WispError('COMPONENT001','Modal requires 1 to 5 text inputs');
    const modal=new ModalBuilder().setCustomId(this.register(component)).setTitle(string(component.fields.title,'Modal title',45));
    const seen=new Set<string>();for(const input of inputs){if(seen.has(input.name))throw new WispError('COMPONENT001','Duplicate modal input name');seen.add(input.name);for(const key of Object.keys(input.fields))if(!['label','style','required','min','max','placeholder','value'].includes(key))throw new WispError('COMPONENT001',`Unsupported input field ${key}`);const style=input.fields.style??'short';if(style!=='short'&&style!=='paragraph')throw new WispError('COMPONENT001','Input style must be short or paragraph');const min=input.fields.min===undefined?0:integer(input.fields.min,'Input min',0,4000),max=input.fields.max===undefined?4000:integer(input.fields.max,'Input max',1,4000);if(min>max)throw new WispError('COMPONENT001','Invalid input min/max');const required=input.fields.required??true;if(typeof required!=='boolean')throw new WispError('COMPONENT001','Input required must be boolean');const field=new TextInputBuilder().setCustomId(string(input.name,'Input name',100)).setLabel(string(input.fields.label,'Input label',45)).setStyle(style==='short'?TextInputStyle.Short:TextInputStyle.Paragraph).setRequired(required).setMinLength(min).setMaxLength(max);const placeholder=optionalString(input.fields.placeholder,'Input placeholder',100),value=optionalString(input.fields.value,'Input value',4000);if(placeholder)field.setPlaceholder(placeholder);if(value)field.setValue(value);modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field));}
    return modal;
  }
}
