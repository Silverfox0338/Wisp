/** What a `roles:` menu pick changes: picked menu roles are added, the menu's other roles are removed. */
export function roleChanges(menu:string[],picked:string[],held:string[]):{add:string[];remove:string[]}{
  const chosen=new Set(picked.filter(id=>menu.includes(id))),owned=new Set(held);
  return {add:[...chosen].filter(id=>!owned.has(id)),remove:menu.filter(id=>owned.has(id)&&!chosen.has(id))};
}

export function roleSummary(changes:{add:string[];remove:string[]},name:(id:string)=>string):string{
  const parts=[changes.add.length?`Added ${changes.add.map(name).join(', ')}`:'',changes.remove.length?`removed ${changes.remove.map(name).join(', ')}`:''].filter(Boolean);
  if(!parts.length)return 'No changes; you already have those roles';
  const text=parts.join(', ');return text[0]!.toUpperCase()+text.slice(1);
}
