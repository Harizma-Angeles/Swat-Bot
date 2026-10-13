const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { test } = require('node:test');
class Builder {
 constructor() { this.data = {}; this.components = []; }
 setName(v) {this.name=v; return this;} setDescription(v){this.data.description=v;return this;}
 setTitle(v){this.data.title=v;return this;} setColor(v){return this;} setTimestamp(){return this;}
 setCustomId(v){this.customId=v;return this;} setLabel(v){return this;} setStyle(v){return this;} setDisabled(v){return this;} setEmoji(v){return this;}
 setRequired(v){return this;} setMaxLength(v){return this;} setDefaultMemberPermissions(v){return this;} addRoleOption(fn){fn(new Builder());return this;} addIntegerOption(fn){fn(new Builder());return this;} setMinValue(v){return this;}
 addUserOption(fn){fn(new Builder());return this;} addStringOption(fn){fn(new Builder());return this;}
 addComponents(...v){this.components.push(...v);return this;}
 toJSON(){return this.data;}
}
class Collection extends Map {
 some(fn){return [...this.values()].some(fn);} find(fn){return [...this.values()].find(fn);} filter(fn){return new Collection([...this].filter(([k,v])=>fn(v,k)));} map(fn){return [...this.values()].map(fn);}
}
function fixture(data={}) {
 const messages=new Collection(), sent=[], dms=[], channels=new Collection(), members=new Collection();
 let count=0;
 const makeChannel=(id)=>({id,members:new Collection(),messages:{
   fetch:async(arg)=>{if(typeof arg==='object')return messages; if(!messages.has(arg))throw Object.assign(Error('not found'),{code:10008});return messages.get(arg);},
   delete:async(id)=>{messages.delete(id);}
 },send:async(payload)=>{sent.push({id,payload});const msg={id:String(++count),author:{id:'bot'},components:payload.components||[],edit:async()=>{},delete:async()=>messages.delete(msg.id)};messages.set(msg.id,msg);return msg;}});
 for(const id of ['setup','office','waiting','log','other'])channels.set(id,makeChannel(id));
 const g={id:'guild',name:'SWAT',members:{cache:members,fetch:async(id)=>{if(!members.has(id))throw Object.assign(Error('not member'),{code:10007});return members.get(id);}}};
 const client={user:{id:'bot'},guilds:{cache:new Map([['guild',g]])},channels:{fetch:async(id)=>channels.get(id)},on:()=>{}};
 const mod={exports:{}};
 vm.runInNewContext(fs.readFileSync('curatorcalls.js','utf8'),{module:mod,require:(name)=>name==='discord.js'?{EmbedBuilder:Builder,ActionRowBuilder:Builder,ButtonBuilder:Builder,SlashCommandBuilder:Builder,ButtonStyle:{Danger:4,Success:3,Secondary:2},MessageFlags:{Ephemeral:64}}:require(name),console,setInterval:()=>({unref(){}})});
 const store={data,saveNow(){this.writes=(this.writes||0)+1;}};
 let dmOk=true;
 const cfg={guildId:'guild',ids:{setupChannel:'setup',officeVoice:'office',waitingVoice:'waiting',logChannel:'log'},controllerRoleIds:['controller'],store,sendDM:async(id,payload)=>{dms.push({id,payload});return dmOk;},colors:{main:1}};
 const api=mod.exports(client,cfg);
 function member(id,voice='other',controller=false){
   const m={id,user:{id,bot:false},roles:{cache:new Collection(controller?[['controller',{id:'controller'}]]:[])},voice:{channelId:voice,serverMute:false,serverDeaf:false},edits:[]};
   m.edit=async(obj)=>{m.edits.push(obj);if('mute'in obj)m.voice.serverMute=obj.mute;if('deaf'in obj)m.voice.serverDeaf=obj.deaf;};
   m.voice.setChannel=async(id)=>{for(const ch of channels.values())ch.members.delete(m.id);m.voice.channelId=id;channels.get(id)?.members.set(m.id,m);};
   m.voice.disconnect=async()=>m.voice.setChannel(null);
   members.set(id,m);channels.get(voice)?.members.set(id,m);return m;
 }
 const caller=member('caller','office',true);
 function interaction(name='call',uid='target',reason=null){return {guildId:'guild',guild:g,user:{id:'caller',tag:'caller'},channelId:'setup',commandName:name,options:{getUser:()=>({id:uid,bot:false}),getString:()=>reason},isChatInputCommand:()=>!!name,isButton:()=>!name,reply:async function(p){this.result=p;},deferReply:async()=>{},editReply:async function(p){this.result=p;}};}
 function click(action,c){const i=interaction(null);i.customId=action+':target:'+c.id;i.message=messages.get(c.promptId);return i;}
 return {api,S:data,member,caller,interaction,click,sent,dms,messages,channels,store,g,setDm:(v)=>dmOk=v};
}
const calls=(f)=>f.sent.filter(x=>x.id==='setup'&&x.payload.components?.length);
test('call delivers DM and proposes transfer for member already in any voice',async()=>{
 const f=fixture();f.member('target');await f.api.handle(f.interaction());
 assert.equal(f.S.calls.target.status,'pending');assert.equal(f.dms.length,1);assert.match(f.dms[0].payload.content,/24/);assert.ok(f.S.calls.target.promptId);assert.equal(Array.from(f.sent.find(x=>x.id==='setup').payload.allowedMentions.users).join(','),'caller');
});
test('call without voice waits; waiting channel arrival records attendance and pings caller',async()=>{
 const f=fixture();const m=f.member('target',null);await f.api.handle(f.interaction());assert.equal(calls(f).length,0);
 m.voice.channelId='waiting';await f.api._internals.onVoice({channelId:null},{channelId:'waiting',guild:f.g,member:m});
 assert.equal(f.S.calls.target.status,'arrived');assert.equal(calls(f).length,1);
});
test('decline deletes message and suppresses repeat in same voice; new voice proposes again',async()=>{
 const f=fixture();const m=f.member('target');await f.api.handle(f.interaction());const c=f.S.calls.target;const msg=c.promptId;
 await f.api.handle(f.click('cc_no',c));assert.equal(f.messages.has(msg),false);assert.equal(c.status,'pending');await f.api._internals.tick();assert.equal(calls(f).length,1);
 m.voice.channelId='waiting';await f.api._internals.onVoice({channelId:'other'},{channelId:'waiting',guild:f.g,member:m});assert.equal(calls(f).length,2);
});
test('yes moves into office, completes call and deletes proposal',async()=>{
 const f=fixture();const m=f.member('target');await f.api.handle(f.interaction());const c=f.S.calls.target, msg=c.promptId;await f.api.handle(f.click('cc_yes',c));
 assert.equal(m.voice.channelId,'office');assert.equal(c.status,'completed');assert.equal(f.messages.has(msg),false);
});
test('uncall notifies DM and removes pending proposal',async()=>{
 const f=fixture();f.member('target');await f.api.handle(f.interaction());const msg=f.S.calls.target.promptId;await f.api.handle(f.interaction('uncall','target','Ошибка'));
 assert.equal(f.S.calls.target.status,'cancelled');assert.equal(f.messages.has(msg),false);assert.match(f.dms[1].payload.content,/Ошибка/);
});
test('unauthorized roles and controller outside office cannot use commands',async()=>{
 const f=fixture();f.member('target');f.caller.roles.cache.clear();await f.api.handle(f.interaction());assert.equal(f.dms.length,0);
 f.caller.roles.cache.set('controller',{id:'controller'});f.caller.voice.channelId='other';await f.api.handle(f.interaction());assert.equal(f.dms.length,0);
});
test('closed DM is reported and does not crash or lose invocation',async()=>{
 const f=fixture();f.member('target',null);f.setDm(false);const i=f.interaction();await f.api.handle(i);assert.equal(f.S.calls.target.dmDelivered,false);assert.match(i.result,/не доставлено/);
});
test('duplicate calls are rejected and completed calls can be renewed',async()=>{
 const f=fixture();f.member('target');await f.api.handle(f.interaction());await f.api.handle(f.interaction());assert.equal(f.dms.length,1);
 const c=f.S.calls.target;await f.api.handle(f.click('cc_yes',c));await f.api.handle(f.interaction());assert.equal(f.dms.length,2);assert.notEqual(f.S.calls.target.id,c.id);
});
test('overdue notice is emitted once and no automatic punishment happens',async()=>{
 const f=fixture();f.member('target',null);await f.api.handle(f.interaction());f.S.calls.target.deadline=0;await f.api._internals.tick();await f.api._internals.tick();
 assert.equal(f.S.calls.target.status,'overdue');assert.equal(f.sent.filter(x=>x.id==='setup'&&/не явился/.test(x.payload.content)).length,1);
});
test('restart restores active invocation and proposal when user is in voice',async()=>{
 const f=fixture({calls:{target:{id:'old',userId:'target',callerId:'caller',status:'pending',deadline:Date.now()+100000,reason:'test'}}});f.member('target');await f.api.init();assert.ok(f.S.calls.target.promptId);
});
test('mute toggle preserves pre-existing server mute and excludes controllers',async()=>{
 const f=fixture();const a=f.member('a','office'),b=f.member('b','office');b.voice.serverMute=true;
 const i=f.interaction(null);i.customId='cc_mute';await f.api.handle(i);assert.equal(a.voice.serverMute,true);assert.equal(f.caller.voice.serverMute,false);
 await f.api.handle(i);assert.equal(a.voice.serverMute,false);assert.equal(b.voice.serverMute,true);
});
test('headphone toggle and leaving office restore original state',async()=>{
 const f=fixture();const m=f.member('target','office');const i=f.interaction(null);i.customId='cc_deaf';await f.api.handle(i);assert.equal(m.voice.serverDeaf,true);
 m.voice.channelId='other';await f.api._internals.onVoice({channelId:'office'},{channelId:'other',guild:f.g,member:m});assert.equal(m.voice.serverDeaf,false);
});
test('disconnect retains restoration record until next voice connection',async()=>{
 const f=fixture();const m=f.member('target','office');f.S.muted=true;await f.api._internals.applyEffects(m);m.voice.channelId=null;
 await f.api._internals.onVoice({channelId:'office'},{channelId:null,guild:f.g,member:m});assert.ok(f.S.effects.target);
 m.voice.channelId='other';await f.api._internals.onVoice({channelId:null},{channelId:'other',guild:f.g,member:m});assert.equal(m.voice.serverMute,false);assert.equal(f.S.effects.target,undefined);
});
test('closed office rejects visitor but admits approved transfer',async()=>{
 const f=fixture();const m=f.member('target');await f.api.handle(f.interaction());const c=f.S.calls.target;f.S.locked=true;
 await f.api.handle(f.click('cc_yes',c));await f.api._internals.onVoice({channelId:'other'},{channelId:'office',guild:f.g,member:m});assert.equal(m.voice.channelId,'office');
 const stranger=f.member('stranger','office');await f.api._internals.onVoice({channelId:'other'},{channelId:'office',guild:f.g,member:stranger});assert.equal(stranger.voice.channelId,null);
});
test('kick disconnects visitors and leaves controller in office',async()=>{
 const f=fixture();const m=f.member('target','office');const i=f.interaction(null);i.customId='cc_kick';await f.api.handle(i);assert.equal(m.voice.channelId,null);assert.equal(f.caller.voice.channelId,'office');
});
test('failed transfer deletes proposal and keeps invocation actionable',async()=>{
 const f=fixture();const m=f.member('target');await f.api.handle(f.interaction());const c=f.S.calls.target,msg=c.promptId;m.voice.setChannel=async()=>{throw Error('missing permission');};
 await assert.rejects(()=>f.api.handle(f.click('cc_yes',c)),/missing permission/);assert.equal(c.status,'pending');assert.equal(c.admitted,false);assert.equal(f.messages.has(msg),false);
});

test('concurrent calls cannot create duplicate invocations',async()=>{
 const f=fixture();f.member('target');await Promise.all([f.api.handle(f.interaction()),f.api.handle(f.interaction())]);assert.equal(f.dms.length,1);assert.equal(calls(f).length,1);
});
test('cancellation invalidates old buttons even after a new call',async()=>{
 const f=fixture();f.member('target');await f.api.handle(f.interaction());const old=f.click('cc_yes',f.S.calls.target);await f.api.handle(f.interaction('uncall'));await f.api.handle(f.interaction());
 const id=f.S.calls.target.id;await f.api.handle(old);assert.equal(f.S.calls.target.id,id);assert.equal(f.S.calls.target.status,'pending');
});

function mainFixture() {
 const f=fixture();
 const fakeClient={on(){},once(){},user:{id:'bot'},users:{fetch:async()=>({send:async()=>{}})}};
 const mockFs={readFileSync(){throw Object.assign(Error('absent'),{code:'ENOENT'});},mkdirSync(){},writeFileSync(){},renameSync(){},copyFileSync(){}};
 const mod={exports:{}};
 const discord={Client:class{constructor(){return fakeClient;}},GatewayIntentBits:{},EmbedBuilder:Builder,ActionRowBuilder:Builder,ButtonBuilder:Builder,ButtonStyle:{Success:3},SlashCommandBuilder:Builder,StringSelectMenuBuilder:Builder,ModalBuilder:Builder,TextInputBuilder:Builder,TextInputStyle:{},ChannelType:{},PermissionsBitField:{Flags:{}},MessageFlags:{Ephemeral:64},Options:{cacheWithLimits:(v)=>v}};
 const code=fs.readFileSync('index.js','utf8').replace(/^start\(\);$/m,'')+'\nmodule.exports={handleApprove,nickPrefix,DEPARTMENTS,commands};';
 const fakeRequire=(name)=>{
   if(name==='discord.js')return discord;
   if(name==='dotenv')return {config(){}};
   if(name==='fs')return mockFs;
   if(['./privaterooms','./briefing','./predsync'].includes(name))return ()=>({init(){},owns(){return false;}});
   if(name==='./curatorcalls')return ()=>f.api;
   return require(name);
 };
 vm.runInNewContext(code,{module:mod,require:fakeRequire,__dirname:'.',process:{on(){},env:{}},console,setTimeout:()=>({unref(){}}),clearTimeout(){},setInterval:()=>({unref(){}}),URLSearchParams});
 return {...f,main:mod.exports};
}
test('mobile department approval assigns department, employee, selected rank and removes old department',async()=>{
 const f=mainFixture(); const m=f.member('target');m.roles.cache.set('1553180446576349184',{id:'1553180446576349184'});m.roles.cache.set('1553158492389511278',{id:'1553158492389511278'});
 m.roles.remove=async(ids)=>{for(const id of ids)m.roles.cache.delete(id);};m.roles.add=async(ids)=>{for(const id of ids)m.roles.cache.set(id,{id});};m.setNickname=async(nick)=>{m.nickname=nick;};
 const i={member:{roles:{cache:new Collection([['mod',{id:'1553158349317742653'}]])}},user:{id:'caller',tag:'caller'},guild:f.g,customId:'approve:target:MOBILE:5',message:{id:'req',embeds:[{title:'Game_Nick [5]',fields:[{name:'Позывной',value:'Гром'}]}],edit:async()=>{}},update:async()=>{},followUp:async()=>{}};
 // The embed is constructed from the existing request when finishing approval.
 Builder.from=(value)=>new Builder();Builder.prototype.setFooter=function(){return this;};Builder.prototype.addFields=function(){return this;};
 await f.main.handleApprove(i);
 for(const id of ['1559631983599030344','1553182125321359431','1553180207702085822'])assert.equal(m.roles.cache.has(id),true,id);
 assert.equal(m.roles.cache.has('1553180446576349184'),false);assert.equal(m.roles.cache.has('1553158492389511278'),false);assert.equal(m.nickname,'Мобильная группа | Game_Nick');
});
test('mobile role participates in nickname synchronization and all slash commands stay registered',()=>{
 const f=mainFixture();const m=f.member('target');m.roles.cache.set('1559631983599030344',{id:'1559631983599030344'});assert.equal(f.main.nickPrefix(m),'Мобильная группа');
 const names=f.main.commands.map(c=>c.name);for(const name of ['call','uncall','ping','pred','ban','addrest'])assert.ok(names.includes(name),name);assert.equal(names.length,17);
});

test('missed voice movement is reconciled by timer without duplicate proposal',async()=>{
 const f=fixture();const m=f.member('target');await f.api.handle(f.interaction());const old=f.S.calls.target.promptId;m.voice.channelId='waiting';await f.api._internals.tick();assert.equal(f.S.calls.target.status,'arrived');assert.notEqual(f.S.calls.target.promptId,old);assert.equal(f.messages.has(old),false);
});
test('stale voice event cannot disconnect user from unrelated current channel',async()=>{
 const f=fixture();const m=f.member('target','other');f.S.locked=true;await f.api._internals.onVoice({channelId:null},{channelId:'office',guild:f.g,member:m});assert.equal(m.voice.channelId,'other');
});
