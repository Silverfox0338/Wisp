const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Ajv2020=require('ajv/dist/2020').default;
const root=path.join(__dirname,'..'),extension=require('../package.json');
const schema=JSON.parse(fs.readFileSync(path.join(root,'schemas/wisp.schema.json'),'utf8'));

test('manifest schema validates a Wisp project and rejects unknown fields and versions',()=>{
  const validate=new Ajv2020({allErrors:true}).compile(schema);
  const manifest={manifest_version:1,name:'Test bot',version:'0.0.3',entry:'main.wisp',runtime:'>=0.0.3 <0.0.4',discord:{application_id:'${DISCORD_APPLICATION_ID}',token:'${DISCORD_TOKEN}',intents:['guilds','guild_members'],commands:{directory:'./commands',scope:'guild',guild_id:'${DISCORD_GUILD_ID}'}},events:{directory:'./events'},storage:{engine:'sqlite',path:'./data/bot.db'},logging:{level:'info'}};
  assert.equal(validate(manifest),true,JSON.stringify(validate.errors));
  assert.equal(validate({...manifest,runtiem:'typo'}),false);
  assert.equal(validate({...manifest,runtime:'>=9.0.0'}),false);
  assert.equal(validate({...manifest,discord:{...manifest.discord,intents:['imaginary']}}),false);
  assert.equal(validate({...manifest,runtime:'>=0.0.8 <0.0.9',databases:{main:{engine:'postgres',url:'${DATABASE_URL}'},cache:{engine:'redis',url:'${REDIS_URL}'}},storage:{connection:'main'}}),true,JSON.stringify(validate.errors));
  assert.equal(validate({...manifest,databases:{main:{engine:'mysql',url:'mysql://literal-secret'}}}),false);
  assert.equal(validate({...manifest,http:{allow:['api.github.com','*.example.org'],apis:{weather:{base_url:'https://api.weather.test',headers:{'X-Api-Key':'${WEATHER_KEY}'},cache_seconds:60}}}}),true,JSON.stringify(validate.errors));
  assert.equal(validate({...manifest,http:{allow:['https://api.github.com/path']}}),false);
  assert.equal(validate({...manifest,http:{apis:{weather:{base_url:'http://api.weather.test'}}}}),false);
  assert.equal(extension.contributes.jsonValidation[0].fileMatch[0],'wisp.json');
});

test('extension activates for Wisp and includes built client and server',()=>{
  assert.ok(extension.activationEvents.includes('onLanguage:wisp'));
  assert.ok(fs.statSync(path.join(root,extension.main)).size>0);
  assert.ok(fs.statSync(path.join(root,'dist/server.js')).size>0);
  assert.ok(extension.contributes.themes.some(theme=>theme.label==='Wisp Violet'));
});
