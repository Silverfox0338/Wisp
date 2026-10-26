import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,relative,isAbsolute} from 'node:path';
import {ApplicationCommandOptionType,ApplicationCommandType} from 'discord.js';
import {parse} from '../compiler/parser.js';
import {initProject} from '../cli/scaffold.js';
import {runWispTests} from '../cli/test-runner.js';
import {commandRoute,discover} from '../project/discovery.js';
import {loadProject} from '../project/manifest.js';
import {diffCommands,payload,type RemoteCommand} from '../discord/registry.js';
import {suggestionChoices} from '../discord/suggest.js';

const config=`command "config":
    description "Server settings"
    subcommand "set":
        description "Change a setting"
        option key:
            type: string
            description: "Setting name"
            required: true
            suggest:
                return ["prefix", "welcome"]
        execute:
            reply "Set {options.key}"
    group "roles":
        description "Role settings"
        subcommand "add":
            description "Add an auto-role"
            execute:
                reply "Added"
        subcommand "remove":
            description "Remove an auto-role"
            execute:
                reply "Removed"
`;

test('parser reads subcommands, groups, and suggest blocks',()=>{
  const command=parse(config).commands[0]!;
  assert.equal(command.execute.length,0);
  assert.deepEqual(command.subcommands!.map(s=>[s.group??null,s.name]),[[null,'set'],['roles','add'],['roles','remove']]);
  assert.equal(command.subcommands![1]!.groupDescription,'Role settings');
  assert.equal(command.subcommands![0]!.options[0]!.suggest![0]!.kind,'return');
  assert.equal(commandRoute(command,'roles','add')!.path,'config roles add');
  assert.equal(commandRoute(command,null,'add'),undefined);
  assert.equal(commandRoute(command),undefined);
});

test('parser reads user and message context menu commands',()=>{
  const m=parse('user command "Report user":\n    permission: manage_messages\n    execute:\n        reply "Reported {target.name}"\nmessage command "Quote":\n    execute:\n        reply "> {target.content}"\n');
  assert.deepEqual(m.commands.map(c=>[c.type,c.name]),[['user','Report user'],['message','Quote']]);
  assert.equal(m.commands[0]!.permission,'manage_messages');
});

test('interaction syntax errors explain the fix',()=>{
  const cases:[string,RegExp][]=[
    ['command "a":\n    description "A"\n    subcommand "b":\n        description "B"\n        execute:\n            reply "b"\n    execute:\n        reply "a"\n',/cannot have its own execute or options/],
    ['user command "A":\n    description "A"\n    execute:\n        reply "a"\n',/cannot have a description/],
    ['message command "A":\n    option x:\n        type: string\n    execute:\n        reply "a"\n',/cannot have options/],
    ['command "a":\n    description "A"\n    option x:\n        type: string\n        choices: ["a"]\n        suggest:\n            return []\n    execute:\n        reply "a"\n',/both choices and suggest/],
    ['command "a":\n    description "A"\n    option x:\n        type: user\n        suggest:\n            return []\n    execute:\n        reply "a"\n',/needs a string, integer, or number option/],
    ['command "a":\n    description "A"\n    subcommand "b":\n        description "B"\n        execute:\n            reply "b"\n    subcommand "b":\n        description "B"\n        execute:\n            reply "b"\n',/Duplicate subcommand b/],
    ['command "a":\n    description "A"\n    group "g":\n        description "G"\n',/at least one subcommand/],
    ['command "a":\n    description "A"\n    subcommand "b":\n        description "B"\n        subcommand "c":\n            description "C"\n            execute:\n                reply "c"\n        execute:\n            reply "b"\n',/cannot be nested/]
  ];
  for(const [source,pattern] of cases)assert.throws(()=>parse(source),pattern,source);
});

test('payload nests subcommands and marks autocomplete options',()=>{
  const body=payload(parse(config).commands[0]!);
  assert.equal(body.type,ApplicationCommandType.ChatInput);
  const [set,roles]=body.options!;
  assert.equal(set!.type,ApplicationCommandOptionType.Subcommand);
  assert.equal(set!.options![0]!.autocomplete,true);
  assert.equal(roles!.type,ApplicationCommandOptionType.SubcommandGroup);
  assert.deepEqual(roles!.options!.map(o=>o.name),['add','remove']);
  const menu=payload(parse('message command "Quote":\n    execute:\n        reply "q"\n').commands[0]!);
  assert.deepEqual(menu,{name:'Quote',description:'',type:ApplicationCommandType.Message});
});

test('diff keys commands by type so a slash and context command may share a name',()=>{
  const slash=payload(parse('command "info":\n    description "Info"\n    execute:\n        reply "i"\n').commands[0]!);
  const user=payload(parse('user command "info":\n    execute:\n        reply "i"\n').commands[0]!);
  const remote:RemoteCommand[]=[{...user,id:'7'}];
  const items=diffCommands([slash,user],remote,['7']);
  assert.deepEqual(items.map(i=>[i.type,i.kind]),[[ApplicationCommandType.ChatInput,'add'],[ApplicationCommandType.User,'same']]);
  const changed=payload(parse(config).commands[0]!),stale={...changed,id:'9',options:changed.options!.slice(0,1)};
  assert.equal(diffCommands([changed],[stale],['9'])[0]!.kind,'update');
});

test('suggestion results are normalized and capped at 25',()=>{
  assert.equal(suggestionChoices(Array.from({length:30},(_,i)=>`item${i}`),'string').length,25);
  assert.deepEqual(suggestionChoices([{name:'Red',value:'red'},'blue',null],'string'),[{name:'Red',value:'red'},{name:'blue',value:'blue'}]);
  assert.deepEqual(suggestionChoices([1,2.5,'x'],'integer'),[{name:'1',value:1}]);
  assert.deepEqual(suggestionChoices(null,'string'),[]);
  assert.throws(()=>suggestionChoices('red','string'),/must return a list/);
});

test('Wisp tests can run subcommands, suggestions, and context menus',async()=>{
  const temp=mkdtempSync(join(tmpdir(),'wisp-009-'));
  try{
    const root=initProject('interactions',temp);
    writeFileSync(join(root,'commands','config.wisp'),`function keys():
    return ["prefix", "welcome", "logs"]

command "config":
    description "Server settings"
    subcommand "set":
        description "Change a setting"
        option key:
            type: string
            description: "Setting name"
            required: true
            suggest:
                let found = []
                for key in keys():
                    if key.contains(typed):
                        found.append(key)
                return found
        execute:
            reply "Set {options.key} via {interaction.subcommand}"
    group "roles":
        description "Role settings"
        subcommand "add":
            description "Add an auto-role"
            execute:
                reply "Added in {interaction.group}"
`);
    writeFileSync(join(root,'commands','report.wisp'),'user command "Report user":\n    execute:\n        reply "Reported {target.name}"\n');
    writeFileSync(join(root,'commands','quote.wisp'),'message command "Quote":\n    execute:\n        reply "> {target.content}"\n');
    writeFileSync(join(root,'tests','interactions.test.wisp'),`assert.equal(mock.run("config set", {"key": "prefix"})[0].content, "Set prefix via set")
assert.equal(mock.run("config roles add")[0].content, "Added in roles")
assert.equal(mock.suggest("config set", "key", "e"), [{"name": "prefix", "value": "prefix"}, {"name": "welcome", "value": "welcome"}])
assert.equal(mock.runUser("Report user", {"name": "Fox"})[0].content, "Reported Fox")
assert.equal(mock.runMessage("Quote", {"content": "hi"})[0].content, "> hi")
try:
    mock.run("config")
    assert.ok(false)
catch error:
    assert.ok(error.message.contains("Unknown command /config"))
`);
    const project=loadProject(root),compiled=discover(project);
    assert.equal(compiled.commands.length,4);
    assert.equal(await runWispTests(project,compiled),2);
  }finally{
    const rel=relative(tmpdir(),temp);
    if(!rel.startsWith('..')&&!isAbsolute(rel))rmSync(temp,{recursive:true,force:true});
  }
});
