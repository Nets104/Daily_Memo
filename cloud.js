(() => {
  'use strict';
  const cfg = window.DAILY_RECORD_SUPABASE || {};
  const url = String(cfg.url || '').trim();
  const key = String(cfg.publishableKey || '').trim();
  const configured = /^https:\/\/[\w.-]+\.supabase\.co\/?$/.test(url) && /^(sb_publishable_|eyJ)/.test(key);
  if (!configured) { window.DiaryCloud = {configured:false}; return; }
  if (!window.supabase?.createClient) { window.DiaryCloud={configured:false, error:'Supabase 라이브러리를 불러오지 못했어요.'};return; }
  const client=window.supabase.createClient(url,key,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
  let user=null;
  const fail=(result)=>{if(result.error)throw result.error;return result.data;};
  const own=()=>{if(!user)throw Error('로그인 정보가 없어요.');return user.id;};
  const entryRow=e=>({user_id:own(),id:e.id,entry_date:e.date,title:e.title||'',body:e.body||'',short_note:e.shortNote||'',weather:e.weather||'',cover_attachment_id:e.coverAttachmentId||null,calendar_show_title:!!e.calendarShowTitle,created_at:e.createdAt,updated_at:e.updatedAt});
  const toEntry=r=>({id:r.id,date:r.entry_date,title:r.title,body:r.body,shortNote:r.short_note||'',weather:r.weather||'',coverAttachmentId:r.cover_attachment_id||null,calendarShowTitle:!!r.calendar_show_title,createdAt:r.created_at,updatedAt:r.updated_at});
  const toFile=async r=>{
    const data=fail(await client.storage.from('diary-media').download(r.storage_path));
    return {id:r.id,entryId:r.entry_id,name:r.file_name,type:r.content_type,size:r.file_size,createdAt:r.created_at,blob:data};
  };
  const pageAll=async(table,filters)=>{
    const arr=[];
    for(let offset=0;;offset+=500){
      let q=client.from(table).select('*').eq('user_id',own()).range(offset,offset+499);
      if(filters)q=q.eq(filters[0],filters[1]);
      const part=fail(await q.order('created_at',{ascending:true}));
      arr.push(...part);
      if(part.length<500)break;
    }
    return arr;
  };
  // Storage keys must be ASCII-safe. Keep the original filename in diary_attachments.file_name.
  const pathFor=f=>own()+'/'+f.entryId+'/'+f.id;
  const api={
    configured:true,client,
    get user(){return user;},
    async session(){const {data,error}=await client.auth.getUser();if(error && !/session missing/i.test(error.message||''))throw error;user=data?.user||null;return user;},
    async startSignupEmail(email){
      return fail(await client.auth.signInWithOtp({
        email,options:{emailRedirectTo:location.origin+location.pathname,shouldCreateUser:true}
      }));
    },
    async profile(){
      if(!user)return null;
      return fail(await client.from('diary_profiles').select('username')
        .eq('user_id',own()).maybeSingle());
    },
    async usernameAvailable(username){
      return fail(await client.rpc('diary_username_available',{p_username:username}));
    },
    async finishSignup(username,password){
      const verified=fail(await client.auth.getUser())?.user;
      if(!verified||verified.id!==own()||!verified.email_confirmed_at)throw Error('이메일 인증을 먼저 완료해 주세요.');
      if(await api.profile())throw Error('이미 가입된 계정입니다. 로그인해 주세요.');
      if(!/^[a-z][a-z0-9_]{3,19}$/.test(username))throw Error('아이디 형식을 확인해 주세요.');
      if(!(await api.usernameAvailable(username)))throw Error('이미 사용 중인 아이디입니다.');
      fail(await client.auth.updateUser({password}));
      try{
        fail(await client.from('diary_profiles').insert({user_id:own(),username}));
      }catch(e){
        if(e.code==='23505')throw Error('다른 사람이 먼저 사용한 아이디입니다. 중복확인을 다시 해 주세요.');
        throw e;
      }
      return api.profile();
    },
    async login(email,password){return fail(await client.auth.signInWithPassword({email,password}));},
    async logout(){fail(await client.auth.signOut());user=null;},
    async entries(){return (await pageAll('diary_entries')).map(toEntry);},
    async photoPreviews(entryIds){
      if(!entryIds.length)return [];
      const res=fail(await client.from('diary_attachments')
        .select('id,entry_id,content_type,storage_path,created_at')
        .eq('user_id',own()).in('entry_id',entryIds).like('content_type','image/%').order('created_at',{ascending:true}));
      return Promise.all(res.map(async row=>{
        const signed=await client.storage.from('diary-media').createSignedUrl(row.storage_path,600);
        return signed.error ? null : {id:row.id,entryId:row.entry_id,url:signed.data.signedUrl};
      })).then(xs=>xs.filter(Boolean));
    },
    async getAttachments(entryId){
      const rows=await pageAll('diary_attachments',entryId?['entry_id',entryId]:null);
      return Promise.all(rows.map(toFile));
    },
    async saveEntry(entry){fail(await client.from('diary_entries').upsert(entryRow(entry),{onConflict:'user_id,id'}));},
    async saveAttachments(files){
      for(const f of files){
        const path=pathFor(f);
        const old=fail(await client.from('diary_attachments').select('storage_path').eq('user_id',own()).eq('id',f.id).maybeSingle());
        fail(await client.storage.from('diary-media').upload(path,f.blob,{contentType:f.type||'application/octet-stream',upsert:true}));
        try{
          fail(await client.from('diary_attachments').upsert({user_id:own(),id:f.id,entry_id:f.entryId,file_name:f.name,content_type:f.type||'application/octet-stream',file_size:f.size,storage_path:path,created_at:f.createdAt},{onConflict:'user_id,id'}));
        }catch(e){await client.storage.from('diary-media').remove([path]);throw e;}
        if(old?.storage_path && old.storage_path!==path)await client.storage.from('diary-media').remove([old.storage_path]);
      }
    },
    async removeAttachment(id){
      const row=fail(await client.from('diary_attachments').select('storage_path').eq('user_id',own()).eq('id',id).maybeSingle());
      if(!row)return;
      fail(await client.from('diary_attachments').delete().eq('user_id',own()).eq('id',id));
      await client.storage.from('diary-media').remove([row.storage_path]);
    },
    async removeEntry(id){
      const rows=fail(await client.from('diary_attachments').select('storage_path').eq('user_id',own()).eq('entry_id',id));
      fail(await client.from('diary_entries').delete().eq('user_id',own()).eq('id',id));
      if(rows.length){for(let i=0;i<rows.length;i+=100)await client.storage.from('diary-media').remove(rows.slice(i,i+100).map(x=>x.storage_path));}
    },
    async deleteEmpty(ids){
      if(!ids.length)return;
      fail(await client.from('diary_entries').delete().eq('user_id',own()).in('id',ids));
    },
    async hasAttachment(id){
      const res=fail(await client.from('diary_attachments').select('id').eq('user_id',own()).eq('entry_id',id).limit(1));
      return res.length>0;
    }
  };
  window.DiaryCloud=api;
})();