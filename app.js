(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const el = {
    sidebar:$('sidebar'),scrim:$('sidebarScrim'),list:$('entryList'),count:$('entryCount'),search:$('searchInput'),
    calendarGrid:$('calendarGrid'),calendarMonthLabel:$('calendarMonthLabel'),
    date:$('entryDate'),dateDisplay:$('dateDisplay'),title:$('entryTitle'),body:$('entryBody'),preview:$('mdPreview'),
    writing:$('writingArea'),save:$('saveState'),edited:$('editedAt'),charCount:$('charCount'),
    attachList:$('attachmentList'),attachCount:$('attachmentCount'),file:$('fileInput'),record:$('recordBtn'),recordText:$('recordBtnText'),
    dialog:$('exportDialog'),exportFilename:$('exportFilename'),exportProgress:$('exportProgress'),restoreInput:$('restoreInput'),toast:$('toast')
  };
  const MAX_TITLE_CHARS=30, MAX_BODY_CHARS=1500, MAX_NOTE_CHARS=20, MAX_EXPORT_NAME_CHARS=30;
  const FILE_LIMITS={image:1_000_000,gif:2_000_000,audio:10_000_000,pdf:10_000_000};
  const MAX_ATTACHMENT_BYTES=10_000_000,USER_ATTACHMENT_BYTES=250_000_000;
  const formatAttachmentUsage=bytes=>bytes<1_000_000?(bytes/1000).toFixed(0)+'KB':(bytes/1_000_000).toFixed(1)+'MB';
  const attachmentBytes=()=>attachments.reduce((total,file)=>total+(Number(file.size)||file.blob?.size||0),0);
  const fileLimit=(type,name='')=>{
    if(type==='image/gif'||/\.gif$/i.test(name))return FILE_LIMITS.gif;
    if(type.startsWith('image/')||/\.(jpe?g|png|gif|webp|heic|heif|avif)$/i.test(name))return FILE_LIMITS.image;
    if(type.startsWith('video/'))return 0;
    if(type.startsWith('audio/')||/\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(name))return FILE_LIMITS.audio;
    return FILE_LIMITS.pdf;
  };
  const WEEK_KR = ['일','월','화','수','목','금','토'];
  const WEEK_JP = ['日','月','火','水','木','金','土'];
  const MONTH_EN = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const WEEK_EN = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
  let db, entries = [], current = null, attachments = [], mediaUrls = [];
  const cloud = () => window.DiaryCloud?.configured ? window.DiaryCloud : null;
  let cloudMode=false, initialized=false, guestMode=false;
  let saveTimer = null, savePromise = Promise.resolve(), toastTimer = null, view = 'edit';
  let recorder = null, recordStream = null, recordChunks = [], recordingEntryId = null;
  let isExporting = false;
  let selectedStickerId = null;
  let appUpdateReloading=false;
  let isDraft = false, isSavingDraft = false;
  let attachmentQueue=Promise.resolve(),pendingFileJobs=0;
  let savedState=null,savedFileIds=new Set(),pendingTimer=null,pendingWrites=Promise.resolve();
  const pendingScope=()=>cloudMode&&cloud()?.user?.id?'user:'+cloud().user.id:'local';
  const pendingKey=id=>pendingScope()+':'+id;
  const entryFields=e=>({
    date:e?.date||'',title:e?.title||'',body:e?.body||'',weather:e?.weather||'',
    shortNote:e?.shortNote||'',coverAttachmentId:e?.coverAttachmentId||null,
    calendarShowTitle:!!e?.calendarShowTitle,
    photoLayout:JSON.parse(JSON.stringify(e?.photoLayout||{}))
  });
  const diaryBodyFontSize=entry=>{
    const size=Number(entry?.photoLayout?.__bodyFontSize);
    return [14,16,18,20,22,24].includes(size)?size:null;
  };
  function applyBodyFontSize(){
    const size=diaryBodyFontSize(current);
    const control=$('bodyFontSize');
    if(control)control.value=size?String(size):'default';
    el.writing.classList.toggle('custom-body-size',size!==null);
    if(size!==null)el.writing.style.setProperty('--diary-body-size',size+'px');
    else el.writing.style.removeProperty('--diary-body-size');
  }
  function setStickerSelection(id){
    selectedStickerId=id;
    const board=$('entryStickerBoard');
    if(!board)return;
    board.querySelectorAll('.entry-photo-sticker').forEach(card=>{
      const active=id!==null&&card.dataset.stickerId===id&&view==='edit';
      card.classList.toggle('is-selected',active);
      card.setAttribute('aria-selected',String(active));
    });
  }
  function setSavedBaseline(){
    savedState=entryFields(current);savedFileIds=new Set(attachments.map(f=>f.id));
  }
  function hasUnsavedChanges(){
    if(!current)return false;
    const state={...current,title:el.title.value,body:el.body.value};
    if(isDraft)return !!(state.title.trim()||state.body.trim()||state.shortNote?.trim()||
      state.weather||attachments.length);
    return JSON.stringify(entryFields(state))!==JSON.stringify(savedState)||
      attachments.length!==savedFileIds.size||attachments.some(f=>!savedFileIds.has(f.id));
  }
  function openPendingDb(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open('harugyeol-unsaved',1);
      req.onupgradeneeded=()=>{if(!req.result.objectStoreNames.contains('drafts'))req.result.createObjectStore('drafts',{keyPath:'key'});};
      req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);
    });
  }
  async function pendingOperation(mode,action){
    const database=await openPendingDb();
    try{
      return await new Promise((resolve,reject)=>{
        const tx=database.transaction('drafts',mode),store=tx.objectStore('drafts');
        const req=action(store);
        tx.oncomplete=()=>resolve(req?.result);
        tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      });
    }finally{database.close();}
  }
  function stagePending(){
    clearTimeout(pendingTimer);pendingTimer=null;
    if(!current||!hasUnsavedChanges())return;
    const draft={key:pendingKey(current.id),scope:pendingScope(),
      entry:{...current,title:el.title.value,body:el.body.value},
      files:[...attachments],isDraft,changedAt:new Date().toISOString()};
    pendingWrites=pendingWrites.catch(()=>{}).then(()=>pendingOperation('readwrite',store=>store.put(draft)));
    pendingWrites.catch(e=>{console.warn('임시 보관 실패',e);setSave('error','임시 보관 실패');});
  }
  function schedulePending(){
    clearTimeout(pendingTimer);pendingTimer=setTimeout(stagePending,220);
  }
  async function clearAccountPending(userId){
    const scope='user:'+userId+':';
    try{
      await pendingWrites.catch(()=>{});
      const keys=await pendingOperation('readonly',store=>store.getAllKeys())||[];
      const ownKeys=keys.filter(key=>typeof key==='string'&&key.startsWith(scope));
      if(ownKeys.length){
        await pendingOperation('readwrite',store=>{
          for(const key of ownKeys)store.delete(key);
          return null;
        });
      }
    }catch(e){console.warn('탈퇴 후 이 기기의 임시 기록 정리 실패',e);}
  }
  async function clearPending(id,scope=pendingScope()){
    clearTimeout(pendingTimer);pendingTimer=null;
    try{
      await pendingWrites.catch(()=>{});
      await pendingOperation('readwrite',store=>store.delete(scope+':'+id));
    }catch(e){console.warn('임시 보관 정리 실패',e);}
  }
  async function restoreLatestPending(){
    try{
      const all=await pendingOperation('readonly',store=>store.getAll())||[];
      const draft=all.filter(x=>x.scope===pendingScope()).sort((a,b)=>b.changedAt.localeCompare(a.changedAt))[0];
      if(!draft?.entry?.id)return false;
      const saved=entries.find(e=>e.id===draft.entry.id);
      if(!draft.isDraft&&!saved)return false;
      if(saved){
        current={...draft.entry};isDraft=false;
        const existingFiles=await getAll('attachments','entryId',saved.id);
        savedState=entryFields(saved);savedFileIds=new Set(existingFiles.map(f=>f.id));
      }else{
        current={...draft.entry};isDraft=true;savedState=null;savedFileIds=new Set();
      }
      attachments=draft.files||[];
      fillEditor();renderAttachments();renderList();
      setSave('','임시 보관됨 · 저장 필요');
      $('deleteEntryBtn').textContent=isDraft?'작성 내용 지우기':'이 일기 전체 삭제';
      showEditor();
      toast('작성 중이던 기록을 복원했어요. 저장 버튼으로 확정해 주세요.');
      return true;
    }catch(e){console.warn('임시 보관 복원 실패',e);return false;}
  }
  function canLeaveUnsaved(){
    if(!hasUnsavedChanges())return true;
    stagePending();
    return confirm('저장하지 않은 변경사항이 있어요. 이동해도 기기에 임시 보관되지만 서버에는 저장되지 않습니다. 계속할까요?');
  }
  let calendarYear = new Date().getFullYear(), calendarMonth = new Date().getMonth();
  let pendingMonthDeletion=null,pendingBackup=null,backupPreparing=false;
  let cardDate=null,cardPhoto=null,cardCoverFileId=null,cardObjectUrl=null,cardImage=null,cardZoom=1,cardOffsetX=0,cardOffsetY=0,cardDragging=false,cardPointer=null;
  let calendarPageOpen=false,miniPhotoToken=0,highlightedCalendarDate=null;const miniPhotoUrls=[];
  const MAX_DIARY_PHOTOS=10;
  const isCalendarCover=f=>f.id===current?.coverAttachmentId||/^달력_썸네일_/.test(f.name||'');
  const isDiaryCropPreview=f=>/^일기_미리보기_/.test(f.name||'');
  const cropPreviewName=id=>'일기_미리보기_'+id+'.jpg';

  function dayString(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }
  function dateText(iso, lang = 'jp') {
    const d = /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? new Date(`${iso}T12:00:00`) : new Date();
    return `${dayString(d)}(${(lang === 'jp' ? WEEK_JP : WEEK_KR)[d.getDay()]})`;
  }
  function makeId() { return globalThis.crypto?.randomUUID?.() || `entry-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function safeFileName(name) { return (String(name || '').replace(/[\\/:*?"<>|\x00-\x1F]/g,'_').replace(/[.\s]+$/g,'').trim().slice(0,120) || '일상기록_기록'); }
  function toast(message, centered = false) { el.toast.textContent = message; el.toast.classList.toggle('save-success', centered); el.toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'), centered ? 1800 : 3200); }
  function setSave(status, label) { el.save.className=`save-state ${status || ''}`;el.save.innerHTML=`<span class="save-dot"></span> ${escapeHtml(label)}`; }
  function openDb() {
    return new Promise((resolve,reject) => {
      const req = indexedDB.open('harugyeol-journal',1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries',{keyPath:'id'});
        if (!d.objectStoreNames.contains('attachments')) {
          const s=d.createObjectStore('attachments',{keyPath:'id'}); s.createIndex('entryId','entryId',{unique:false});
        }
      };
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
    });
  }
  async function writeRecords(storeName, values) {
    if(cloudMode){      try{return await (storeName==='entries' ? Promise.all(values.map(v=>cloud().saveEntry(v))) : cloud().saveAttachments(values));}
      finally{refreshStorageUsage();}
    }
    await checkLocalStorageQuota(storeName,values);
    return new Promise((resolve,reject) => {
      const tx=db.transaction(storeName,'readwrite');
      const store=tx.objectStore(storeName);
      for(const value of values) store.put(value);
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || Error('저장 실패'));
    });
  }
  function getAll(storeName, indexName, value) {
    if(cloudMode)return storeName==='entries' ? cloud().entries() : cloud().getAttachments(indexName==='entryId'?value:null);
    return new Promise((resolve,reject) => {
      const tx=db.transaction(storeName,'readonly');
      const request=indexName ? tx.objectStore(storeName).index(indexName).getAll(value) : tx.objectStore(storeName).getAll();
      request.onsuccess=()=>resolve(request.result || []);request.onerror=()=>reject(request.error);
    });
  }
  async function checkLocalStorageQuota(storeName,values){
    const storedEntries=new Map((await getAll('entries')).map(e=>[e.id,e]));
    const storedFiles=new Map((await getAll('attachments')).map(f=>[f.id,f]));
    const changedDays=new Set();
    if(storeName==='entries')for(const e of values){
      if(storedEntries.get(e.id)?.date!==e.date)changedDays.add(e.date);
      storedEntries.set(e.id,e);
    }
    if(storeName==='attachments')for(const f of values){
      if(f.type.startsWith('video/'))throw Error('영상 업로드는 지원하지 않아요.');
      if((f.blob?.size||f.size)>fileLimit(f.type,f.name))throw Error(f.name+': 파일 용량 한도를 넘어요.');
      storedFiles.set(f.id,f);changedDays.add(storedEntries.get(f.entryId)?.date);
    }
    let total=0;const byDay=new Map();
    for(const f of storedFiles.values()){
      const size=f.blob?.size||f.size||0,day=storedEntries.get(f.entryId)?.date;
      total+=size;byDay.set(day,(byDay.get(day)||0)+size);
    }
    if(storeName==='attachments'&&total>USER_ATTACHMENT_BYTES)throw Error('첨부파일 한도 250MB에 도달했어요. 백업 후 불필요한 기록을 정리해 주세요.');
    for(const day of changedDays)if((byDay.get(day)||0)>MAX_ATTACHMENT_BYTES)throw Error('같은 날짜의 모든 기록과 썸네일을 합쳐 하루 10MB까지 저장할 수 있어요.');
  }
  function deleteOne(storeName, key) {
    if(cloudMode)return storeName==='attachments' ? cloud().removeAttachment(key) : cloud().removeEntry(key);
    return new Promise((resolve,reject)=>{ const tx=db.transaction(storeName,'readwrite');tx.objectStore(storeName).delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error); });
  }
  async function deleteEntryData(id) {
    if(cloudMode)return cloud().removeEntry(id);
    const keys=await new Promise((resolve,reject)=>{const tx=db.transaction('attachments','readonly');const q=tx.objectStore('attachments').index('entryId').getAllKeys(id);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(['entries','attachments'],'readwrite');
      for(const key of keys)tx.objectStore('attachments').delete(key);
      tx.objectStore('entries').delete(id);
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  }
  async function init() {
    if(cloud() && !initialized){
      initialized=true;
      const auth=$('cloudAuth'),app=$('diaryApp');
      const msg=$('cloudAuthStatus');
      const usernameRule=/^[a-z0-9]{4,12}$/;
      let checkedUsername='';
      function authPanel(which){
        $('cloudLoginPanel').hidden=which!=='login';
        $('cloudSignupEmailPanel').hidden=which!=='email';
        $('cloudSignupFinishPanel').hidden=which!=='finish';
        checkedUsername='';
        $('cloudUsernameStatus').textContent='';
        msg.textContent='';
      }
      async function showUser(){
        const user=await cloud().session();
        if(!user){
          cloudMode=false;auth.hidden=false;app.hidden=true;
          authPanel('login');return;
        }
        const profile=await cloud().profile();
        if(!profile){
          // Authenticated through the email link; do not open the diary until setup finishes.
          cloudMode=false;auth.hidden=false;app.hidden=true;
          $('cloudVerifiedEmail').textContent=user.email||'';
          authPanel('finish');return;
        }
        guestMode=false;cloudMode=true;db={};auth.hidden=true;app.hidden=false;
        $('cloudAccount').hidden=false;$('cloudUserEmail').textContent=user.email||'';
        current=null;attachments=[];entries=[];clearTimeout(saveTimer);saveTimer=null;
        await loadEntries();
      }
      $('cloudAuthForm').addEventListener('submit',async e=>{
        e.preventDefault();msg.textContent='로그인 중…';
        $('cloudLogin').disabled=true;
        try{
          await cloud().login($('cloudEmail').value.trim(),$('cloudPassword').value);
          await showUser();
        }catch(err){msg.textContent='로그인 실패: '+err.message;}
        finally{$('cloudLogin').disabled=false;}
      });
      $('guestLogin').addEventListener('click',async()=>{
        if(guestMode)return;
        if(cloud()?.user){msg.textContent='로그인 중인 계정은 로그아웃한 뒤 비회원으로 이용해 주세요.';return;}
        guestMode=true;cloudMode=false;
        current=null;attachments=[];entries=[];savedState=null;savedFileIds=new Set();
        revokeMediaUrls();
        auth.hidden=true;app.hidden=false;
        $('cloudAccount').hidden=true;
        try{await loadEntries();}
        catch(err){msg.textContent='기기 기록을 열지 못했어요: '+err.message;guestMode=false;auth.hidden=false;app.hidden=true;}
      });
      $('cloudSignup').addEventListener('click',()=>{
        authPanel('email');$('cloudSignupEmail').value=$('cloudEmail').value.trim();
      });
      $('cloudSignupBack').addEventListener('click',()=>authPanel('login'));
      $('cloudSignupEmailForm').addEventListener('submit',async e=>{
        e.preventDefault();
        const email=$('cloudSignupEmail').value.trim();
        $('cloudSignupEmailSend').disabled=true;msg.textContent='인증 메일을 보내는 중…';
        try{
          await cloud().startSignupEmail(email);
          msg.textContent='인증 메일을 보냈어요. 메일 속 링크를 누른 다음 이 앱으로 돌아오세요.';
        }catch(err){msg.textContent=/email address not authorized/i.test(err.message||'')
          ? '이메일 발송 제한으로 인증 메일을 보낼 수 없어요. 관리자에게 SMTP 설정을 요청해 주세요.'
          : '인증 메일 전송 실패: '+err.message;}
        finally{$('cloudSignupEmailSend').disabled=false;}
      });
      $('cloudUsername').addEventListener('input',()=>{
        checkedUsername='';$('cloudUsernameStatus').textContent='';
      });
      $('cloudUsernameCheck').addEventListener('click',async()=>{
        const name=$('cloudUsername').value.trim().toLowerCase();
        $('cloudUsername').value=name;
        checkedUsername='';
        if(!usernameRule.test(name)){
          $('cloudUsernameStatus').textContent='영문·숫자로 된 4~12자 아이디를 입력해 주세요.';
          return;
        }
        $('cloudUsernameCheck').disabled=true;
        $('cloudUsernameStatus').textContent='아이디 중복 확인 중…';
        try{
          const available=await cloud().usernameAvailable(name);
          if(available){
            checkedUsername=name;
            $('cloudUsernameStatus').textContent='✓ 사용할 수 있는 아이디입니다.';
          }else $('cloudUsernameStatus').textContent='이미 사용 중인 아이디입니다.';
        }catch(err){$('cloudUsernameStatus').textContent='중복확인 실패: '+err.message;}
        finally{$('cloudUsernameCheck').disabled=false;}
      });
      $('cloudSignupFinishForm').addEventListener('submit',async e=>{
        e.preventDefault();
        const username=$('cloudUsername').value.trim().toLowerCase();
        const password=$('cloudNewPassword').value;
        const confirmation=$('cloudNewPasswordConfirm').value;
        if(!usernameRule.test(username)||checkedUsername!==username){
          msg.textContent='아이디 중복확인을 먼저 완료해 주세요.';return;
        }
        if(!/^[\x21-\x7e]{8,16}$/.test(password)||password!==confirmation){
          msg.textContent=!/^[\x21-\x7e]{8,16}$/.test(password)?'비밀번호는 영문·숫자·특수문자로 8~16자여야 해요.':'비밀번호 확인이 일치하지 않아요.';
          return;
        }
        $('cloudSignupComplete').disabled=true;msg.textContent='계정을 완성하는 중…';
        try{
          await cloud().finishSignup(username,password);
          $('cloudNewPassword').value='';$('cloudNewPasswordConfirm').value='';
          await showUser();
        }catch(err){
          msg.textContent='가입 완료 실패: '+err.message;
          checkedUsername='';
          $('cloudUsernameStatus').textContent='아이디 중복확인을 다시 진행해 주세요.';
        }finally{$('cloudSignupComplete').disabled=false;}
      });
      $('cloudSignupCancel').addEventListener('click',async()=>{
        try{
          await cloud().logout();
          $('cloudNewPassword').value='';$('cloudNewPasswordConfirm').value='';
          authPanel('login');
        }catch(err){msg.textContent='취소 실패: '+err.message;}
      });
      $('cloudLogout').addEventListener('click',async()=>{
        await flushSave();
        try{await cloud().logout();current=null;attachments=[];entries=[];revokeMediaUrls();renderAttachments();await showUser();}
        catch(e){toast('로그아웃 실패: '+e.message);}
      });
      $('cloudImport').addEventListener('click',importLocal);
      try{await showUser();}catch(e){auth.hidden=false;app.hidden=true;msg.textContent='서버 연결 오류: '+e.message;}
      return;
    }
    await loadEntries();
  }
  async function loadEntries() {
    try {
      if(cloudMode){entries=await cloud().entries();}
      else {db=await openDb();entries=await getAll('entries');}

      if(entries.length) await selectEntry([...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0].id,false);
      else await newEntry(dayString(),false,false);
      renderList();showHome();$('diaryApp').hidden=false;
      await restoreLatestPending();
    } catch(e) {
      console.error(e);setSave('error','저장소 사용 불가');toast('브라우저의 저장소를 열 수 없어요. 일반 모드에서 다시 열어 주세요.');
      current={id:makeId(),date:dayString(),title:'',body:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};isDraft=true;fillEditor();setSave('','저장 전');$('diaryApp').hidden=false;
    }
  }
  function updateInputCounts(){
    $('titleCount').textContent=el.title.value.length.toLocaleString()+' / '+MAX_TITLE_CHARS+'자';
    el.charCount.textContent=el.body.value.length.toLocaleString()+' / '+MAX_BODY_CHARS.toLocaleString()+'자';
  }
  function textWithinLimits(){
    // Historical saved entries may exceed today's limits; never truncate them.
    return el.title.value.length<=Math.max(MAX_TITLE_CHARS,savedState?.title?.length||0) &&
      el.body.value.length<=Math.max(MAX_BODY_CHARS,savedState?.body?.length||0) &&
      (current?.shortNote||'').length<=Math.max(MAX_NOTE_CHARS,savedState?.shortNote?.length||0);
  }
  function refreshCurrentFromForm() {
    if(!current) return;
    current.title=el.title.value;current.body=el.body.value;
  }
  function queueSave(){
    if(!current||!db)return;
    refreshCurrentFromForm();updateInputCounts();
    if(!textWithinLimits()){setSave('error','글자 수 초과');return;}
    setSave('','저장 전 · 임시 보관');
    schedulePending();
  }
  async function saveCurrent(explicit=false){
    if(pendingFileJobs){toast('사진·파일 처리가 끝난 뒤 저장해 주세요.');return false;}
    // Persist to the account/server only following an explicit save action.
    if(!explicit||!current||!db||isSavingDraft)return false;
    refreshCurrentFromForm();updateInputCounts();
    if(!textWithinLimits()){
      setSave('error','글자 수 초과');toast('글자 수 제한을 확인해 주세요.');return false;
    }
    if(!(current.title?.trim()||current.body?.trim()||current.shortNote?.trim()||
      current.weather||current.coverAttachmentId||attachments.length)){
      toast('내용을 입력한 뒤 저장해 주세요.');return false;
    }
    if(!hasUnsavedChanges()){
      setSave('','저장됨');toast('이미 저장된 기록이에요.',true);return true;
    }
    isSavingDraft=true;setSave('saving','저장 중…');
    stagePending();
    const snapshot={...current,updatedAt:new Date().toISOString()};
    const additions=attachments.filter(f=>!savedFileIds.has(f.id));
    const removals=[...savedFileIds].filter(id=>!attachments.some(f=>f.id===id));
    try{
      await pendingWrites.catch(()=>{});
      await writeRecords('entries',[snapshot]);
      if(additions.length)await writeRecords('attachments',additions);
      for(const id of removals)await deleteOne('attachments',id);
      current=snapshot;
      const i=entries.findIndex(e=>e.id===snapshot.id);
      if(i<0)entries.push({...snapshot});else entries[i]={...snapshot};
      isDraft=false;setSavedBaseline();
      await clearPending(snapshot.id);
      if(hasUnsavedChanges()){setSave('','저장 전 · 임시 보관');schedulePending();}
      else setSave('','저장됨');
      el.edited.textContent='방금 수정됨';
      $('deleteEntryBtn').textContent='이 일기 전체 삭제';
      renderList();toast('저장되었습니다.',true);
      return true;
    }catch(e){
      console.error(e);setSave('error','저장 실패');
      toast('저장 중 오류가 발생했어요. 임시 보관 내용은 유지합니다.');
      return false;
    }finally{isSavingDraft=false;}
  }
  async function flushSave(){
    // Navigation and page exit must never commit unsaved content.
    clearTimeout(pendingTimer);
    if(hasUnsavedChanges())stagePending();
    await pendingWrites.catch(()=>{});
  }
  function renderEntryMeta() {
    const date=current?.date||dayString();
    const parts=date.split('-'),weekday=WEEK_KR[new Date(date+'T12:00:00').getDay()];
    el.dateDisplay.textContent=`${parts[0]}. ${Number(parts[1])}. ${Number(parts[2])}. (${weekday})`;
    const labels={sunny:'☀️ 맑음',partly_cloudy:'🌤️ 구름 조금',cloudy:'☁️ 흐림',rain:'🌧️ 비',snow:'❄️ 눈',wind:'💨 바람',other:'🌈 기타'};
    $('metaWeatherText').textContent=labels[current?.weather]||'선택하지 않음';
    const note=$('metaNoteText'),hasNote=!!current?.shortNote?.trim();
    note.textContent=hasNote?current.shortNote.trim():'오늘의 한마디를 남겨주세요';
    note.classList.toggle('entry-meta-placeholder',!hasNote);
    const d=new Date(`${date}T12:00:00`);
    $('stickerMonth').textContent=MONTH_EN[d.getMonth()];
    $('stickerDay').textContent=String(d.getDate());
    $('stickerWeek').textContent=WEEK_EN[d.getDay()];
  }
  function fillEditor() {
    el.title.value=current?.title||'';el.body.value=current?.body||'';
    el.title.maxLength=Math.max(MAX_TITLE_CHARS,el.title.value.length);
    el.body.maxLength=Math.max(MAX_BODY_CHARS,el.body.value.length);
    renderEntryMeta();setCalendarMonth(current?.date||dayString());
    applyBodyFontSize();
    el.edited.textContent=current?.updatedAt ? `${new Date(current.updatedAt).toLocaleDateString('ko-KR')} 수정` : '';
    updateInputCounts();renderPreview();
    updateDiaryNavigation();
  }
  function canLeaveDraft(){return canLeaveUnsaved();}
  async function selectEntry(id, navigate = true) {
    if(current?.id===id){if(navigate)showEditor();return;}
    if(!canLeaveDraft())return;
    await flushSave();
    const stored=entries.find(e=>e.id===id);
    if(!stored)return;
    current={...stored};
    isDraft=false;fillEditor();attachments=db ? await getAll('attachments','entryId',id) : [];
    setSavedBaseline();
    let recovered=false;
    if(navigate){
      try{
        await pendingWrites.catch(()=>{});
        const draft=await pendingOperation('readonly',store=>store.get(pendingKey(id)));
        if(draft?.entry && draft.changedAt>stored.updatedAt){
          current={...draft.entry};attachments=draft.files||[];
          recovered=true;fillEditor();
        }
      }catch(e){console.warn('선택한 기록 임시 보관 확인 실패',e);}
    }
    renderAttachments();renderList();
    setSave('',recovered?'임시 보관됨 · 저장 필요':'저장됨');
    $('deleteEntryBtn').textContent='이 일기 전체 삭제';
    if(navigate)showEditor();
  }
  async function newEntry(date = dayString(), focusTitle = true, navigate = true) {
    if(!canLeaveDraft())return;
    await flushSave();
    const timestamp=new Date().toISOString();
    current={id:makeId(),date,title:'',body:'',weather:'',shortNote:'',calendarShowTitle:true,photoLayout:{},createdAt:timestamp,updatedAt:timestamp};
    isDraft=true;
    fillEditor();attachments=[];savedState=null;savedFileIds=new Set();renderAttachments();renderList();setSave('','저장 전');
    el.edited.textContent='저장 전';$('deleteEntryBtn').textContent='작성 내용 지우기';if(navigate)showEditor();if(focusTitle&&navigate)el.title.focus();
  }
  function setCalendarMonth(iso) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso || '');
    if (!match) return;
    calendarYear = Number(match[1]);
    calendarMonth = Number(match[2]) - 1;
  }
  const WEATHER_EMOJI={sunny:'☀️',partly_cloudy:'🌤️',cloudy:'☁️',rain:'🌧️',snow:'❄️',wind:'💨',other:'🌈'};
  function showPage(page){
    if(page!=='diary'&&!$('editorPage').hidden&&!canLeaveUnsaved())return false;
    document.activeElement?.blur?.();
    $('diaryApp').dataset.page=page;
    calendarPageOpen=page==='calendar';
    $('homePage').hidden=page!=='home';
    $('calendarPage').hidden=page!=='calendar';
    $('editorPage').hidden=page!=='diary';
    $('myPage').hidden=page!=='mypage';
    document.querySelectorAll('[data-tab]').forEach(button=>{
      if(button.dataset.tab===page)button.setAttribute('aria-current','page');
      else button.removeAttribute('aria-current');
    });
    if(page==='calendar')renderMiniCalendar();
    if(page==='home')renderHome();
    if(page==='mypage')renderMyPage();
    closeSidebar();
    return true;
  }
  function showEditor(){showPage('diary');}
  function showMiniCalendar(){showPage('calendar');}
  function showHome(){showPage('home');}
  function showMyPage(){showPage('mypage');}
  function diaryOrder(){return [...entries].sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));}
  function diaryNeighbors(){
    const ordered=diaryOrder(),index=ordered.findIndex(e=>e.id===current?.id);
    if(index<0){const split=ordered.findIndex(e=>e.date>(current?.date||dayString()));return {previous:split<0?ordered.at(-1):ordered[split-1],next:split<0?null:ordered[split]};}
    return {previous:ordered[index-1],next:ordered[index+1]};
  }
  function updateDiaryNavigation(){
    if(!$('diaryPrevious'))return;
    const {previous,next}=diaryNeighbors();
    for(const [id,entry] of [['diaryPrevious',previous],['diaryNext',next]]){
      $(id).disabled=!entry;
      $(id).title=entry?entry.date+' · '+(entry.title||'제목 없는 기록'):'더 이상 기록이 없어요.';
    }
    $('diaryNavigationStatus').textContent=current?.date?dateText(current.date,'kr'):'저장한 일기 넘겨보기';
  }
  let diaryNavigating=false;
  async function navigateDiary(direction){
    if(recorder?.state==='recording'){toast('녹음을 종료한 뒤 일기를 넘겨 주세요.');return;}
    if(diaryNavigating||isSavingDraft||isExporting||pendingFileJobs)return;
    const target=diaryNeighbors()[direction<0?'previous':'next'];
    if(!target)return;
    diaryNavigating=true;
    try{await selectEntry(target.id);updateDiaryNavigation();}
    finally{diaryNavigating=false;}
  }
  let usageTimer=null,usageRequest=0;
  function refreshStorageUsage(){
    clearTimeout(usageTimer);const request=++usageRequest;
    if(!$('cloudStorageUsage'))return;
    if(!cloudMode){$('cloudStorageUsage').hidden=true;if($('storageBackupBanner'))$('storageBackupBanner').hidden=true;return;}
    const user=cloud()?.user?.id;
    usageTimer=setTimeout(async()=>{
      try{
        const data=await cloud().storageUsage(dayString());
        if(request!==usageRequest||!cloudMode||cloud()?.user?.id!==user)return;
        $('cloudStorageUsage').hidden=false;
        $('storageUsageText').textContent='오늘 '+formatAttachmentUsage(data.daily_used_bytes)+' / '+formatAttachmentUsage(data.daily_limit_bytes)+' · 전체 '+formatAttachmentUsage(data.used_bytes)+' / '+formatAttachmentUsage(data.limit_bytes);
        $('storageUsageMeter').value=Math.min(100,100*data.used_bytes/data.limit_bytes);
        const warning=!!(data.near_limit||data.project_near_limit);
        $('storageBackupNotice').hidden=!warning;
        const message=data.project_near_limit?'서버 파일 공간이 백업 안내 기준에 도달했어요. 지난달 기록을 백업해 주세요.':'개인 저장 공간을 80% 이상 사용했어요. 지난달 기록을 백업해 주세요.';
        $('storageBackupNoticeText').textContent=message+' 백업 파일을 확인한 뒤 불필요한 기록을 정리하면 공간이 확보돼요.';
        if($('storageBackupBanner')){
          $('storageBackupBanner').hidden=!warning;
          $('storageBackupBannerText').textContent=message;
        }
      }catch(e){
        if(request!==usageRequest)return;
        $('cloudStorageUsage').hidden=false;
        $('storageUsageText').textContent='저장 공간 사용량을 불러오지 못했어요. 잠시 후 다시 확인해 주세요.';
        $('storageBackupNotice').hidden=true;
      }
    },250);
  }
  function renderHome(){
    $('homeTodayLabel').textContent=dateText(dayString(),'kr');
    $('homeEntryCount').textContent=entries.length+'개';
    const last=[...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
    $('homeRecent').hidden=!last;
    $('homeEmpty').hidden=!!last;
    if(last){
      $('homeRecent').dataset.entryId=last.id;
      $('homeRecentDate').textContent=dateText(last.date,'kr');
      $('homeRecentTitle').textContent=last.title?.trim()||last.shortNote?.trim()||'제목 없는 기록';
    }
  }
  function renderMyPage(){
    const user=cloudMode?cloud()?.user:null;
    $('myPageEmail').textContent=user?.email||(guestMode?'비회원 · 이 기기에만 저장':'이 기기에 저장된 기록');
    $('myPageCount').textContent=entries.length+'개';
    $('myPageLogout').hidden=!cloudMode;
    $('myPageSignIn').hidden=!guestMode;
    $('myPageGuestNotice').hidden=!guestMode;
    $('myPageDanger').hidden=!cloudMode;
  }
  function closeDayCard(){
    $('dayCardDialog').close();cardDate=null;cardPhoto=null;cardImage=null;cardCoverFileId=null;
    if(cardObjectUrl){URL.revokeObjectURL(cardObjectUrl);cardObjectUrl=null;}
  }
  async function openDayCard(date){
    document.activeElement?.blur?.();
    cardDate=date;cardPhoto=null;cardImage=null;cardCoverFileId=null;cardZoom=1;cardOffsetX=0;cardOffsetY=0;
    $('dayCardTitle').textContent=date+' 기록';
    const entry=entries.filter(e=>e.date===date).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
    $('dayCardNote').value=entry?.shortNote||'';
    $('dayCardShowTitle').checked=entry ? entry.calendarShowTitle!==false : true;
    $('dayCardNote').maxLength=Math.max(MAX_NOTE_CHARS,$('dayCardNote').value.length);
    $('dayCardStatus').textContent='';
    $('dayCropSection').hidden=true;$('dayCropZoom').value='1';$('dayDeletePhoto').hidden=true;$('dayDeletePhoto').textContent='✕ 썸네일 삭제';
    const view=$('dayExistingPhoto');view.replaceChildren();view.hidden=true;
    $('dayCardSave').disabled=false;
    if(entry){
      try{
        const files=await getAll('attachments','entryId',entry.id);
        if(cardDate!==date)return;
        const cover=files.find(f=>f.id===entry.coverAttachmentId && f.type.startsWith('image/'));
        if(cover){
          cardCoverFileId=cover.id;
          const url=URL.createObjectURL(cover.blob);cardObjectUrl=url;
          const img=document.createElement('img');img.src=url;img.alt='현재 캘린더 썸네일';
          view.append(img);view.hidden=false;$('dayDeletePhoto').hidden=false;
        }
      }catch(e){$('dayCardStatus').textContent='기존 사진 불러오기 실패: '+e.message;}
    }
    if(!$('dayCardDialog').open)$('dayCardDialog').showModal();
  }
  async function deleteDayCardPhoto(){
    const button=$('dayDeletePhoto');
    if(cardPhoto){
      cardPhoto=null;cardImage=null;$('dayCropSection').hidden=true;
      button.textContent='✕ 썸네일 삭제';button.hidden=!cardCoverFileId;
      $('dayCardStatus').textContent='선택한 사진을 취소했어요.';
      return;
    }
    if(!cardCoverFileId||!cardDate)return;
    if(!confirm('이 날짜의 캘린더 썸네일을 삭제할까요? 일반 첨부사진과 일기는 그대로 유지돼요.'))return;
    const date=cardDate,oldId=cardCoverFileId;
    button.disabled=true;$('dayCardStatus').textContent='썸네일 삭제 중…';
    try{
      await flushSave();
      const entry=entries.filter(e=>e.date===date).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
      if(!entry)throw Error('기록을 찾을 수 없어요.');
      const updated={...entry,coverAttachmentId:null,updatedAt:new Date().toISOString()};
      await writeRecords('entries',[updated]);
      entries=entries.map(e=>e.id===updated.id?updated:e);
      const editorDirty=current?.id===updated.id&&hasUnsavedChanges();
      if(current?.id===updated.id){
        current=editorDirty?{...current,coverAttachmentId:null,updatedAt:updated.updatedAt}:{...updated};
      }
      let cleanupError=null;
      try{await deleteOne('attachments',oldId);}catch(e){cleanupError=e;console.error('썸네일 원본 정리 실패',e);}
      cardCoverFileId=null;
      $('dayExistingPhoto').replaceChildren();$('dayExistingPhoto').hidden=true;
      if(cardObjectUrl){URL.revokeObjectURL(cardObjectUrl);cardObjectUrl=null;}
      button.hidden=true;
      if(current?.id===updated.id){
        if(editorDirty){
          attachments=attachments.filter(f=>f.id!==oldId);
          savedState=entryFields(updated);savedFileIds.delete(oldId);
          renderEntryMeta();queueSave();
        }else{
          attachments=await getAll('attachments','entryId',updated.id);
          setSavedBaseline();fillEditor();
        }
        renderAttachments();
      }
      renderList();
      if(cleanupError){
        $('dayCardStatus').textContent='달력에서는 삭제했지만 서버 원본 정리에 실패했어요.';
        toast('썸네일 표시 해제됨. 파일 정리는 다시 확인해 주세요.');
      }else{
        $('dayCardStatus').textContent='썸네일을 삭제했어요.';
        toast('썸네일을 삭제했어요.');
      }
    }catch(e){
      console.error(e);$('dayCardStatus').textContent='썸네일 삭제 실패: '+e.message;
    }finally{button.disabled=false;}
  }
  function paintCrop(){
    if(!cardImage)return;
    const canvas=$('dayCropCanvas'),ctx=canvas.getContext('2d');
    const ratio=Math.min(canvas.width/cardImage.naturalWidth,canvas.height/cardImage.naturalHeight)*cardZoom;
    const w=cardImage.naturalWidth*ratio,h=cardImage.naturalHeight*ratio;
    const x=(canvas.width-w)/2+cardOffsetX,y=(canvas.height-h)/2+cardOffsetY;
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.fillStyle='#75563f';ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(cardImage,x,y,w,h);
  }
  async function saveDayCard(){
    if(!cardDate)return;
    const date=cardDate,note=$('dayCardNote').value.trim(),button=$('dayCardSave');
    const existing=entries.filter(e=>e.date===date).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
    if(!note&&!cardPhoto&&!existing?.title?.trim()&&!existing?.body?.trim()&&!existing?.weather&&!existing?.coverAttachmentId){
      toast('한마디나 사진을 추가한 뒤 저장해 주세요.');return;
    }
    button.disabled=true;$('dayCardStatus').textContent='서버에 저장 중…';
    let entrySaved=false;
    try{
      await flushSave();
      let entry=entries.filter(e=>e.date===date).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
      const isNew=!entry,now=new Date().toISOString();
      if(isNew)entry={id:makeId(),date,title:'',body:'',weather:'',shortNote:'',calendarShowTitle:true,createdAt:now,updatedAt:now};
      else entry={...entry};
      entry.shortNote=note;entry.calendarShowTitle=$('dayCardShowTitle').checked;entry.updatedAt=now;
      const previousCoverId=cardCoverFileId||entry.coverAttachmentId||null;
      let file=null;
      if(cardPhoto){
        const canvas=$('dayCropCanvas');
        const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('이미지를 자르지 못했어요.')),'image/jpeg',.86));
        if(blob.size>FILE_LIMITS.image)throw Error('썸네일은 1MB 이하여야 해요.');
        file={id:makeId(),entryId:entry.id,name:'달력_썸네일_'+date+'.jpg',type:'image/jpeg',size:blob.size,blob,createdAt:now};
      }
      await writeRecords('entries',[entry]);
      entrySaved=true;
      if(isNew)entries.push(entry);else entries=entries.map(e=>e.id===entry.id?entry:e);
      if(file){
        await writeRecords('attachments',[file]);
        entry.coverAttachmentId=file.id;
        await writeRecords('entries',[entry]);
        if(previousCoverId&&previousCoverId!==file.id){
          try{await deleteOne('attachments',previousCoverId);}
          catch(err){console.warn('이전 썸네일 정리 실패:',err);}
        }
      }
      if(current?.id===entry.id){
        const editorDirty=hasUnsavedChanges();
        current=editorDirty?
          {...current,shortNote:entry.shortNote,calendarShowTitle:entry.calendarShowTitle,coverAttachmentId:entry.coverAttachmentId,updatedAt:entry.updatedAt}:
          {...entry};
        const storedFiles=await getAll('attachments','entryId',entry.id);
        if(editorDirty){
          if(file&&!attachments.some(f=>f.id===file.id))attachments.push(file);
          if(previousCoverId)attachments=attachments.filter(f=>f.id!==previousCoverId||f.id===file?.id);
          savedState=entryFields(entry);
          savedFileIds=new Set(storedFiles.map(f=>f.id));
          renderEntryMeta();queueSave();
        }else{attachments=storedFiles;setSavedBaseline();fillEditor();}
        renderAttachments();
      }
      renderList();closeDayCard();toast('저장되었습니다.', true);
    }catch(e){
      console.error(e);
      if(entrySaved){
        renderList();
        $('dayCardStatus').textContent='일기 정보는 저장됐지만 사진 저장에 실패했어요: '+e.message;
      }else $('dayCardStatus').textContent='저장 실패: '+e.message;
      toast('일부 저장에 실패했어요. 내용을 확인해 주세요.');
    }finally{button.disabled=false;}
  }
  function renderMiniCalendar(){
    if(!calendarPageOpen)return;
    $('miniYear').textContent=`${calendarYear}년`;
    $('miniMonth').textContent=`${calendarMonth+1}월`;
    const first=new Date(calendarYear,calendarMonth,1).getDay(),last=new Date(calendarYear,calendarMonth+1,0).getDate(),prefix=`${calendarYear}-${String(calendarMonth+1).padStart(2,'0')}-`;
    const byDay=new Map();
    for(const entry of [...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)))if(entry.date.startsWith(prefix)&&!byDay.has(entry.date))byDay.set(entry.date,entry);
    const cells=Array.from({length:first},()=>'<div class="mini-pad"></div>');
    for(let d=1;d<=last;d++){
      const date=prefix+String(d).padStart(2,'0'),entry=byDay.get(date);
      const note=entry?(entry.calendarShowTitle!==false?(entry.title||''):(entry.shortNote||'')):'';
      const weather=entry?(WEATHER_EMOJI[entry.weather]||''):'';
      cells.push(`<button class="mini-day ${entry?'filled':''} ${date===dayString()?'today':''} ${date===highlightedCalendarDate?'jump-selected':''}" data-mini-date="${date}" aria-pressed="${date===highlightedCalendarDate}"><span class="mini-day-head"><span class="mini-date">${d}</span>${weather?`<span class="mini-weather" aria-label="날씨">${weather}</span>`:''}</span><span class="mini-photo" data-mini-photo="${date}">+</span><span class="mini-caption"><span class="mini-line ${note?'has-note':''}">${escapeHtml(note)}</span></span></button>`);
    }
    $('miniGrid').innerHTML=cells.join('');
    loadMiniPhotos();
  }
  async function loadMiniPhotos(){
    const token=++miniPhotoToken;
    for(const url of miniPhotoUrls)URL.revokeObjectURL(url);
    miniPhotoUrls.length=0;
    const prefix=`${calendarYear}-${String(calendarMonth+1).padStart(2,'0')}-`;
    const visible=entries.filter(e=>e.date.startsWith(prefix)),ids=new Set(visible.map(e=>e.id));
    const dateById=new Map(visible.map(e=>[e.id,e.date]));
    const paint=(id,url)=>{
      if(token!==miniPhotoToken)return;
      const date=dateById.get(id);if(!date)return;
      const slot=[...document.querySelectorAll('[data-mini-photo]')].find(el=>el.dataset.miniPhoto===date);
      if(!slot||slot.querySelector('img'))return;
      const img=document.createElement('img');img.loading='lazy';img.alt='일기 사진';img.src=url;slot.replaceChildren(img);slot.classList.add('has-image');
    };
    try{
      if(cloudMode){
        const photos=await cloud().photoPreviews([...ids]);
        if(token!==miniPhotoToken)return;
        const priority=new Map(visible.map(e=>[e.id,e.coverAttachmentId]));
        for(const f of photos.filter(f=>priority.get(f.entryId)===f.id))paint(f.entryId,f.url);
      }else if(db){
        const files=await getAll('attachments');
        if(token!==miniPhotoToken)return;
        const covers=new Map(visible.filter(e=>e.coverAttachmentId).map(e=>[e.id,e.coverAttachmentId]));
        for(const f of files)if(ids.has(f.entryId)&&covers.get(f.entryId)===f.id&&f.type.startsWith('image/')){
          const url=URL.createObjectURL(f.blob);miniPhotoUrls.push(url);paint(f.entryId,url);
        }
      }
    }catch(e){console.warn('미니 캘린더 이미지',e);}
  }
  function renderCalendar() {
    if (!el.calendarGrid) return;
    el.calendarMonthLabel.textContent = `${calendarYear}년 ${calendarMonth + 1}월`;
    const startDay = new Date(calendarYear, calendarMonth, 1).getDay();
    const lastDate = new Date(calendarYear, calendarMonth + 1, 0).getDate();
    const prefix = `${calendarYear}-${String(calendarMonth + 1).padStart(2, '0')}-`;
    const byDate = new Map();
    for (const entry of entries) {
      if (!entry.date.startsWith(prefix)) continue;
      byDate.set(entry.date, (byDate.get(entry.date) || 0) + 1);
    }
    const days = Array.from({length: startDay}, () => '<span class="calendar-pad" aria-hidden="true"></span>');
    for (let day = 1; day <= lastDate; day++) {
      const iso = prefix + String(day).padStart(2, '0');
      const count = byDate.get(iso) || 0;
      const classes = ['calendar-day', count ? 'has-entry' : '', iso === current?.date ? 'active' : '', iso === dayString() ? 'today' : '', iso === highlightedCalendarDate ? 'jump-selected' : ''].filter(Boolean).join(' ');
      const label = `${dateText(iso, 'kr')}, ${count ? `기록 ${count}개 열기` : '새 기록 작성 (저장 버튼을 눌러야 등록)'}`;
      days.push(`<button type="button" class="${classes}" data-calendar-date="${iso}" aria-label="${escapeHtml(label)}" aria-pressed="${iso === current?.date || iso === highlightedCalendarDate}"><span>${day}</span>${count > 1 ? `<small class="calendar-multi">${count}</small>` : ''}</button>`);
    }
    el.calendarGrid.innerHTML = days.join('');
    if(calendarPageOpen)renderMiniCalendar();
  }
  function jumpToToday(kind){
    highlightedCalendarDate=dayString();
    setCalendarMonth(highlightedCalendarDate);
    renderCalendar();
    const selector=kind==='large'?'[data-mini-date="'+highlightedCalendarDate+'"]':'[data-calendar-date="'+highlightedCalendarDate+'"]';
    const cell=document.querySelector(selector);
    if(cell){cell.focus({preventScroll:true});cell.scrollIntoView({block:'nearest',behavior:'smooth'});}
  }
  function shiftCalendar(delta) {
    highlightedCalendarDate=null;
    const target = new Date(calendarYear, calendarMonth + delta, 1);
    calendarYear = target.getFullYear();
    calendarMonth = target.getMonth();
    renderCalendar();
  }
  function openCalendarJump(focusMonth=false){
    $('calendarJumpYear').value=calendarYear;
    $('calendarJumpMonth').value=calendarMonth;
    $('calendarJumpDialog').showModal();
    const field=$(focusMonth?'calendarJumpMonth':'calendarJumpYear');
    field.focus();
    if(!focusMonth)field.select();
  }
  function renderList() {
    const q=el.search.value.trim().toLocaleLowerCase();
    const all=[...entries].sort((a,b)=>b.date.localeCompare(a.date) || b.updatedAt.localeCompare(a.updatedAt));
    el.count.textContent=entries.length;
    renderCalendar();
    const shown=all.filter(e=>`${e.date} ${e.title} ${e.body}`.toLocaleLowerCase().includes(q));
    el.list.innerHTML=shown.length ? shown.map(e=>{
      const id=escapeHtml(e.id);
      const label=escapeHtml(e.title.trim() || dateText(e.date));
      return `<div class="list-entry-row"><button type="button" class="list-entry ${e.id===current?.id?'active':''}" data-entry-id="${id}"><div class="entry-list-date">${escapeHtml(dateText(e.date))}</div><div class="entry-list-title">${escapeHtml(e.title.trim()||'제목 없는 기록')}</div><div class="entry-list-excerpt">${escapeHtml(e.body.replace(/[#*_>\[\]\n-]/g,' ').trim().slice(0,90)||'여기에 하루의 이야기를 담아보세요.')}</div></button><button type="button" class="list-entry-delete" data-delete-entry-id="${id}" aria-label="${label} 기록 삭제" title="이 기록 삭제">삭제</button></div>`;
    }).join('') : '<div class="list-empty">검색된 기록이 없어요.<br>새로운 하루를 남겨볼까요?</div>';
    renderHome();
    updateBackupPeriod();
    $('sidebarGuestAccount').hidden=cloudMode;
    updateDiaryNavigation();
    refreshStorageUsage();
    if(!$('myPage').hidden)renderMyPage();
  }
  async function deleteSavedRecord(id) {
    const entry=entries.find(e=>e.id===id);
    if(!entry) return;
    if(!confirm(`"${entry.title.trim()||dateText(entry.date)}" 기록과 첨부 파일을 삭제할까요?\n삭제하면 복구할 수 없어요.`))return;
    await flushSave();
    try{
      await deleteEntryData(id);
      await clearPending(id);
      entries=entries.filter(e=>e.id!==id);
      if(current?.id===id){
        current=null;attachments=[];isDraft=false;
        const next=[...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
        if(next)await selectEntry(next.id);
        else await newEntry();
      }
      renderList();toast('기록을 삭제했어요.');
    }catch(e){console.error(e);toast('기록을 삭제하지 못했어요.');}
  }
  function openEntryMeta() {
    if(!current)return;
    el.date.value=current.date||dayString();
    $('entryWeather').value=current.weather||'';
    $('entryShortNote').value=current.shortNote||'';
    $('entryShortNote').maxLength=Math.max(MAX_NOTE_CHARS,$('entryShortNote').value.length);
    $('entryMetaCount').textContent=$('entryShortNote').value.length+'/'+MAX_NOTE_CHARS;
    $('entryMetaStatus').textContent='';
    document.activeElement?.blur?.();
    $('entryMetaDialog').showModal();
    $('entryMetaCancel').focus({preventScroll:true});
  }
  async function saveEntryMeta(){
    if(!current)return;
    const date=el.date.value,weather=$('entryWeather').value,note=$('entryShortNote').value.trim();
    if(!el.date.checkValidity()||!/^\d{4}-\d{2}-\d{2}$/.test(date)){
      $('entryMetaStatus').textContent='날짜를 확인해 주세요.';return;
    }
    if(date===current.date&&weather===(current.weather||'')&&note===(current.shortNote||'')){
      $('entryMetaDialog').close();return;
    }
    current.date=date;current.weather=weather;current.shortNote=note;
    renderEntryMeta();setCalendarMonth(date);renderList();
    queueSave();
    $('entryMetaDialog').close();
    toast('변경사항을 적용했어요. 일기 저장 버튼으로 확정해 주세요.');
  }
  function inlineMarkdown(raw) {
    const tokens=[];
    let s=escapeHtml(raw);
    s=s.replace(/`([^`\n]+)`/g,(_,v)=>{const id=tokens.push(`<code>${v}</code>`)-1;return `\uE000${id}\uE001`;});
    s=s.replace(/\[([^\]\n]+)\]\(([^\s)]+)\)/g,(_,label,rawUrl)=>{
      const url=rawUrl.replace(/&amp;/g,'&');
      if(!/^(https?:\/\/|mailto:)/i.test(url))return label;
      return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    });
    s=s.replace(/\*\*([^*\n]+)\*\*|__([^_\n]+)__/g,(_,a,b)=>`<strong>${a||b}</strong>`);
    s=s.replace(/\*([^*\n]+)\*|_([^_\n]+)_/g,(_,a,b)=>`<em>${a||b}</em>`);
    s=s.replace(/~~([^\n~]+)~~/g,'<del>$1</del>');
    s=s.replace(/&lt;u&gt;(.*?)&lt;\/u&gt;/g,'<u>$1</u>');
    return s.replace(/\uE000(\d+)\uE001/g,(_,i)=>tokens[Number(i)]);
  }
  function parseBlocks(body) {
    const lines=body.replace(/\r\n?/g,'\n').split('\n'),blocks=[];let i=0;
    while(i<lines.length){const s=lines[i],t=s.trim();
      if(!t){i++;continue;}
      if(/^```/.test(t)){const code=[];i++;while(i<lines.length && !/^```/.test(lines[i].trim()))code.push(lines[i++]);if(i<lines.length)i++;blocks.push({kind:'code',text:code.join('\n')});continue;}
      const heading=/^(#{1,3})\s+(.*)$/.exec(t);if(heading){blocks.push({kind:'heading',level:heading[1].length,text:heading[2]});i++;continue;}
      if(/^(?:-{3,}|\*{3,}|_{3,})$/.test(t)){blocks.push({kind:'rule'});i++;continue;}
      if(/^>\s?/.test(t)){const items=[];while(i<lines.length && /^\s*>\s?/.test(lines[i]))items.push(lines[i++].trim().replace(/^>\s?/,''));blocks.push({kind:'quote',text:items.join(' ')});continue;}
      if(/^\s*[-*+]\s+/.test(s)){const items=[];while(i<lines.length && /^\s*[-*+]\s+/.test(lines[i])){let v=lines[i++].trim().replace(/^[-*+]\s+/,'');let check=null;const c=/^\[([ xX])\]\s*/.exec(v);if(c){check=c[1].toLowerCase()==='x';v=v.slice(c[0].length);}items.push({text:v,check});}blocks.push({kind:'list',ordered:false,items});continue;}
      if(/^\s*\d+\.\s+/.test(s)){const items=[];while(i<lines.length&&/^\s*\d+\.\s+/.test(lines[i]))items.push({text:lines[i++].trim().replace(/^\d+\.\s+/,'')});blocks.push({kind:'list',ordered:true,items});continue;}
      const p=[s.trim()];i++;while(i<lines.length && lines[i].trim() && !/^(#{1,3})\s+|^```|^\s*>\s?|^\s*[-*+]\s+|^\s*\d+\.\s+|^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]))p.push(lines[i++].trim());
      blocks.push({kind:'paragraph',text:p.join('\n')});
    }return blocks;
  }
  function renderPreview() {
    const blocks=parseBlocks(el.body.value);
    el.preview.innerHTML=blocks.map(b=>{
      switch(b.kind){
        case 'heading':return `<h${b.level}>${inlineMarkdown(b.text)}</h${b.level}>`;
        case 'paragraph':return `<p>${b.text.split('\n').map(inlineMarkdown).join('<br>')}</p>`;
        case 'rule':return '<hr>';
        case 'code':return `<pre><code>${escapeHtml(b.text)}</code></pre>`;
        case 'quote':return `<blockquote>${inlineMarkdown(b.text)}</blockquote>`;
        case 'list':{const tag=b.ordered?'ol':'ul';const check=b.items.some(x=>x.check!==null);return `<${tag}>${b.items.map(x=>`<li>${x.check===null?'':`<input type="checkbox" disabled ${x.check?'checked':''} aria-label="체크 항목"> `}${inlineMarkdown(x.text)}</li>`).join('')}</${tag}>`;}
        default:return '';
      }
    }).join('') || '<p class="preview-placeholder">여기에 기록한 내용이 보여요 ✨</p>';
  }
  function placeStickerBoard(){
    const board=$('entryStickerBoard');
    const pane=el.writing.querySelector(view==='edit'?'.editing-pane':'.preview-pane');
    if(board&&pane&&board.parentElement!==pane)pane.append(board);
  }
  function setView(next) {
    view=next;
    setStickerSelection(null);
    el.writing.className=`writing-area view-${next}${diaryBodyFontSize(current)!==null?' custom-body-size':''}`;
    placeStickerBoard();
    document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===next));
    if(next!=='edit')renderPreview();
  }
  function formatText(kind) {
    const ta=el.body, start=ta.selectionStart,end=ta.selectionEnd,selected=ta.value.slice(start,end),a=ta.value.slice(0,start),b=ta.value.slice(end);
    const wrap=(left,right=left,placeholder='텍스트')=>({insert:left+(selected||placeholder)+right,selStart:left.length,selEnd:left.length+(selected||placeholder).length});
    let edit;
    const linePrefix=(prefix)=>{
      const ls=ta.value.lastIndexOf('\n',start-1)+1;
      const le=ta.value.indexOf('\n',end);const actualEnd=le===-1?ta.value.length:le;
      const slice=ta.value.slice(ls,actualEnd);
      const modified=slice.split('\n').map((line,j)=>prefix(j)+line).join('\n');
      const updated=ta.value.slice(0,ls)+modified+ta.value.slice(actualEnd);
      if(updated.length>ta.maxLength){toast('본문 글자 수 제한을 초과했어요.');return;}
      ta.value=updated;ta.focus();ta.setSelectionRange(ls,ls+modified.length);queueSave();renderPreview();el.charCount.textContent=`${[...ta.value].length.toLocaleString()}자`;return;
    };
    switch(kind){
      case 'bold':edit=wrap('**');break;case 'italic':edit=wrap('*');break;case 'underline':edit=wrap('<u>','</u>');break;
      case 'strike':edit=wrap('~~');break;case 'code':edit=wrap('`');break;
      case 'link':edit={insert:`[${selected||'링크 텍스트'}](https://)`,selStart:1,selEnd:1+(selected||'링크 텍스트').length};break;
      case 'h1':return linePrefix(()=> '# ');case 'h2':return linePrefix(()=> '## ');
      case 'bullet':return linePrefix(()=> '- ');case 'number':return linePrefix(j=> `${j+1}. `);
      case 'check':return linePrefix(()=> '- [ ] ');case 'quote':return linePrefix(()=> '> ');
      case 'rule':edit={insert:`\n\n---\n\n`,selStart:6,selEnd:6};break;
      default:return;
    }
    const updated=a+edit.insert+b;
    if(updated.length>ta.maxLength){toast('본문 글자 수 제한을 초과했어요.');return;}
    ta.value=updated;ta.focus();ta.setSelectionRange(start+edit.selStart,start+edit.selEnd);queueSave();renderPreview();el.charCount.textContent=`${[...ta.value].length.toLocaleString()}자`;
  }
  function closeSidebar(){el.sidebar.classList.remove('open');el.scrim.classList.remove('visible');$('openSidebar').setAttribute('aria-expanded','false');}
  function openSidebar(){el.sidebar.classList.add('open');el.scrim.classList.add('visible');$('openSidebar').setAttribute('aria-expanded','true');}
  function revokeMediaUrls(){for(const u of mediaUrls)URL.revokeObjectURL(u);mediaUrls=[];}
  async function createDiaryPreview(file){
    // Make a centered 4:3 display image while retaining the exact original file.
    const url=URL.createObjectURL(file.blob);
    try{
      const image=new Image();
      await new Promise((resolve,reject)=>{
        image.onload=resolve;image.onerror=()=>reject(Error('미리보기 이미지를 열 수 없어요.'));
        image.src=url;
      });
      const canvas=document.createElement('canvas');
      canvas.width=640;canvas.height=480;
      const ctx=canvas.getContext('2d');
      const scale=Math.max(canvas.width/image.naturalWidth,canvas.height/image.naturalHeight);
      const width=image.naturalWidth*scale,height=image.naturalHeight*scale;
      ctx.drawImage(image,(canvas.width-width)/2,(canvas.height-height)/2,width,height);
      const blob=await new Promise((resolve,reject)=>{
        canvas.toBlob(b=>b?resolve(b):reject(Error('미리보기 생성 실패')),'image/jpeg',.85);
      });
      return {id:makeId(),entryId:file.entryId,name:cropPreviewName(file.id),
        type:'image/jpeg',size:blob.size,blob,createdAt:new Date().toISOString()};
    }finally{URL.revokeObjectURL(url);}
  }

  function visiblePhotos(){
    return attachments.filter(f=>f.type.startsWith('image/')&&!isCalendarCover(f)&&!isDiaryCropPreview(f));
  }
  const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
  function photoLayout(file){
    const a=current?.photoLayout?.[file.id]||{};
    const number=(value,fallback)=>value===null||value===undefined?fallback:Number.isFinite(Number(value))?Number(value):fallback;
    const width=clamp(number(a.width,36),18,76);
    return {mode:a.mode==='sticker'?'sticker':'photo',width,
      x:clamp(number(a.x,8),0,100-width),
      y:clamp(number(a.y,9),0,85),
      rotation:clamp(number(a.rotation,0),-720,720)};
  }
  function updatePhotoLayout(file,changes){
    if(!current||isSavingDraft)return;
    current.photoLayout={...(current.photoLayout||{}),
      [file.id]:{...photoLayout(file),...changes}};
    renderAttachments();queueSave();
  }
  function openPhoto(file,url){
    $('photoPreviewImage').src=url;
    $('photoPreviewImage').alt=file.name;
    $('photoPreviewDialog').showModal();
  }
  function renderEntryPhotos(){
    const section=$('entryPhotoSection'),inline=$('entryInlinePhotos'),board=$('entryStickerBoard');
    placeStickerBoard();
    selectedStickerId=null;
    inline.replaceChildren();board.replaceChildren();
    const photos=visiblePhotos();
    const regular=photos.filter(f=>photoLayout(f).mode!=='sticker');
    const stickers=photos.filter(f=>photoLayout(f).mode==='sticker');
    section.hidden=!regular.length;
    board.hidden=!stickers.length;
    for(const file of regular){
      const url=URL.createObjectURL(file.blob);mediaUrls.push(url);
      const card=document.createElement('div');card.className='entry-photo-inline';
      const photo=document.createElement('button');photo.type='button';photo.className='entry-photo-image';
      const img=document.createElement('img');img.src=url;img.alt=file.name;img.loading='lazy';
      photo.append(img);photo.addEventListener('click',()=>openPhoto(file,url));
      const caption=document.createElement('small');caption.textContent=file.name;
      const controls=document.createElement('div');controls.className='entry-photo-controls';
      const mode=document.createElement('button');mode.type='button';mode.textContent='본문에 스티커로 붙이기';
      mode.addEventListener('click',()=>updatePhotoLayout(file,{mode:'sticker'}));
      controls.append(mode);card.append(photo,caption,controls);inline.append(card);
    }
    for(const file of stickers){
      const url=URL.createObjectURL(file.blob);mediaUrls.push(url);
      const state=photoLayout(file);
      const card=document.createElement('div');card.className='entry-photo-sticker';
      card.dataset.stickerId=file.id;card.tabIndex=0;
      card.setAttribute('role','group');card.setAttribute('aria-selected','false');
      card.setAttribute('aria-label',file.name+' 스티커 - 드래그로 이동, 모서리로 크기와 회전 조절');
      card.style.width=state.width+'%';
      card.style.left=state.x+'%';card.style.top=state.y+'%';
      card.style.transform='rotate('+state.rotation+'deg)';
      const image=document.createElement('img');image.src=url;image.alt=file.name;
      image.draggable=false;card.append(image);
      const rotate=document.createElement('button');rotate.type='button';
      rotate.className='sticker-control sticker-rotate';
      rotate.title='끌어서 회전 · 누르면 15도 회전';
      rotate.setAttribute('aria-label','스티커 회전');rotate.textContent='↻';
      const size=document.createElement('button');size.type='button';
      size.className='sticker-control sticker-resize';
      size.title='끌어서 크기 조절';
      size.setAttribute('aria-label','스티커 크기 조절');size.textContent='⤢';
      const menu=document.createElement('div');menu.className='sticker-menu';
      const view=document.createElement('button');view.type='button';view.textContent='보기';
      view.addEventListener('click',()=>openPhoto(file,url));
      const normal=document.createElement('button');normal.type='button';normal.textContent='일반 사진';
      normal.addEventListener('click',()=>updatePhotoLayout(file,{mode:'photo'}));
      menu.append(view,normal);
      card.append(rotate,size,menu);
      const pointer=(control,kind)=>(event)=>{
        if(isSavingDraft || (event.button!==0&&event.pointerType!=='touch'))return;
        event.preventDefault();event.stopPropagation();
        setStickerSelection(file.id);
        const rect=board.getBoundingClientRect();
        if(!rect.width||!rect.height)return;
        const origin=photoLayout(file),sx=event.clientX,sy=event.clientY;
        const bounds=card.getBoundingClientRect();
        const center={x:bounds.left+bounds.width/2,y:bounds.top+bounds.height/2};
        const originAngle=Math.atan2(sy-center.y,sx-center.x);
        let moved=false;
        control.setPointerCapture(event.pointerId);
        const move=e=>{
          moved=true;
          const dx=e.clientX-sx,dy=e.clientY-sy;
          let next={...origin};
          if(kind==='move'){
            next.x=clamp(origin.x+dx/rect.width*100,0,100-origin.width);
            next.y=clamp(origin.y+dy/rect.height*100,0,85);
          }else if(kind==='resize'){
            next.width=clamp(origin.width+dx/rect.width*100,18,76);
            next.x=clamp(origin.x,0,100-next.width);
          }else{
            const angle=Math.atan2(e.clientY-center.y,e.clientX-center.x);
            next.rotation=origin.rotation+(angle-originAngle)*180/Math.PI;
          }
          current.photoLayout={...(current.photoLayout||{}),[file.id]:next};
          card.style.left=next.x+'%';card.style.top=next.y+'%';
          card.style.width=next.width+'%';card.style.transform='rotate('+next.rotation+'deg)';
        };
        const done=()=>{
          control.removeEventListener('pointermove',move);
          control.removeEventListener('pointerup',done);
          control.removeEventListener('pointercancel',done);
          if(kind==='rotate'&&!moved){
            const now=photoLayout(file);
            current.photoLayout={...(current.photoLayout||{}),[file.id]:{...now,rotation:now.rotation+15}};
            card.style.transform='rotate('+(now.rotation+15)+'deg)';
          }
          queueSave();
        };
        control.addEventListener('pointermove',move);
        control.addEventListener('pointerup',done);
        control.addEventListener('pointercancel',done);
      };
      card.addEventListener('focus',()=>setStickerSelection(file.id));
      card.addEventListener('pointerdown',e=>{
        if(e.target.closest('button'))return;
        pointer(card,'move')(e);
      });
      rotate.addEventListener('pointerdown',pointer(rotate,'rotate'));
      size.addEventListener('pointerdown',pointer(size,'resize'));
      board.append(card);
    }
  }
  function renderAttachments(){
    if($('photoPreviewDialog').open)$('photoPreviewDialog').close();
    revokeMediaUrls();
    const shown=attachments.filter(f=>!isCalendarCover(f)&&!isDiaryCropPreview(f));
    const cropMap=new Map(attachments.filter(isDiaryCropPreview).map(f=>[f.name,f]));
    const bytes=attachmentBytes();
    el.attachCount.textContent=(bytes?formatAttachmentUsage(bytes):'0MB')+' · 하루 합계 10MB';
    el.attachCount.title='같은 날짜의 모든 일기·GIF·음성·PDF·썸네일을 합쳐 10MB까지 저장할 수 있어요.';
    el.attachList.replaceChildren();
    const wall=document.createElement('div');wall.className='photo-wall';
    const files=document.createElement('div');files.className='attachment-files';
    for(const file of shown){
      const isPhoto=file.type.startsWith('image/');
      const outer=document.createElement('div');outer.className=isPhoto?'attachment-item pinned-photo':'attachment-item media-file-card';
      const visual=document.createElement('div');visual.className='attachment-visual';
      const url=URL.createObjectURL(file.blob);mediaUrls.push(url);
      if(isPhoto){
        const open=document.createElement('button');open.type='button';open.className='photo-open';
        open.title='사진 크게 보기';open.setAttribute('aria-label',file.name+' 크게 보기');
        const img=document.createElement('img');
        const preview=cropMap.get(cropPreviewName(file.id));
        if(preview){
          const previewUrl=URL.createObjectURL(preview.blob);mediaUrls.push(previewUrl);img.src=previewUrl;
        }else img.src=url;
        img.alt=file.name;img.loading='lazy';open.append(img);
        open.addEventListener('click',()=>{$('photoPreviewImage').src=url;$('photoPreviewImage').alt=file.name;$('photoPreviewDialog').showModal();});
        visual.append(open);
      }else if(file.type.startsWith('video/')){
        const video=document.createElement('video');video.src=url;video.controls=true;video.preload='metadata';visual.append(video);
      }else if(file.type.startsWith('audio/')){
        const audio=document.createElement('audio');audio.src=url;audio.controls=true;audio.preload='metadata';visual.append(audio);
      }else visual.textContent='PDF';
      const info=document.createElement('div');info.className='attachment-info';
      const name=document.createElement('span');name.className='attachment-name';name.textContent=file.name;name.title=file.name;
      const remove=document.createElement('button');remove.type='button';remove.className='attachment-remove';
      remove.textContent='×';remove.title=file.name+' 삭제';remove.setAttribute('aria-label',file.name+' 삭제');
      remove.addEventListener('click',async()=>{
        if(!confirm('"'+file.name+'" 파일을 삭제할까요?'))return;
        try{
          const related=attachments.find(f=>isDiaryCropPreview(f)&&f.name===cropPreviewName(file.id));
          attachments=attachments.filter(x=>x.id!==file.id&&x.id!==related?.id);
          if(current?.photoLayout){const copy={...current.photoLayout};delete copy[file.id];current.photoLayout=copy;}
          renderAttachments();queueSave();
          toast('첨부를 목록에서 제외했어요. 일기 저장 버튼으로 확정해 주세요.');
        }catch(e){toast('삭제하지 못했어요.');}
      });
      info.append(name);
      info.append(remove);
      const dl=document.createElement('a');dl.className='attachment-download';
      dl.textContent=isPhoto?'사진 다운로드 ↓':'원본 다운로드 ↓';dl.href=url;dl.download=file.name;
      outer.append(visual,info,dl);
      (isPhoto?wall:files).append(outer);
    }
    if(wall.childElementCount)el.attachList.append(wall);
    if(files.childElementCount)el.attachList.append(files);
    renderEntryPhotos();
  }
  async function compressPhoto(file){
    const maxBytes=FILE_LIMITS.image;
    if(file.size>50*1024*1024)throw Error('사진 원본은 50MB 이하로 선택해 주세요.');
    if(file.type==='image/gif'){
      if(file.size<=FILE_LIMITS.gif)return file;
      throw Error('움직이는 GIF는 2MB 이하만 추가할 수 있어요.');
    }
    if(!/^image\/(jpeg|jpg|png|x-png|webp|avif|heic|heif|bmp)$/i.test(file.type))
      throw Error('지원하지 않는 이미지 형식이에요.');
    const url=URL.createObjectURL(file);
    let bitmap=null;
    try{
      const image=new Image();
      let decoded=image,bitmapFallback=false;
      try{
        await new Promise((resolve,reject)=>{
          image.onload=resolve;
          image.onerror=()=>reject(Error('기본 이미지 해독 실패'));
          image.src=url;
        });
      }catch{
        if(typeof createImageBitmap!=='function')throw Error('이 사진을 열 수 없어요. JPG 또는 PNG로 다시 선택해 주세요.');
        try{bitmap=await createImageBitmap(file);decoded=bitmap;bitmapFallback=true;}
        catch{throw Error('이 사진 형식을 열 수 없어요. JPG 또는 PNG로 바꿔 주세요.');}
      }
      const sourceWidth=decoded.naturalWidth||decoded.width;
      const sourceHeight=decoded.naturalHeight||decoded.height;
      if(!sourceWidth||!sourceHeight)throw Error('사진 해상도를 읽지 못했어요.');
      const ratio=Math.min(1,1920/Math.max(sourceWidth,sourceHeight));
      if(file.size<=maxBytes&&ratio===1&&!bitmapFallback&&/^image\/(jpeg|jpg|png|webp)$/i.test(file.type))return file;
      const canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{alpha:true});
      if(!ctx)throw Error('사진 압축을 지원하지 않아요.');
      for(const factor of [1,.85,.7,.55,.4,.3]){
        canvas.width=Math.max(1,Math.round(sourceWidth*ratio*factor));
        canvas.height=Math.max(1,Math.round(sourceHeight*ratio*factor));
        ctx.clearRect(0,0,canvas.width,canvas.height);
        ctx.drawImage(decoded,0,0,canvas.width,canvas.height);
        for(const quality of [.85,.78,.7,.6]){
          const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',quality));
          if(!blob||blob.type!=='image/webp')throw Error('이 브라우저에서는 WebP 압축을 지원하지 않아요.');
          if(blob.size<=maxBytes)
            return new File([blob],file.name.replace(/\.[^.]+$/,'')+'.webp',{type:'image/webp'});
        }
      }
      throw Error('사진을 1MB 이하로 압축하지 못했어요.');
    }finally{
      if(bitmap)bitmap.close();
      URL.revokeObjectURL(url);
    }
  }
  function addFiles(fileList,entryId=current?.id,photoMode='photo'){
    const files=[...fileList];pendingFileJobs++;
    attachmentQueue=attachmentQueue.catch(()=>{}).then(()=>processFiles(files,entryId,photoMode)).finally(()=>{pendingFileJobs--;});
    return attachmentQueue;
  }
  async function processFiles(fileList, entryId=current?.id, photoMode='photo'){
    if(isSavingDraft){toast('저장 중에는 첨부를 변경할 수 없어요.');return;}
    if(!db){toast('저장소에 접근할 수 없어요.');return;}
    const targetDraft=isDraft && current?.id===entryId;
    if(!targetDraft && !entries.some(e=>e.id===entryId)){toast('해당 기록이 더 이상 열려 있지 않아요.');return;}
    let added=0;
    let diaryPhotoCount=visiblePhotos().length;
    let usedBytes=attachmentBytes();
    const pendingBytes=attachments.filter(f=>!savedFileIds.has(f.id)).reduce((n,f)=>n+(f.blob?.size||f.size||0),0);
    let remainingDay,remainingTotal;
    if(cloudMode){
      const usage=await cloud().storageUsage(current.date);
      remainingDay=MAX_ATTACHMENT_BYTES-usage.daily_used_bytes-pendingBytes;
      remainingTotal=USER_ATTACHMENT_BYTES-usage.used_bytes-pendingBytes;
    }else{
      const stored=await getAll('attachments'),dates=new Map((await getAll('entries')).map(e=>[e.id,e.date]));
      remainingDay=MAX_ATTACHMENT_BYTES-stored.filter(f=>dates.get(f.entryId)===current.date).reduce((n,f)=>n+(f.blob?.size||f.size||0),0)-pendingBytes;
      remainingTotal=USER_ATTACHMENT_BYTES-stored.reduce((n,f)=>n+(f.blob?.size||f.size||0),0)-pendingBytes;
    }
    const failures=[],uploadStatus=$('uploadStatus');
    uploadStatus.textContent=fileList.length+'개 파일 확인 중…';
    for(const selected of [...fileList]){
      if(current?.id!==entryId){toast('기록이 변경되어 첨부를 중단했어요.');break;}
      if(selected.type.startsWith('video/')||/\.(mp4|mov|m4v|mkv|avi|3gp)$/i.test(selected.name)&&!selected.type.startsWith('audio/')||/\.webm$/i.test(selected.name)&&!selected.type.startsWith('audio/')){
        failures.push(selected.name+': 영상 업로드 미지원');toast('영상은 업로드할 수 없어요. 사진·GIF·음성·PDF를 선택해 주세요.');continue;
      }
      if(!/^(image\/|audio\/|application\/pdf$)/.test(selected.type)&&
        !/\.(jpe?g|png|gif|webp|heic|heif|avif|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|flac|aac|pdf)$/i.test(selected.name)){
        failures.push(selected.name+': 지원하지 않는 파일 형식');
        toast(selected.name+': 지원하지 않는 파일 형식이에요.');continue;
      }
      const ext=selected.name.split('.').pop().toLowerCase();
      const types={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',heic:'image/heic',heif:'image/heif',avif:'image/avif',mp4:'video/mp4',mov:'video/quicktime',m4v:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',ogg:'audio/ogg',flac:'audio/flac',aac:'audio/aac',pdf:'application/pdf'};
      let file=selected,type=selected.type||types[ext]||'application/octet-stream';
      const isPhoto=type.startsWith('image/');
      if(isPhoto&&diaryPhotoCount>=MAX_DIARY_PHOTOS){failures.push('사진 최대 10장 초과');toast('스티커와 사진·GIF는 합쳐서 일기 하나에 최대 10장이에요.');continue;}
      if(isPhoto){
        uploadStatus.textContent='사진 압축 중: '+selected.name;
        try{file=await compressPhoto(selected.type?selected:new File([selected],selected.name,{type}));type=file.type;}
        catch(error){failures.push(selected.name+': '+error.message);toast(selected.name+': '+error.message);continue;}
      }
      const maxBytes=fileLimit(type,file.name);
      if(file.size>maxBytes){failures.push(file.name+': 용량 초과');toast(file.name+': 최대 '+Math.round(maxBytes/1_000_000)+'MB예요.');continue;}
      if(usedBytes+file.size>MAX_ATTACHMENT_BYTES){failures.push('하루 10MB 용량 초과');toast('같은 날짜에 저장한 첨부파일은 모두 합쳐 최대 10MB예요.');continue;}
      if(file.size>remainingDay){failures.push(file.name+': 하루 10MB 한도 초과');toast('같은 날짜의 다른 기록과 썸네일까지 합쳐 하루 10MB예요.');continue;}
      if(file.size>remainingTotal){failures.push(file.name+': 개인 250MB 한도 초과');toast('개인 첨부파일 한도 250MB에 도달했어요.');continue;}
      if(current?.id!==entryId){toast('기록이 변경되어 첨부를 중단했어요.');break;}
      const record={id:makeId(),entryId,name:file.name,type,size:file.size,blob:file,createdAt:new Date().toISOString()};
      attachments.push(record);
      if(isPhoto){
        diaryPhotoCount++;
        current.photoLayout={...(current.photoLayout||{}),
          [record.id]:{mode:photoMode==='sticker'?'sticker':'photo',
            width:36,x:8+((diaryPhotoCount-1)%3)*14,y:8+Math.floor((diaryPhotoCount-1)/3)*24}};
      }
      usedBytes+=file.size;remainingDay-=file.size;remainingTotal-=file.size;added++;
    }
    if(current?.id===entryId){
      renderAttachments();
      if(added)queueSave();
    }
    uploadStatus.textContent=added
      ?added+'개 추가됨 · 일기 저장을 누르면 확정돼요.'+(failures.length?' ('+failures[0]+')':'')
      :failures.length? '파일 추가 실패: '+failures[0] : '파일을 추가하지 못했어요. 다른 사진을 선택해 주세요.';
    if(added)toast(`${added}개 파일을 임시 보관했어요. 일기 저장을 눌러 확정하세요.`);
  }
  async function toggleRecording(){
    if(recorder && recorder.state==='recording'){recorder.stop();return;}
    if(!navigator.mediaDevices?.getUserMedia || !globalThis.MediaRecorder){toast('이 브라우저에서는 녹음 기능을 사용할 수 없어요.');return;}
    try{
      recordStream=await navigator.mediaDevices.getUserMedia({audio:true});
      const mime=['audio/webm;codecs=opus','audio/mp4','audio/webm'].find(t=>MediaRecorder.isTypeSupported(t)) || '';
      recorder=new MediaRecorder(recordStream,mime ? {mimeType:mime} : undefined);
      recordChunks=[];recordingEntryId=current?.id;
      recorder.ondataavailable=(event)=>{if(event.data.size)recordChunks.push(event.data);};
      recorder.onstop=async()=>{
        const ext=recorder.mimeType.includes('mp4')?'m4a':'webm';
        const blob=new Blob(recordChunks,{type:recorder.mimeType||'audio/webm'});
        recordStream?.getTracks().forEach(t=>t.stop());recordStream=null;recorder=null;
        el.record.classList.remove('recording');el.recordText.textContent='음성 녹음';
        if(blob.size)try{await addFiles([new File([blob],`음성기록_${dayString()}_${Date.now()}.${ext}`,{type:blob.type})],recordingEntryId);}
        catch(error){toast('녹음 파일 추가 실패: '+error.message);}
      };
      recorder.start();el.record.classList.add('recording');el.recordText.textContent='녹음 종료';toast('녹음을 시작했어요. 다시 누르면 저장돼요.');
    }catch(e){recordStream?.getTracks().forEach(t=>t.stop());toast('마이크 권한이 필요해요. HTTPS 사이트에서 사용해 주세요.');}
  }
  function downloadBlob(blob,filename){const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=safeFileName(filename.replace(/\.[^.]*$/,''))+(filename.match(/\.[^.]*$/)?.[0]||'');document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}
  function currentExportName(){return safeFileName(el.exportFilename.value || current?.title || `${current?.date}_기록`).slice(0,MAX_EXPORT_NAME_CHARS);}
  function mdOfEntry(entry,attached){
    let md=`# ${entry.title.trim()||'제목 없는 기록'}\n\n${dateText(entry.date)}\n\n${entry.body.trim()}\n`;
    if(attached.length)md+=`\n---\n\n## 첨부 파일\n\n${attached.map(x=>`- ${x.name.replace(/\n/g,' ')}`).join('\n')}\n`;
    return md;
  }
  const encode=s=>new TextEncoder().encode(s);
  const crcTable=(()=>{const a=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=(c&1)?0xEDB88320^(c>>>1):c>>>1;a[n]=c>>>0;}return a;})();
  function crc32(bytes){let c=0xFFFFFFFF;for(const b of bytes)c=crcTable[(c^b)&255]^(c>>>8);return(c^0xFFFFFFFF)>>>0;}
  function makeZip(items){
    const parts=[],central=[];let offset=0;const now=new Date();
    const dosTime=(now.getHours()<<11)|(now.getMinutes()<<5)|Math.floor(now.getSeconds()/2);
    const dosDate=((Math.max(now.getFullYear(),1980)-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate();
    const put16=(view,at,n)=>view.setUint16(at,n,true),put32=(view,at,n)=>view.setUint32(at,n>>>0,true);
    for(const item of items){const name=encode(item.name),data=item.data,crc=crc32(data);
      const h=new Uint8Array(30+name.length),v=new DataView(h.buffer);put32(v,0,0x04034b50);put16(v,4,20);put16(v,6,0x0800);put16(v,8,0);put16(v,10,dosTime);put16(v,12,dosDate);put32(v,14,crc);put32(v,18,data.length);put32(v,22,data.length);put16(v,26,name.length);h.set(name,30);
      parts.push(h,data);const c=new Uint8Array(46+name.length),w=new DataView(c.buffer);put32(w,0,0x02014b50);put16(w,4,20);put16(w,6,20);put16(w,8,0x0800);put16(w,10,0);put16(w,12,dosTime);put16(w,14,dosDate);put32(w,16,crc);put32(w,20,data.length);put32(w,24,data.length);put16(w,28,name.length);put32(w,42,offset);c.set(name,46);central.push(c);offset+=h.length+data.length;
    }
    const centralOffset=offset;for(const c of central){parts.push(c);offset+=c.length;}
    const e=new Uint8Array(22),v=new DataView(e.buffer);put32(v,0,0x06054b50);put16(v,8,items.length);put16(v,10,items.length);put32(v,12,offset-centralOffset);put32(v,16,centralOffset);parts.push(e);return new Blob(parts,{type:'application/zip'});
  }
  function readZip(bytes){
    const v=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),files=new Map();let end=-1;
    for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){if(v.getUint32(i,true)===0x06054b50){end=i;break;}}
    if(end<0)throw Error('올바른 ZIP 파일이 아니에요.');
    const count=v.getUint16(end+10,true);let cursor=v.getUint32(end+16,true);
    if(count>10000)throw Error('파일이 너무 많아요.');
    for(let i=0;i<count;i++){
      if(cursor+46>bytes.length||v.getUint32(cursor,true)!==0x02014b50)throw Error('ZIP 파일이 손상되었어요.');
      const method=v.getUint16(cursor+10,true),crc=v.getUint32(cursor+16,true),size=v.getUint32(cursor+20,true),nameLen=v.getUint16(cursor+28,true),extra=v.getUint16(cursor+30,true),comment=v.getUint16(cursor+32,true),start=v.getUint32(cursor+42,true);
      const name=new TextDecoder().decode(bytes.slice(cursor+46,cursor+46+nameLen));cursor+=46+nameLen+extra+comment;
      if(method!==0)throw Error('일상 기록에서 만든 압축되지 않은 ZIP 백업만 불러올 수 있어요.');
      if(start+30>bytes.length||v.getUint32(start,true)!==0x04034b50)throw Error('ZIP 항목이 손상되었어요.');
      const nameSize=v.getUint16(start+26,true),extraSize=v.getUint16(start+28,true),begin=start+30+nameSize+extraSize;
      if(begin+size>bytes.length)throw Error('ZIP 파일의 길이가 올바르지 않아요.');
      const data=bytes.slice(begin,begin+size);if(crc32(data)!==crc)throw Error(`파일 무결성 확인 실패: ${name}`);files.set(name,data);
    }return files;
  }
  async function buildBackup(selectedEntries,filename,download=true){
    if(!selectedEntries.length)throw Error('백업할 기록이 없어요.');
    const selectedIds=new Set(selectedEntries.map(e=>e.id));const allAttachments=cloudMode?await cloud().getBackupAttachments([...selectedIds]):await getAll('attachments');
    const chosen=allAttachments.filter(a=>selectedIds.has(a.entryId));
    const manifest={app:'harugyeol',version:1,exportedAt:new Date().toISOString(),entries:selectedEntries,attachments:chosen.map(({blob,...info})=>({...info,path:`files/${info.id}`}))};
    const items=[{name:'manifest.json',data:encode(JSON.stringify(manifest,null,2))}];
    for(const entry of selectedEntries) {
      const entryFiles=chosen.filter(a=>a.entryId===entry.id);
      items.push({name:`notes/${safeFileName(entry.date+'_'+(entry.title||'제목 없는 기록'))}_${entry.id.slice(0,8)}.md`,data:encode('\uFEFF'+mdOfEntry(entry,entryFiles))});
    }
    for(const file of chosen)items.push({name:`files/${file.id}`,data:new Uint8Array(await file.blob.arrayBuffer())});
    const result=makeZip(items);
    const inspected=readZip(new Uint8Array(await result.arrayBuffer()));
    const check=JSON.parse(new TextDecoder().decode(inspected.get('manifest.json')));
    if(check.entries.length!==selectedEntries.length||check.attachments.length!==chosen.length)throw Error('백업 검증 실패');
    for(const file of chosen){const bytes=inspected.get('files/'+file.id);if(!bytes||bytes.length!==file.blob.size)throw Error('파일 검증 실패: '+file.name);}
    if(download)downloadBlob(result,`${filename}.zip`);
    return {ids:selectedEntries.map(e=>e.id),files:chosen.length,blob:result,filename:`${filename}.zip`};

  }
  function deletionSelection(){
    const {start,end}=dateRange($('deletePeriod').value,'deleteStartDate','deleteEndDate');
    const label=$('deletePeriod').value==='all'?'전체 기록':start+' ~ '+end;
    return {start,end,label,items:entries.filter(e=>e.date>=start&&e.date<=end),verification:$('deletePeriod').value==='all'?'전체삭제':'삭제합니다'};
  }
  function updateDeletePeriod(){
    $('deleteCustomRange').hidden=$('deletePeriod').value!=='custom';
    try{const selection=deletionSelection();$('deleteRangeSummary').textContent=selection.label+' · 일기 '+selection.items.length+'개';}
    catch(e){$('deleteRangeSummary').textContent=e.message;}
  }
  async function monthlyBackup(){
    try{
      if($('backupPeriod').value==='all')return await prepareBackup([...entries],`일상기록_전체백업_${dayString()}`,'모든 기록');
      const {start,end}=backupRange();
      const items=entries.filter(e=>e.date>=start&&e.date<=end);
      const period=start===end?start:start+'_'+end;
      await prepareBackup(items,'일상기록_'+period+'_백업',start===end?start:start+' ~ '+end);
    }catch(e){$('archiveStatus').textContent='백업 실패: '+e.message;toast('백업 실패: '+e.message);}
  }
  function monthOffset(value,offset){
    const [year,month]=value.split('-').map(Number),date=new Date(year,month-1+offset,1);
    return date.getFullYear()+'-'+String(date.getMonth()+1).padStart(2,'0');
  }
  function backupRange(){
    return dateRange($('backupPeriod').value,'backupStartDate','backupEndDate');
  }
  function openBackupOptions(mode=$('backupPeriod').value){
    $('backupPeriod').value=mode;
    $('archiveStatus').textContent='백업해도 기존 기록은 그대로 남아요.';
    updateBackupPeriod();
    if(!$('backupOptionsDialog').open)$('backupOptionsDialog').showModal();
  }
  function dateRange(mode,startId,endId){
    if(mode==='all')return {start:'0001-01-01',end:'9999-12-31'};
    const month=mode==='previous'?monthOffset(dayString().slice(0,7),-1):dayString().slice(0,7);
    const [year,m]=month.split('-').map(Number);
    const start=mode==='custom'?$(startId).value:month+'-01';
    const end=mode==='custom'?$(endId).value:dayString(new Date(year,m,0));
    const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&dayString(new Date(value+'T00:00:00'))===value;
    if(!valid(start)||!valid(end)||start>end)throw Error('시작일과 종료일을 올바른 순서로 선택해 주세요.');
    return {start,end};
  }
  function updateBackupPeriod(){
    const mode=$('backupPeriod').value;
    $('backupCustomRange').hidden=mode!=='custom';
    $('archiveMonthBtn').textContent=mode==='all'?'전체 백업':mode==='1'?'이번 달 백업':mode==='previous'?'지난달 백업':'선택한 기간 백업';
    try{
      const {start,end}=backupRange();
      const count=entries.filter(e=>e.date>=start&&e.date<=end).length;
      $('backupPeriodSummary').textContent=(mode==='all'?'모든 기간':start===end?start:start+' ~ '+end)+' · 저장된 일기 '+count+'개';
    }catch(e){$('backupPeriodSummary').textContent=e.message;}
  }
  async function prepareBackup(items,filename,period){
    if(backupPreparing)return;
    backupPreparing=true;
    $('archiveMonthBtn').disabled=true;$('backupBtn').disabled=true;
    try{
      if(isDraft&&(el.title.value.trim()||el.body.value.trim()||attachments.length))toast('저장하지 않은 새 기록은 백업에 포함되지 않아요.');
      await flushSave();
      $('archiveStatus').textContent='백업 파일을 만들고 확인하고 있어요…';
      const result=await buildBackup(items,filename,false);
      pendingBackup={...result,file:new File([result.blob],result.filename,{type:'application/zip'})};
      $('backupDestinationSummary').textContent=period+' · 일기 '+items.length+'개 · 첨부파일 '+result.files+'개 · '+formatAttachmentUsage(result.blob.size);
      const shareable=!!navigator.share&&!!navigator.canShare?.({files:[pendingBackup.file]});
      pendingBackup.shareable=shareable;
      $('backupShareExternal').disabled=false;
      $('backupManualShareHelp').hidden=shareable;
      $('backupShareHelp').textContent=shareable?'공유창에 표시되는 앱으로 보낼 수 있어요. 카카오톡·드라이브 지원 여부는 기기에 따라 달라요.':'이 브라우저는 ZIP 파일 공유를 지원하지 않아요. 내 기기에 저장한 뒤 원하는 앱에서 파일을 보내세요.';
      $('backupDestinationStatus').textContent='백업해도 기존 기록은 삭제되지 않아요.';
      $('archiveStatus').textContent='백업 준비 완료. 저장 또는 외부 공유를 선택하세요.';
      $('backupOptionsDialog').close();
      $('backupDestinationDialog').showModal();
    }finally{
      backupPreparing=false;$('archiveMonthBtn').disabled=false;$('backupBtn').disabled=false;
    }
  }
  async function shareBackup(){
    if(!pendingBackup)return;
    if(!pendingBackup.shareable){
      $('backupDestinationStatus').textContent='이 브라우저는 백업 ZIP 파일을 공유창으로 보낼 수 없어요. 아래 안내대로 기기에 저장한 뒤 카카오톡·드라이브에서 파일을 첨부해 주세요.';
      $('backupManualShareHelp').hidden=false;
      $('backupSaveLocal').focus();
      return;
    }
    $('backupShareExternal').disabled=true;
    try{
      await navigator.share({files:[pendingBackup.file]});
      $('backupDestinationStatus').textContent='공유 앱으로 파일을 전달했어요. 해당 앱에서 전송·저장 완료 여부를 확인해 주세요.';
    }catch(e){
      const reason=e.name==='NotAllowedError'?'브라우저에서 파일 공유가 허용되지 않았어요.':e.name==='DataError'?'선택한 앱으로 ZIP 파일을 전달하지 못했어요.':'이 환경에서 ZIP 파일 공유를 시작하지 못했어요.';
      $('backupDestinationStatus').textContent=e.name==='AbortError'?'공유를 취소했어요. 다시 공유하거나 내 기기에 저장할 수 있어요.':reason+' 내 기기에 저장한 뒤 파일을 첨부해 주세요.';
      if(e.name!=='AbortError')$('backupManualShareHelp').hidden=false;
    }finally{if(pendingBackup)$('backupShareExternal').disabled=false;}
  }
  async function monthlyDelete(){
    try{
      await flushSave();
      const selection=deletionSelection(),{items,label,verification}=selection;
      if(!items.length){toast('선택한 범위에 저장된 기록이 없어요.');return;}
      pendingMonthDeletion={...selection,ids:items.map(e=>e.id)};
      $('monthDeleteDescription').textContent=label+'의 기록 '+items.length+'개와 관련 첨부파일이 영구 삭제됩니다.';
      $('monthDeleteVerification').value='';
      $('monthDeleteVerification').placeholder=verification;
      $('monthDeleteDialog').querySelector('label').textContent='확인 문구: '+verification;
      $('monthDeleteConfirm').disabled=true;
      $('backupDeleteDialog').close();
      $('monthDeleteDialog').showModal();
    }catch(e){toast('삭제 안내를 열지 못했어요: '+e.message);}
  }
  async function confirmMonthlyDelete(){
    const target=pendingMonthDeletion;
    if(!target||$('monthDeleteVerification').value.trim()!==target.verification)return;
    const items=entries.filter(e=>e.date>=target.start&&e.date<=target.end);
    if(items.length!==target.ids.length||items.some(e=>!target.ids.includes(e.id))){
      $('archiveStatus').textContent='기록 목록이 변경되었어요. 삭제를 다시 확인해 주세요.';
      $('monthDeleteDialog').close();return;
    }
    const button=$('monthDeleteConfirm');button.disabled=true;
    let deleted=0;
    try{
      for(const entry of items){
        try{
          await deleteEntryData(entry.id);
          await clearPending(entry.id);
          entries=entries.filter(e=>e.id!==entry.id);
          deleted++;
        }catch(e){console.error('월별 기록 삭제 실패',e);}
      }
      if(current&&!isDraft&&!entries.some(e=>e.id===current.id)){
        current=null;attachments=[];isDraft=false;savedState=null;savedFileIds=new Set();
        const next=[...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
        if(next)await selectEntry(next.id);else await newEntry(dayString(),false,false);
      }
      renderList();
      $('archiveStatus').textContent=deleted===items.length
        ?target.label+' 기록 '+deleted+'개 삭제 완료'
        :target.label+' 기록 '+deleted+'개 삭제 · '+(items.length-deleted)+'개 실패. 기록 목록을 확인해 주세요.';
      toast(deleted===items.length?'선택한 기록을 삭제했어요.':'일부 기록 삭제에 실패했어요.');
    }finally{
      $('monthDeleteDialog').close();
      pendingMonthDeletion=null;button.disabled=false;
    }
  }
  async function restoreBackup(file){
    if(!db)return toast('저장소를 사용할 수 없어요.');
    if(!confirm('백업 파일의 기록을 현재 기록과 병합합니다. 동일한 기록 ID는 백업 내용으로 덮어씁니다. 계속할까요?'))return;
    try{
      await flushSave();setSave('saving','백업 복원 중…');
      const zip=readZip(new Uint8Array(await file.arrayBuffer()));const raw=zip.get('manifest.json');if(!raw)throw Error('일상 기록 백업 정보가 없어요.');
      const data=JSON.parse(new TextDecoder().decode(raw));
      if(data.app!=='harugyeol'||data.version!==1||!Array.isArray(data.entries)||!Array.isArray(data.attachments))throw Error('지원하지 않는 백업 파일이에요.');
      if(data.entries.some(x=>!x.id||!x.date||typeof x.body!=='string'||typeof x.title!=='string'))throw Error('기록 정보가 잘못되었어요.');
      if(!data.entries.length)throw Error('백업 파일에 일기가 없어요.');
      const restoredFiles=[];
      for(const a of data.attachments){
        if(typeof a.type!=='string'||a.type.startsWith('video/'))throw Error('영상이 포함된 백업은 현재 복원할 수 없어요. 원본 ZIP을 보관하고 사진·GIF·음성·PDF 백업을 선택해 주세요.');
        const bytes=zip.get(a.path);if(!bytes)throw Error(`${a.name}: 미디어 파일을 찾지 못했어요.`);
        let file=new File([bytes],a.name,{type:a.type});
        if(a.type.startsWith('image/'))file=await compressPhoto(file);
        if(file.size>fileLimit(file.type,file.name))throw Error(a.name+': 파일 용량 한도를 넘어요.');
        const {path,...meta}=a;restoredFiles.push({...meta,type:file.type,name:file.name,size:file.size,blob:file});
      }
      // Preflight the entire restore before writing any diary rows or attachments.
      const plannedEntries=new Map([...entries,...data.entries].map(e=>[e.id,e]));
      const previousFiles=cloudMode?await cloud().attachmentMetadata():await getAll('attachments');
      const plannedFiles=new Map([...previousFiles,...restoredFiles].map(f=>[f.id,f]));
      const restoredIds=new Set(restoredFiles.map(f=>f.id));let total=0;const dayBytes=new Map(),affectedDays=new Set();
      for(const f of plannedFiles.values()){
        const day=plannedEntries.get(f.entryId)?.date;if(!day)throw Error('첨부파일이 연결된 일기를 찾지 못했어요.');
        const size=f.blob?.size||f.size||0;total+=size;dayBytes.set(day,(dayBytes.get(day)||0)+size);
        if(restoredIds.has(f.id))affectedDays.add(day);
      }
      for(const e of data.entries)if(entries.find(x=>x.id===e.id)?.date!==e.date)affectedDays.add(e.date);
      if(total>USER_ATTACHMENT_BYTES)throw Error('복원하면 개인 첨부파일 한도 250MB를 넘어요.');
      for(const day of affectedDays)if(dayBytes.get(day)>MAX_ATTACHMENT_BYTES)throw Error(day+': 복원하면 하루 첨부파일 한도 10MB를 넘어요.');
      await writeRecords('entries',data.entries);
      for(const file of restoredFiles)await writeRecords('attachments',[file]);
      entries=await getAll('entries');const last=[...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];current=null;isDraft=false;await selectEntry(last.id);
      setSave('','저장됨');toast(`${data.entries.length}개 기록의 백업을 불러왔어요.`);
    }catch(e){console.error(e);setSave('error','복원 실패');toast(`복원 실패: ${e.message}`);}
  }
  function stripMd(s){return s.replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/<\/?u>/g,'').replace(/\*\*|__|~~|[`*_]/g,'');}
  async function canvasPages(entry,attached) {
    await document.fonts?.ready;
    const W=1240,H=1754,L=125,R=1115,BOTTOM=1558;
    const colors={paper:'#fcf6e8',ink:'#554032',muted:'#937b63',
      trim:'#ddc8aa',sage:'#a0a48b',highlight:'#ead3aa',photo:'#fff9ed'};
    const pages=[];let ctx,y;
    const handwriting='"OngleipRyuryu", "Nanum Myeongjo", Pretendard, sans-serif';
    const sans='Pretendard, "Noto Sans KR", sans-serif';
    function font(size,bold=false,family=handwriting){
      ctx.font=(bold?'700 ':'400 ')+size+'px '+family;
      ctx.textBaseline='alphabetic';ctx.textAlign='left';
    }
    function stroke(x1,y1,x2,y2,color=colors.trim,width=2){
      ctx.beginPath();ctx.strokeStyle=color;ctx.lineWidth=width;
      ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
    }
    function flower(x,y,scale=1){
      ctx.save();ctx.translate(x,y);ctx.scale(scale,scale);
      for(let i=0;i<5;i++){
        const angle=(i*Math.PI*2)/5-Math.PI/2;
        ctx.fillStyle=i%2?'#e4c6ac':'#dbc1a6';
        ctx.beginPath();ctx.ellipse(Math.cos(angle)*18,Math.sin(angle)*18,12,18,angle,0,2*Math.PI);ctx.fill();
      }
      ctx.fillStyle='#c6a06f';ctx.beginPath();ctx.arc(0,0,8,0,2*Math.PI);ctx.fill();
      ctx.restore();
    }
    function page(){
      const canvas=document.createElement('canvas');
      canvas.width=W;canvas.height=H;ctx=canvas.getContext('2d');
      pages.push(canvas);y=183;
      ctx.fillStyle=colors.paper;ctx.fillRect(0,0,W,H);
      ctx.strokeStyle='#e5d5bd';ctx.lineWidth=3;ctx.strokeRect(64,67,W-128,H-134);
      stroke(99,112,99,H-112,'#e5ceb0',2);
      for(let k=0;k<12;k++){
        const dotY=192+k*121;
        ctx.fillStyle='#e2cdb1';ctx.beginPath();ctx.arc(85,dotY,5,0,2*Math.PI);ctx.fill();
      }
      font(23,true,sans);ctx.fillStyle=colors.muted;
      ctx.fillText('DAILY RECORD  /  일상 기록',L,137);
      stroke(L,152,R,152);
      flower(1085,106,.67);flower(1122,113,.28);
      flower(100,1600,.43);
      return canvas;
    }
    function ensure(height){if(y+height>BOTTOM)page();}
    function writeLine(value,options={}){
      const size=options.size||34,leading=options.leading||54,bold=!!options.bold;
      ensure(leading);
      font(size,bold,options.family||handwriting);
      ctx.fillStyle=options.color||colors.ink;
      ctx.fillText(value||' ',L+(options.indent||0),y+leading*.74);
      y+=leading;
    }
    function text(value,options={}){
      const size=options.size||34,leading=options.leading||54;
      const indent=options.indent||0,maxWidth=R-L-indent;
      const raw=String(value||'');
      const segments=raw.split('\n');
      for(const paragraph of segments){
        if(!paragraph){writeLine(' ',{...options,size,leading});continue;}
        let line='';
        for(const character of paragraph){
          font(size,!!options.bold,options.family||handwriting);
          if(line&&ctx.measureText(line+character).width>maxWidth){
            writeLine(line,{...options,size,leading,indent});line=character;
          }else line+=character;
        }
        if(line)writeLine(line,{...options,size,leading,indent});
      }
    }
    function rule(){
      ensure(24);stroke(L,y+8,R,y+8,'#dfc9a9',2);y+=28;
    }
    function section(label){
      y+=29;ensure(90);
      flower(L+17,y+20,.34);
      font(32,true,handwriting);ctx.fillStyle='#725139';
      ctx.fillText(label,L+53,y+31);y+=66;
    }
    function cardImage(image,x,top,width=450){
      const innerW=width-25,innerH=310;
      ctx.save();ctx.shadowColor='rgba(72,46,27,.18)';
      ctx.shadowBlur=13;ctx.shadowOffsetY=8;
      ctx.fillStyle=colors.photo;ctx.fillRect(x,top,width,394);
      ctx.restore();
      ctx.fillStyle='#ebdfca';ctx.fillRect(x+12,top+12,innerW,innerH);
      if(image){
        const ratio=Math.max(innerW/image.naturalWidth,innerH/image.naturalHeight);
        const sw=innerW/ratio,sh=innerH/ratio;
        const sx=(image.naturalWidth-sw)/2,sy=(image.naturalHeight-sh)/2;
        ctx.save();ctx.beginPath();ctx.rect(x+12,top+12,innerW,innerH);ctx.clip();
        ctx.drawImage(image,sx,sy,sw,sh,x+12,top+12,innerW,innerH);
        ctx.restore();
      }else{
        font(23,false,sans);ctx.fillStyle=colors.muted;
        ctx.fillText('사진을 표시할 수 없어요',x+27,top+160);
      }
      ctx.fillStyle='rgba(185,158,119,.52)';
      ctx.fillRect(x+width/2-35,top-10,70,23);
    }
    function caption(filename,x,top,maxWidth=400){
      font(22,false,sans);ctx.fillStyle='#886b54';
      let label=String(filename||'사진');
      while(label.length>1&&ctx.measureText(label).width>maxWidth)label=label.slice(0,-2)+'…';
      ctx.fillText(label,x,top);
    }
    async function loadImage(file){
      const src=URL.createObjectURL(file.blob);
      try{
        return await new Promise((resolve,reject)=>{
          const img=new Image();img.onload=()=>resolve(img);
          img.onerror=()=>reject(Error('이미지를 표시할 수 없어요'));img.src=src;
        });
      }catch(e){console.warn('내보내기 사진 미리보기:',e);return null;}
      finally{URL.revokeObjectURL(src);}
    }
    page();
    const bodyFontFactor=(diaryBodyFontSize(entry)||18)/18;
    const bodyPx=n=>Math.round(n*bodyFontFactor);
    const dt=new Date(entry.date+'T12:00:00');
    const week=WEEK_KR[dt.getDay()]+'요일';
    const dated=entry.date.replace(/-/g,'.')+'  ·  '+week;
    font(25,true,sans);ctx.fillStyle=colors.muted;
    ctx.fillText(dated,L,y+24);y+=71;
    text(entry.title.trim()||'제목 없는 기록',{size:65,leading:83,bold:true,color:'#493425'});
    y+=10;
    const weatherLabels={sunny:'맑음',partly_cloudy:'구름 조금',cloudy:'흐림',
      rain:'비',snow:'눈',wind:'바람',other:'기타'};
    if(entry.weather){
      ensure(49);
      ctx.fillStyle='#f3e8d7';ctx.fillRect(L,y,200,42);
      font(24,true,sans);ctx.fillStyle='#7e674e';
      ctx.fillText('날씨  ·  '+(weatherLabels[entry.weather]||'기록'),L+12,y+29);y+=65;
    }
    if(entry.shortNote?.trim()){
      const note=entry.shortNote.trim();
      ensure(76);
      font(34,false,handwriting);
      const noteWidth=Math.min(R-L,ctx.measureText(note).width+36);
      ctx.fillStyle=colors.highlight;ctx.fillRect(L,y+28,noteWidth,23);
      ctx.fillStyle='#5d4634';ctx.fillText(note,L+15,y+45);y+=81;
    }
    y+=6;rule();y+=22;
    const bodyStartPage=pages.length-1,bodyStartY=y;
    if(entry.body?.trim()){
      const blocks=parseBlocks(entry.body);
      for(const block of blocks){
        if(block.kind==='heading'){
          y+=block.level===1?15:6;
          text(stripMd(block.text),{size:bodyPx(block.level===1?46:block.level===2?40:36),
            leading:bodyPx(block.level===1?65:57),bold:true,color:'#64452f'});y+=19;
        }else if(block.kind==='paragraph'){
          text(stripMd(block.text),{size:bodyPx(34),leading:bodyPx(55)});y+=21;
        }else if(block.kind==='quote'){
          ensure(18);ctx.fillStyle='#bba78c';ctx.fillRect(L,y,5,29);
          text(stripMd(block.text),{size:bodyPx(32),leading:bodyPx(50),indent:26,color:'#816954'});y+=19;
        }else if(block.kind==='rule'){
          y+=14;rule();y+=14;
        }else if(block.kind==='code'){
          for(const line of block.text.split('\n'))text(line,{size:bodyPx(24),leading:bodyPx(42),family:sans});
          y+=20;
        }else if(block.kind==='list'){
          for(let i=0;i<block.items.length;i++){
            const item=block.items[i];
            const marker=block.ordered?String(i+1)+'.':item.check===null?'•':item.check?'☑':'☐';
            text(marker+'  '+stripMd(item.text),{size:bodyPx(33),leading:bodyPx(53),indent:12});
          }
          y+=20;
        }
      }
    }
    // Canvas PDF/PNG exports are independent of the DOM editor, so render stickers here.
    // Anchor percentages to the body region and draw only the photo (never editing controls).
    const stickerFiles=attached.filter(file=>file.type.startsWith('image/')&&
      file.id!==entry.coverAttachmentId&&!/^달력_썸네일_|^일기_미리보기_/.test(file.name||'')&&
      entry.photoLayout?.[file.id]?.mode==='sticker');
    const bodyFlowHeight=(pages.length-1-bodyStartPage)*(BOTTOM-183)+(y-bodyStartY);
    const stickerAreaHeight=Math.max(500,Math.min(bodyFlowHeight,1000));
    for(const file of stickerFiles){
      const img=await loadImage(file);
      if(!img||!img.naturalWidth||!img.naturalHeight)continue;
      const layout=entry.photoLayout[file.id];
      const widthPercent=clamp(Number(layout.width)||36,18,76);
      const slotW=(R-L)*widthPercent/100;
      const scale=Math.min(slotW/img.naturalWidth,430/img.naturalHeight);
      const drawW=img.naturalWidth*scale,drawH=img.naturalHeight*scale;
      const x=L+clamp(Number(layout.x)||0,0,100-widthPercent)/100*(R-L)+(slotW-drawW)/2;
      let top=bodyStartY+clamp(Number(layout.y)||0,0,85)/100*stickerAreaHeight;
      let pageIndex=bodyStartPage;
      while(top+drawH>BOTTOM&&pageIndex<pages.length-1){
        top=183+Math.max(0,top-BOTTOM);pageIndex++;
      }
      top=clamp(top,183,BOTTOM-drawH);
      const pen=pages[pageIndex].getContext('2d');
      pen.save();
      pen.translate(x+drawW/2,top+drawH/2);
      pen.rotate(clamp(Number(layout.rotation)||0,-720,720)*Math.PI/180);
      pen.drawImage(img,-drawW/2,-drawH/2,drawW,drawH);
      pen.restore();
    }
    const visible=attached.filter(file=>file.id!==entry.coverAttachmentId&&
      !/^달력_썸네일_|^일기_미리보기_/.test(file.name||''));
    const photos=visible.filter(file=>file.type.startsWith('image/')&&entry.photoLayout?.[file.id]?.mode!=='sticker');
    const other=visible.filter(file=>!file.type.startsWith('image/'));
    const crops=new Map(attached.filter(file=>/^일기_미리보기_/.test(file.name||''))
      .map(file=>[file.name,file]));
    if(photos.length){
      section('PHOTO MEMORIES   /   사진 기록');
      const firstX=L+12,secondX=L+508;
      for(let i=0;i<photos.length;i+=2){
        ensure(460);
        const rowTop=y+11;
        for(let j=i;j<Math.min(i+2,photos.length);j++){
          const photo=photos[j],x=j===i?firstX:secondX;
          const preview=crops.get('일기_미리보기_'+photo.id+'.jpg')||photo;
          const img=await loadImage(preview);
          cardImage(img,x,rowTop);
          caption(photo.name,x+16,rowTop+365);
        }
        y+=457;
      }
    }
    if(other.length){
      section('KEPT MOMENTS   /   함께 보관한 파일');
      for(const file of other){
        text('•  '+String(file.name||'첨부 파일'),{size:25,leading:44,family:sans,color:'#806851'});
      }
      y+=18;
      text('음성·영상·PDF 원본은 ZIP 내보내기에서 확인할 수 있어요.',{
        size:21,leading:39,family:sans,color:colors.muted});
    }
    for(let index=0;index<pages.length;index++){
      const pen=pages[index].getContext('2d');
      pen.strokeStyle=colors.trim;pen.lineWidth=2;pen.beginPath();
      pen.moveTo(L,1633);pen.lineTo(R,1633);pen.stroke();
      pen.fillStyle=colors.muted;
      pen.font='22px '+sans;
      pen.textAlign='left';pen.fillText('일상 기록  ·  소중한 하루를 남기다',L,1681);
      pen.textAlign='right';pen.fillText((index+1)+' / '+pages.length,R,1681);
    }
    return pages;
  }
  async function makePdf(pages){
    const parts=[],offsets=[0];let total=0;
    const append=(u)=>{parts.push(u);total+=u.byteLength;};
    const add=(s)=>append(encode(s));
    const obj=(id,content)=>{offsets[id]=total;add(`${id} 0 obj\n${content}\nendobj\n`);};
    add('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');
    const pageRefs=pages.map((_,i)=>`${3+i*3} 0 R`).join(' ');
    obj(1,'<< /Type /Catalog /Pages 2 0 R >>');obj(2,`<< /Type /Pages /Kids [${pageRefs}] /Count ${pages.length} >>`);
    for(let i=0;i<pages.length;i++){
      const pid=3+i*3,cid=pid+1,iid=pid+2;
      obj(pid,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Resources << /XObject << /Im0 ${iid} 0 R >> >> /Contents ${cid} 0 R >>`);
      const stream='q\n595.28 0 0 841.89 0 0 cm\n/Im0 Do\nQ\n';
      obj(cid,`<< /Length ${encode(stream).length} >>\nstream\n${stream}endstream`);
      const blob=await new Promise((res,rej)=>pages[i].toBlob(b=>b?res(b):rej(Error('PDF 이미지 생성 실패')),'image/jpeg',.87));
      const bytes=new Uint8Array(await blob.arrayBuffer());offsets[iid]=total;
      add(`${iid} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${pages[i].width} /Height ${pages[i].height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`);
      append(bytes);add('\nendstream\nendobj\n');
    }
    const xref=total;add(`xref\n0 ${offsets.length}\n0000000000 65535 f \n`);
    for(let i=1;i<offsets.length;i++)add(`${String(offsets[i]).padStart(10,'0')} 00000 n \n`);
    add(`trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
    return new Blob(parts,{type:'application/pdf'});
  }
  async function exportRecord(format){
    if(isExporting)return;
    isExporting=true;const name=currentExportName();el.exportProgress.textContent='파일을 준비하는 중…';
    try{
      await flushSave();const entry={...current},attached=[...attachments];
      if(format==='md')downloadBlob(new Blob(['\uFEFF',mdOfEntry(entry,attached)],{type:'text/markdown;charset=utf-8'}),`${name}.md`);
      else if(format==='zip')await buildBackup([entry],name);
      else if(format==='pdf'||format==='png'){
        const pages=await canvasPages(entry,attached);
        if(format==='pdf')downloadBlob(await makePdf(pages),`${name}.pdf`);
        else if(pages.length<=6){const combined=document.createElement('canvas');combined.width=pages[0].width;combined.height=pages.reduce((h,c)=>h+c.height,0);const ctx=combined.getContext('2d');let top=0;for(const p of pages){ctx.drawImage(p,0,top);top+=p.height;}
          const blob=await new Promise((res,rej)=>combined.toBlob(b=>b?res(b):rej(Error('PNG 생성 실패')),'image/png'));downloadBlob(blob,`${name}.png`);
        }else{
          const items=[];for(let i=0;i<pages.length;i++){const blob=await new Promise((res,rej)=>pages[i].toBlob(b=>b?res(b):rej(Error('PNG 생성 실패')),'image/png'));items.push({name:`${name}_${String(i+1).padStart(2,'0')}.png`,data:new Uint8Array(await blob.arrayBuffer())});}
          downloadBlob(makeZip(items),`${name}_이미지.zip`);toast('기록이 길어서 PNG를 페이지별 ZIP으로 저장했어요.');
        }
      }
      el.exportProgress.textContent='저장할 파일을 만들었어요.';
      toast(`${name} 파일을 내보냈어요.`);
    }catch(e){console.error(e);el.exportProgress.textContent=`오류: ${e.message}`;toast(`내보내기 실패: ${e.message}`);}
    finally{isExporting=false;}
  }
  async function importLocal(){
    if(!cloudMode)return;
    if(!confirm('현재 기기에 저장된 기존 기록과 첨부 파일을 로그인한 계정으로 가져올까요? 기존 로컬 파일은 지우지 않습니다.'))return;
    try{
      const local=await openDb();
      const read=(store,index,value)=>new Promise((resolve,reject)=>{
        const tx=local.transaction(store,'readonly');
        const req=index?tx.objectStore(store).index(index).getAll(value):tx.objectStore(store).getAll();
        req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error);
      });
      const notes=await read('entries'), media=await read('attachments');
      const known=new Set(entries.map(e=>e.id));
      let count=0;
      for(const entry of notes){
        if(known.has(entry.id))continue;
        await cloud().saveEntry(entry);
        const files=media.filter(f=>f.entryId===entry.id);
        if(files.length)await cloud().saveAttachments(files);
        count++;
      }
      local.close();current=null;attachments=[];
      entries=await cloud().entries();const last=[...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
      if(last)await selectEntry(last.id);else await newEntry();
      renderList();toast(`기존 기록 ${count}개를 가져왔어요.`);
    }catch(e){console.error(e);toast('가져오기 실패: '+e.message);}
  }
  function bindEvents(){
    $('diaryPrevious').addEventListener('click',()=>navigateDiary(-1));
    $('diaryNext').addEventListener('click',()=>navigateDiary(1));
    let swipe=null;
    // Allow horizontal page gestures even when they start on the diary body textarea.
    // Keep buttons, inputs and sticker editing surfaces protected from navigation.
    const ignoreSwipe=target=>target.closest('input,select,button,a,audio,video,[contenteditable],.entry-photo-sticker,.entry-sticker-board,.format-toolbar');
    $('editorPage').addEventListener('pointerdown',e=>{
      if(e.pointerType!=='touch'||!e.isPrimary||ignoreSwipe(e.target)){swipe=null;return;}
      swipe={x:e.clientX,y:e.clientY,time:performance.now(),id:current?.id,pointer:e.pointerId};
    },{passive:true});
    $('editorPage').addEventListener('pointercancel',()=>{swipe=null;},{passive:true});
    $('editorPage').addEventListener('pointerup',e=>{
      const start=swipe;swipe=null;
      if(!start||start.pointer!==e.pointerId||start.id!==current?.id||ignoreSwipe(e.target))return;
      const dx=e.clientX-start.x,dy=e.clientY-start.y;
      if(performance.now()-start.time<1100&&Math.abs(dx)>=70&&Math.abs(dx)>Math.abs(dy)*1.5)
        navigateDiary(dx<0?1:-1);
    },{passive:true});
    document.addEventListener('keydown',e=>{
      if($('editorPage').hidden||document.querySelector('dialog[open]')||e.target.closest('input,textarea,select,[contenteditable]'))return;
      if(e.altKey&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&(e.key==='ArrowLeft'||e.key==='ArrowRight')){
        e.preventDefault();navigateDiary(e.key==='ArrowLeft'?-1:1);
      }
    });
    $('newEntrySidebar').addEventListener('click',()=>newEntry());$('newEntryTop').addEventListener('click',()=>newEntry());
    $('openSidebar').addEventListener('click',()=>el.sidebar.classList.contains('open')?closeSidebar():openSidebar());$('closeSidebar').addEventListener('click',closeSidebar);el.scrim.addEventListener('click',closeSidebar);
    $('saveEntryBtn').addEventListener('click',()=>saveCurrent(true));
    el.search.addEventListener('input',renderList);
    $('calendarPrev').addEventListener('click',()=>shiftCalendar(-1));
    $('calendarNext').addEventListener('click',()=>shiftCalendar(1));
    $('calendarToday').addEventListener('click',()=>jumpToToday('sidebar'));
    $('openCalendarPage').addEventListener('click',showMiniCalendar);
    document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>{
      const tab=button.dataset.tab;
      if(tab==='home')showHome();
      else if(tab==='calendar')showMiniCalendar();
      else if(tab==='diary')showEditor();
      else if(tab==='mypage')showMyPage();
    }));
    $('homeWrite').addEventListener('click',showEditor);
    $('homeCalendar').addEventListener('click',showMiniCalendar);
    $('homeRecent').addEventListener('click',()=>{const id=$('homeRecent').dataset.entryId;if(id)selectEntry(id);});
    $('myPageBackup').addEventListener('click',()=>openBackupOptions('all'));
    $('myPageArchive').addEventListener('click',()=>openBackupOptions('1'));
    $('myPageLogout').addEventListener('click',()=>$('cloudLogout').click());
    $('myPageSignIn').addEventListener('click',()=>{
      if(hasUnsavedChanges()&&!canLeaveUnsaved())return;
      guestMode=false;cloudMode=false;current=null;entries=[];attachments=[];db=null;
      savedState=null;savedFileIds=new Set();
      revokeMediaUrls();
      $('diaryApp').hidden=true;$('cloudAuth').hidden=false;
      $('cloudLoginPanel').hidden=false;
      $('cloudSignupEmailPanel').hidden=true;
      $('cloudSignupFinishPanel').hidden=true;
      $('cloudAuthStatus').textContent='';
      closeSidebar();
    });
    const accountModal=$('accountDeleteDialog');
    function clearDeleteDialog(){
      $('accountDeletePassword').value='';
      $('accountDeletePhrase').value='';
      $('accountDeleteStatus').textContent='';
      $('accountDeleteConfirm').disabled=true;
    }
    $('myPageDelete').addEventListener('click',()=>{
      if(!cloudMode||!cloud()?.user)return;
      clearDeleteDialog();accountModal.showModal();
    });
    function checkDeleteForm(){
      $('accountDeleteConfirm').disabled=$('accountDeletePhrase').value.trim()!=='탈퇴합니다'||
        !$('accountDeletePassword').value||$('accountDeleteConfirm').dataset.working==='true';
    }
    $('accountDeletePhrase').addEventListener('input',checkDeleteForm);
    $('accountDeletePassword').addEventListener('input',checkDeleteForm);
    $('accountDeleteCancel').addEventListener('click',()=>accountModal.close());
    accountModal.addEventListener('close',clearDeleteDialog);
    $('accountDeleteForm').addEventListener('submit',async event=>{
      event.preventDefault();
      if(!cloudMode||!cloud()?.user||$('accountDeletePhrase').value.trim()!=='탈퇴합니다')return;
      if(!$('accountDeletePassword').value)return;
      if(!confirm('정말 탈퇴하시겠어요? 서버에 보관된 모든 일기와 첨부파일을 영구 삭제하며 복구할 수 없습니다.'))return;
      const button=$('accountDeleteConfirm'),uid=cloud().user.id;
      button.dataset.working='true';button.disabled=true;
      $('accountDeleteCancel').disabled=true;
      $('accountDeleteStatus').textContent='서버 기록과 계정을 삭제하고 있어요…';
      try{
        await cloud().deleteAccount($('accountDeletePassword').value);
        clearTimeout(pendingTimer);pendingTimer=null;
        current=null;attachments=[];entries=[];savedState=null;savedFileIds=new Set();
        revokeMediaUrls();
        cloudMode=false;guestMode=false;db=null;
        await clearAccountPending(uid);
        accountModal.close();
        $('diaryApp').hidden=true;$('cloudAuth').hidden=false;
        $('cloudLoginPanel').hidden=false;
        $('cloudSignupEmailPanel').hidden=true;
        $('cloudSignupFinishPanel').hidden=true;
        $('cloudAuthStatus').textContent='계정과 서버 기록이 삭제되었습니다.';
        toast('탈퇴가 완료되었습니다.');
      }catch(e){
        $('accountDeleteStatus').textContent='탈퇴 실패: '+e.message;
      }finally{
        button.dataset.working='false';
        $('accountDeleteCancel').disabled=false;
        checkDeleteForm();
      }
    });
    $('returnEditor').addEventListener('click',showEditor);
    $('miniPrev').addEventListener('click',()=>shiftCalendar(-1));
    $('calendarMonthLabel').addEventListener('click',()=>openCalendarJump());
    $('miniYear').addEventListener('click',()=>openCalendarJump());
    $('miniMonth').addEventListener('click',()=>openCalendarJump(true));
    $('calendarJumpCancel').addEventListener('click',()=>$('calendarJumpDialog').close());
    $('calendarYearPrev').addEventListener('click',()=>$('calendarJumpYear').stepDown());
    $('calendarYearNext').addEventListener('click',()=>$('calendarJumpYear').stepUp());
    $('calendarJumpForm').addEventListener('submit',e=>{
      e.preventDefault();
      if(!$('calendarJumpForm').reportValidity())return;
      calendarYear=Number($('calendarJumpYear').value);
      calendarMonth=Number($('calendarJumpMonth').value);
      highlightedCalendarDate=null;
      renderCalendar();
      $('calendarJumpDialog').close();
    });
    $('miniNext').addEventListener('click',()=>shiftCalendar(1));
    $('miniToday').addEventListener('click',()=>jumpToToday('large'));
    $('miniGrid').addEventListener('click',e=>{const b=e.target.closest('[data-mini-date]');if(b)openDayCard(b.dataset.miniDate);});
    $('dayCardClose').addEventListener('click',closeDayCard);
    $('dayCardDialog').addEventListener('close',()=>{cardDate=null;});
    $('dayOpenEntry').addEventListener('click',async()=>{
      const date=cardDate;closeDayCard();
      const entry=entries.filter(e=>e.date===date).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
      if(entry)await selectEntry(entry.id);else await newEntry(date,false);
    });
    $('dayCardSave').addEventListener('click',saveDayCard);
    $('dayDeletePhoto').addEventListener('click',deleteDayCardPhoto);
    $('dayPhotoBtn').addEventListener('click',()=>$('dayPhotoInput').click());
    $('dayPhotoInput').addEventListener('change',async()=>{
      const file=$('dayPhotoInput').files[0];$('dayPhotoInput').value='';if(!file)return;
      if(!file.type.startsWith('image/')){toast('이미지 파일을 선택해 주세요.');return;}
      if(file.type==='image/gif'||/\.gif$/i.test(file.name)){toast('GIF는 일기 첨부에서 추가해 주세요. 캘린더 썸네일은 일반 사진을 선택해 주세요.');return;}
      const url=URL.createObjectURL(file),image=new Image();
      try{
        await new Promise((res,rej)=>{image.onload=res;image.onerror=()=>rej(Error('이미지를 열 수 없어요.'));image.src=url;});
        cardImage=image;cardPhoto=file;cardZoom=1;cardOffsetX=0;cardOffsetY=0;$('dayCropZoom').value='1';
        $('dayCropSection').hidden=false;
        $('dayDeletePhoto').hidden=false;$('dayDeletePhoto').textContent='✕ 선택한 사진 취소';
        paintCrop();
      }catch(e){toast(e.message);}finally{URL.revokeObjectURL(url);}
    });
    $('dayCropZoom').addEventListener('input',e=>{cardZoom=Number(e.target.value);paintCrop();});
    const crop=$('dayCropCanvas');
    crop.addEventListener('pointerdown',e=>{if(!cardImage)return;cardDragging=true;cardPointer={x:e.clientX,y:e.clientY};crop.setPointerCapture(e.pointerId);});
    crop.addEventListener('pointermove',e=>{
      if(!cardDragging||!cardPointer)return;
      const scale=crop.width/crop.getBoundingClientRect().width;
      cardOffsetX+=(e.clientX-cardPointer.x)*scale;cardOffsetY+=(e.clientY-cardPointer.y)*scale;
      cardPointer={x:e.clientX,y:e.clientY};paintCrop();
    });
    const endDrag=()=>{cardDragging=false;cardPointer=null;};
    crop.addEventListener('pointerup',endDrag);crop.addEventListener('pointercancel',endDrag);
    el.calendarGrid.addEventListener('click',async e=>{
      const button=e.target.closest('[data-calendar-date]');
      if(!button)return;
      const date=button.dataset.calendarDate;
      const existing=entries.filter(entry=>entry.date===date).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
      if(existing)await selectEntry(existing.id);
      else await newEntry(date,false);
    });
    el.list.addEventListener('click',e=>{
      const remove=e.target.closest('[data-delete-entry-id]');
      if(remove){deleteSavedRecord(remove.dataset.deleteEntryId);return;}
      const open=e.target.closest('[data-entry-id]');
      if(open)selectEntry(open.dataset.entryId);
    });
    $('openMetaDialog').addEventListener('click',openEntryMeta);
    $('entryMetaClose').addEventListener('click',()=>$('entryMetaDialog').close());
    $('entryMetaCancel').addEventListener('click',()=>$('entryMetaDialog').close());
    $('entryMetaSave').addEventListener('click',saveEntryMeta);
    $('entryShortNote').addEventListener('input',()=>{$('entryMetaCount').textContent=$('entryShortNote').value.length+'/'+MAX_NOTE_CHARS;});
    el.title.addEventListener('input',queueSave);
    el.body.addEventListener('input',()=>{queueSave();renderPreview();});
    $('bodyFontSize').addEventListener('change',event=>{
      if(!current)return;
      const size=Number(event.target.value);
      const layout={...(current.photoLayout||{})};
      if([14,16,18,20,22,24].includes(size))layout.__bodyFontSize=size;
      else delete layout.__bodyFontSize;
      current.photoLayout=layout;
      applyBodyFontSize();queueSave();
    });
    document.addEventListener('pointerdown',event=>{
      if(!event.target.closest?.('.entry-photo-sticker'))setStickerSelection(null);
    });
    document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
    document.querySelectorAll('[data-format]').forEach(b=>b.addEventListener('click',()=>formatText(b.dataset.format)));
    document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveCurrent(true);}if((e.ctrlKey||e.metaKey)&&['b','i'].includes(e.key.toLowerCase())&&document.activeElement===el.body){e.preventDefault();formatText(e.key.toLowerCase()==='b'?'bold':'italic');}});
    $('photoPreviewClose').addEventListener('click',()=>$('photoPreviewDialog').close());
    $('photoPreviewDialog').addEventListener('click',e=>{if(e.target===$('photoPreviewDialog'))$('photoPreviewDialog').close();});
    $('photoPreviewDialog').addEventListener('close',()=>{$('photoPreviewImage').removeAttribute('src');});
    $('uploadBtn').addEventListener('click',()=>el.file.click());
    $('photoUploadBtn').addEventListener('click',()=>$('diaryPhotoInput').click());
    for(const input of [el.file,$('diaryPhotoInput')])input.addEventListener('change',()=>{
      const selected=[...input.files],entryId=current?.id,mode=$('photoInsertMode').value;
      input.value='';
      if(!selected.length)return;
      addFiles(selected,entryId,mode).catch(error=>{
        console.error('첨부파일 처리 실패',error);
        $('uploadStatus').textContent='파일 추가 실패: '+(error.message||'알 수 없는 오류');
        toast('파일을 추가하지 못했어요. 아래 오류를 확인해 주세요.');
      });
    });
    el.record.addEventListener('click',toggleRecording);
    $('deleteEntryBtn').addEventListener('click',async()=>{
      if(!current)return;
      if(isDraft){
        if(!confirm('임시 작성 내용과 첨부 파일을 지울까요?'))return;
        const date=current.date,id=current.id;
        await clearPending(id);
        current=null;attachments=[];
        await newEntry(date);
        toast('임시 작성 내용을 지웠어요.');
        return;
      }
      await deleteSavedRecord(current.id);
    });
    $('openExportBtn').addEventListener('click',async()=>{if(isDraft){toast('새 기록을 먼저 저장한 뒤 내보내 주세요.');return;}await flushSave();el.exportFilename.value=(current?.title.trim()||`${current?.date}_기록`).slice(0,MAX_EXPORT_NAME_CHARS);el.exportProgress.textContent='';el.dialog.showModal();});
    $('closeExportBtn').addEventListener('click',()=>el.dialog.close());el.dialog.addEventListener('click',e=>{if(e.target===el.dialog)el.dialog.close();});
    document.querySelectorAll('[data-export]').forEach(b=>b.addEventListener('click',()=>exportRecord(b.dataset.export)));
    for(const id of ['backupStartDate','deleteStartDate'])$(id).value=dayString().slice(0,7)+'-01';
    for(const id of ['backupEndDate','deleteEndDate'])$(id).value=dayString();
    for(const id of ['backupPeriod','backupStartDate','backupEndDate'])$(id).addEventListener('change',updateBackupPeriod);
    for(const id of ['deletePeriod','deleteStartDate','deleteEndDate'])$(id).addEventListener('change',updateDeletePeriod);
    updateBackupPeriod();
    $('archiveMonthBtn').addEventListener('click',monthlyBackup);
    $('backupPreviousMonth').addEventListener('click',()=>{$('backupPeriod').value='previous';updateBackupPeriod();monthlyBackup();});
    $('bannerBackupPrevious').addEventListener('click',()=>{$('backupPeriod').value='previous';updateBackupPeriod();monthlyBackup();});
    $('backupSaveLocal').addEventListener('click',()=>{
      if(!pendingBackup)return;
      downloadBlob(pendingBackup.blob,pendingBackup.filename);
      $('backupDestinationStatus').textContent='저장을 요청했어요. 브라우저 다운로드 목록에서 백업 ZIP 파일을 확인해 주세요.';
      $('archiveStatus').textContent='기기에 저장을 요청했어요. 다운로드 목록에서 ZIP 파일을 확인해 주세요.';
    });
    $('backupShareExternal').addEventListener('click',shareBackup);
    $('backupDestinationClose').addEventListener('click',()=>$('backupDestinationDialog').close());
    $('backupDestinationDialog').addEventListener('close',()=>{pendingBackup=null;});
    $('monthDeleteVerification').addEventListener('input',e=>{
      $('monthDeleteConfirm').disabled=!pendingMonthDeletion||e.target.value.trim()!==pendingMonthDeletion.verification;
    });
    $('monthDeleteCancel').addEventListener('click',()=>$('monthDeleteDialog').close());
    $('monthDeleteConfirm').addEventListener('click',confirmMonthlyDelete);
    $('monthDeleteDialog').addEventListener('close',()=>{pendingMonthDeletion=null;});
    $('deleteMonthBtn').addEventListener('click',monthlyDelete);
    $('backupBtn').addEventListener('click',()=>openBackupOptions());
    $('openMonthDelete').addEventListener('click',()=>{updateDeletePeriod();$('backupDeleteDialog').showModal();});
    $('backupOptionsClose').addEventListener('click',()=>$('backupOptionsDialog').close());
    $('backupDeleteClose').addEventListener('click',()=>$('backupDeleteDialog').close());
    $('restoreBtn').addEventListener('click',()=>el.restoreInput.click());el.restoreInput.addEventListener('change',async()=>{const file=el.restoreInput.files[0];if(file)await restoreBackup(file);el.restoreInput.value='';});
    window.addEventListener('beforeunload',e=>{
      if(appUpdateReloading||!hasUnsavedChanges())return;
      stagePending();
      e.preventDefault();e.returnValue='';
    });
    window.addEventListener('pagehide',()=>{if(hasUnsavedChanges())stagePending();});
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState==='hidden'&&hasUnsavedChanges())stagePending();
    });
  }
  bindEvents();

  // Offer new PWA versions without interrupting typing or committing a diary to the server.
  function setupAppUpdatePrompt(){
    if(!('serviceWorker' in navigator)||!/^https?:$/.test(location.protocol))return;
    const notice=$('appUpdateNotice'),accept=$('appUpdateApply'),later=$('appUpdateLater');
    let registration=null,hadController=!!navigator.serviceWorker.controller;
    let updateBusy=false,updateDismissed=false,checking=false;
    const show=(force=false)=>{
      if(!hadController||(!force&&updateDismissed))return;
      notice.hidden=false;
    };
    const detect=()=>{
      if(registration?.waiting&&navigator.serviceWorker.controller)show();
    };
    const watch=worker=>{
      if(!worker)return;
      worker.addEventListener('statechange',()=>{
        if(worker.state==='installed')detect();
      });
    };
    function reloadWhenReady(){
      if(!appUpdateReloading)return;
      location.reload();
    }
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(appUpdateReloading){reloadWhenReady();return;}
      if(hadController)show();
      hadController=true;
    });
    later.addEventListener('click',()=>{
      updateDismissed=true;
      notice.hidden=true;
    });
    accept.addEventListener('click',async()=>{
      if(updateBusy)return;
      if(isSavingDraft||isExporting||recorder){
        toast('저장·녹음·내보내기를 마친 뒤 업데이트해 주세요.');
        return;
      }
      if(hasUnsavedChanges()&&!confirm('저장하지 않은 변경사항이 있어요. 기기에 임시 보관한 뒤 업데이트할까요? 서버에는 저장되지 않습니다.'))return;
      updateBusy=true;accept.disabled=true;
      const oldLabel=accept.textContent;
      accept.textContent='확인 중…';
      try{
        // Fail closed: don't navigate until edits and attached Blobs are durably stored.
        clearTimeout(pendingTimer);
        if(hasUnsavedChanges()){
          stagePending();
          await pendingWrites;
        }
        appUpdateReloading=true;
        accept.textContent='업데이트 중…';
        if(registration?.waiting){
          registration.waiting.postMessage({type:'SKIP_WAITING'});
          // Reload only once the updated worker actually controls the page.
          setTimeout(()=>{
            if(!appUpdateReloading)return;
            if(registration?.waiting){
              appUpdateReloading=false;updateBusy=false;accept.disabled=false;
              accept.textContent=oldLabel;
              toast('업데이트를 적용하지 못했어요. 다시 시도해 주세요.');
            }else location.reload();
          },6000);
        }else location.reload();
      }catch(e){
        appUpdateReloading=false;
        toast('임시 보관에 실패했어요. 기록을 보호하기 위해 업데이트를 취소했어요.');
        console.warn('업데이트 전 임시 기록 보관 실패',e);
        updateBusy=false;accept.disabled=false;accept.textContent=oldLabel;
      }
    });
    const check=async()=>{
      if(checking||document.visibilityState==='hidden'||!registration)return;
      checking=true;
      try{await registration.update();detect();}
      catch(e){console.warn('업데이트 확인 실패',e);}
      finally{checking=false;}
    };
    navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>{
      registration=reg;
      watch(reg.installing);
      reg.addEventListener('updatefound',()=>{
        watch(reg.installing);
        updateDismissed=false;
      });
      detect();
      check();
      // Check while installed PWA is open and again when it returns to foreground.
      setInterval(check,20*60*1000);
      window.addEventListener('focus',check);
      document.addEventListener('visibilitychange',()=>{
        if(document.visibilityState==='visible')check();
      });
    }).catch(e=>console.warn('앱 업데이트 감지 설정 실패',e));
  }
  setupAppUpdatePrompt();

  // Dismiss the opening screen even when authentication or a cached stylesheet is slow.
  const intro=$('startupIntro');
  let introClosed=false;
  function closeIntro(){
    if(!intro||introClosed)return;
    introClosed=true;
    intro.classList.add('is-finished');
    setTimeout(()=>intro.remove(),600);
  }
  setTimeout(closeIntro,2200);
  init().finally(()=>setTimeout(closeIntro,800));
})();
