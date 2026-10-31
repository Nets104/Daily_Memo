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
  const FILE_LIMITS={image:5*1024*1024,video:30*1024*1024,audio:10*1024*1024,pdf:10*1024*1024};
  const fileLimit=(type,name='')=>{
    if(type.startsWith('image/')||/\.(jpe?g|png|gif|webp|heic|heif|avif)$/i.test(name))return FILE_LIMITS.image;
    if(type.startsWith('video/')||/\.(mp4|mov|webm|m4v)$/i.test(name))return FILE_LIMITS.video;
    if(type.startsWith('audio/')||/\.(mp3|wav|m4a|ogg|flac|aac)$/i.test(name))return FILE_LIMITS.audio;
    return FILE_LIMITS.pdf;
  };
  const WEEK_KR = ['일','월','화','수','목','금','토'];
  const WEEK_JP = ['日','月','火','水','木','金','土'];
  const MONTH_EN = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const WEEK_EN = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
  let db, entries = [], current = null, attachments = [], mediaUrls = [];
  const cloud = () => window.DiaryCloud?.configured ? window.DiaryCloud : null;
  let cloudMode=false, initialized=false;
  let saveTimer = null, savePromise = Promise.resolve(), toastTimer = null, view = 'edit';
  let recorder = null, recordStream = null, recordChunks = [], recordingEntryId = null;
  let isExporting = false;
  let isDraft = false, isSavingDraft = false;
  let savedState=null,savedFileIds=new Set(),pendingTimer=null,pendingWrites=Promise.resolve();
  const pendingScope=()=>cloudMode&&cloud()?.user?.id?'user:'+cloud().user.id:'local';
  const pendingKey=id=>pendingScope()+':'+id;
  const entryFields=e=>({
    date:e?.date||'',title:e?.title||'',body:e?.body||'',weather:e?.weather||'',
    shortNote:e?.shortNote||'',coverAttachmentId:e?.coverAttachmentId||null
  });
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
  let archivedMonth=null;
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
  function writeRecords(storeName, values) {
    if(cloudMode) return storeName==='entries' ? Promise.all(values.map(v=>cloud().saveEntry(v))) : cloud().saveAttachments(values);
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
      async function showUser(){
        const user=await cloud().session();
        if(!user){
          cloudMode=false;auth.hidden=false;app.hidden=true;return;
        }
        cloudMode=true;db={};auth.hidden=true;app.hidden=false;
        $('cloudAccount').hidden=false;$('cloudUserEmail').textContent=user.email||'';
        current=null;attachments=[];entries=[];clearTimeout(saveTimer);saveTimer=null;
        await loadEntries();
      }
      const msg=$('cloudAuthStatus');
      $('cloudAuthForm').addEventListener('submit',async e=>{
        e.preventDefault();msg.textContent='로그인 중…';
        try{await cloud().login($('cloudEmail').value.trim(),$('cloudPassword').value);msg.textContent='';await showUser();}
        catch(err){msg.textContent='로그인 실패: '+err.message;}
      });
      $('cloudSignup').addEventListener('click',async()=>{
        msg.textContent='계정 생성 중…';
        try{
          await cloud().signup($('cloudEmail').value.trim(),$('cloudPassword').value);
          msg.textContent='가입 요청 완료. 이메일 인증이 활성화되어 있으면 메일의 확인 링크를 누른 뒤 로그인해 주세요.';
        }catch(err){msg.textContent='가입 실패: '+err.message;}
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
      if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('./sw.js').catch(()=>{});
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
    el.edited.textContent=current?.updatedAt ? `${new Date(current.updatedAt).toLocaleDateString('ko-KR')} 수정` : '';
    updateInputCounts();renderPreview();
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
    current={id:makeId(),date,title:'',body:'',weather:'',shortNote:'',createdAt:timestamp,updatedAt:timestamp};
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
    $('myPageEmail').textContent=user?.email||'이 기기에 저장된 기록';
    $('myPageCount').textContent=entries.length+'개';
    $('myPageLogout').hidden=!cloudMode;
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
      if(isNew)entry={id:makeId(),date,title:'',body:'',weather:'',shortNote:'',createdAt:now,updatedAt:now};
      else entry={...entry};
      entry.shortNote=note;entry.updatedAt=now;
      const previousCoverId=cardCoverFileId||entry.coverAttachmentId||null;
      let file=null;
      if(cardPhoto){
        const canvas=$('dayCropCanvas');
        const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(Error('이미지를 자르지 못했어요.')),'image/jpeg',.86));
        if(blob.size>FILE_LIMITS.image)throw Error('썸네일은 5MB 이하여야 해요.');
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
          {...current,shortNote:entry.shortNote,coverAttachmentId:entry.coverAttachmentId,updatedAt:entry.updatedAt}:
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
      const note=entry?(entry.shortNote||entry.title||'기록 보기'):'';
      const weather=entry?(WEATHER_EMOJI[entry.weather]||''):'';
      cells.push(`<button class="mini-day ${entry?'filled':''} ${date===dayString()?'today':''} ${date===highlightedCalendarDate?'jump-selected':''}" data-mini-date="${date}" aria-pressed="${date===highlightedCalendarDate}"><span class="mini-day-head"><span class="mini-date">${d}</span>${weather?`<span class="mini-weather" aria-label="날씨">${weather}</span>`:''}</span><span class="mini-photo" data-mini-photo="${date}">${entry?.coverAttachmentId?'✿':'+'}</span><span class="mini-line ${note?'has-note':''}">${escapeHtml(note)}</span></button>`);
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
  function setView(next) {
    view=next;
    el.writing.className=`writing-area view-${next}`;
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
  function renderAttachments(){
    if($('photoPreviewDialog').open)$('photoPreviewDialog').close();
    revokeMediaUrls();
    const shown=attachments.filter(f=>!isCalendarCover(f)&&!isDiaryCropPreview(f));
    const cropMap=new Map(attachments.filter(isDiaryCropPreview).map(f=>[f.name,f]));
    el.attachCount.textContent=shown.length;el.attachList.replaceChildren();
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
          renderAttachments();queueSave();
          toast('첨부를 목록에서 제외했어요. 일기 저장 버튼으로 확정해 주세요.');
        }catch(e){toast('삭제하지 못했어요.');}
      });
      info.append(name);
      info.append(remove);
      const dl=document.createElement('a');dl.className='attachment-download';
      dl.textContent='원본 다운로드 ↓';dl.href=url;dl.download=file.name;
      outer.append(visual,info,dl);
      (isPhoto?wall:files).append(outer);
    }
    if(wall.childElementCount)el.attachList.append(wall);
    if(files.childElementCount)el.attachList.append(files);
  }
  async function addFiles(fileList, entryId=current?.id){
    if(isSavingDraft){toast('저장 중에는 첨부를 변경할 수 없어요.');return;}
    if(!db){toast('저장소에 접근할 수 없어요.');return;}
    const targetDraft=isDraft && current?.id===entryId;
    if(!targetDraft && !entries.some(e=>e.id===entryId)){toast('해당 기록이 더 이상 열려 있지 않아요.');return;}
    let added=0;
    let diaryPhotoCount=attachments.filter(f=>f.type.startsWith('image/')&&!isCalendarCover(f)&&!isDiaryCropPreview(f)).length;
    for(const file of [...fileList]) {
      if(!/^(image\/|video\/|audio\/|application\/pdf$)/.test(file.type) && !/\.(jpe?g|png|gif|webp|heic|heif|avif|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|flac|aac|pdf)$/i.test(file.name)){toast(`${file.name}: 지원하지 않는 형식이에요.`);continue;}
      const maxBytes=fileLimit(file.type||'',file.name);
      if(file.size>maxBytes){toast(`${file.name}: 최대 ${Math.round(maxBytes/1024/1024)}MB까지만 첨부할 수 있어요.`);continue;}
      const ext=file.name.split('.').pop().toLowerCase();
      const inferred={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',heic:'image/heic',heif:'image/heif',avif:'image/avif',mp4:'video/mp4',mov:'video/quicktime',m4v:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',ogg:'audio/ogg',flac:'audio/flac',aac:'audio/aac',pdf:'application/pdf'};
      const type=file.type || inferred[ext] || 'application/octet-stream';
      const isPhoto=type.startsWith('image/');
      if(isPhoto&&diaryPhotoCount>=MAX_DIARY_PHOTOS){toast('일기 사진은 최대 10장까지 첨부할 수 있어요.');continue;}
      const record={id:makeId(),entryId,name:file.name,type,size:file.size,blob:file,createdAt:new Date().toISOString()};
      try{
        if(current?.id===entryId)attachments.push(record);
        added++;
        if(isPhoto){
          diaryPhotoCount++;
          try{
            const preview=await createDiaryPreview(record);
            if(current?.id===entryId)attachments.push(preview);
          }catch(error){console.warn('자동 사진 맞추기 실패, 원본은 유지됩니다.',error);}
        }
      }catch(e){console.error(e);toast('저장 공간이 부족할 수 있어요. 첨부 파일을 저장하지 못했어요.');break;}
    }
    if(current?.id===entryId){
      renderAttachments();
      if(added)queueSave();
    }
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
        if(blob.size)await addFiles([new File([blob],`음성기록_${dayString()}_${Date.now()}.${ext}`,{type:blob.type})],recordingEntryId);
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
  async function buildBackup(selectedEntries,filename){
    if(!selectedEntries.length)throw Error('백업할 기록이 없어요.');
    const selectedIds=new Set(selectedEntries.map(e=>e.id));const allAttachments=await getAll('attachments');
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
    downloadBlob(result,`${filename}.zip`);
    return {ids:selectedEntries.map(e=>e.id),files:chosen.length};

  }
  function monthEntries(){
    const month=$('archiveMonth').value;
    if(!/^\d{4}-\d{2}$/.test(month))throw Error('월을 선택하세요.');
    return {month,items:entries.filter(e=>e.date.startsWith(month+'-'))};
  }
  async function monthlyBackup(){
    archivedMonth=null;
    try{
      await flushSave();const {month,items}=monthEntries();
      $('archiveStatus').textContent='ZIP 검사 중…';
      const result=await buildBackup(items,'일상기록_'+month+'_월별백업');
      archivedMonth={month,ids:result.ids,stamp:items.map(e=>[e.id,e.date,e.title,e.body,e.updatedAt])};
      $('archiveStatus').textContent=items.length+'개 기록 및 '+result.files+'개 첨부의 ZIP 무결성 검사 완료. 다운로드한 파일을 직접 확인한 후 삭제하세요.';
    }catch(e){$('archiveStatus').textContent='오류: '+e.message;}
  }
  async function monthlyDelete(){
    try{
      await flushSave();const {month,items}=monthEntries();
      if(!archivedMonth||archivedMonth.month!==month||archivedMonth.ids.length!==items.length||items.some(e=>!archivedMonth.ids.includes(e.id))||JSON.stringify(archivedMonth.stamp)!==JSON.stringify(items.map(e=>[e.id,e.date,e.title,e.body,e.updatedAt])))throw Error('선택한 월의 백업을 다시 실행하세요.');
      if(!confirm('다운로드한 ZIP 파일을 확인하고 보관했나요? '+items.length+'개 기록과 첨부파일을 영구 삭제합니다.'))return;
      if(prompt('확인을 위해 '+month+' 입력')!==month)return;
      let deleted=0;
      for(const entry of items){try{await deleteEntryData(entry.id);entries=entries.filter(e=>e.id!==entry.id);deleted++;}catch(e){console.error(e);}}
      if(current&&!isDraft&&!entries.some(e=>e.id===current.id)){
        current=null;attachments=[];isDraft=false;
        const next=[...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
        if(next)await selectEntry(next.id);else await newEntry();
      }
      archivedMonth=null;renderList();
      $('archiveStatus').textContent=deleted===items.length ? '해당 월 삭제 완료' : deleted+'개 삭제, '+(items.length-deleted)+'개 실패. 다시 확인하세요.';
    }catch(e){toast(e.message);}
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
      await writeRecords('entries',data.entries);
      for(const a of data.attachments){const bytes=zip.get(a.path);if(!bytes)throw Error(`${a.name}: 미디어 파일을 찾지 못했어요.`);const {path,...meta}=a;await writeRecords('attachments',[{...meta,blob:new Blob([bytes],{type:a.type})}]);}
      entries=await getAll('entries');const last=[...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];current=null;isDraft=false;await selectEntry(last.id);
      setSave('','저장됨');toast(`${data.entries.length}개 기록의 백업을 불러왔어요.`);
    }catch(e){console.error(e);setSave('error','복원 실패');toast(`복원 실패: ${e.message}`);}
  }
  function stripMd(s){return s.replace(/!\[([^\]]*)\]\([^)]*\)/g,'$1').replace(/\[([^\]]+)\]\([^)]+\)/g,'$1').replace(/<\/?u>/g,'').replace(/\*\*|__|~~|[`*_]/g,'');}
  async function canvasPages(entry,attached) {
    await document.fonts?.ready;
    const W=1240,H=1754,left=94,right=1146,bottom=1590;
    const pages=[];let ctx,y;
    const col={ink:'#303248',muted:'#8d90a3',purple:'#786bd1',light:'#e8e7f3'};
    function page(){const c=document.createElement('canvas');c.width=W;c.height=H;ctx=c.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,W,H);pages.push(c);y=130;ctx.fillStyle=col.muted;ctx.font='22px Pretendard, sans-serif';ctx.fillText('일상 기록  /  MY JOURNAL',left,85);ctx.strokeStyle=col.light;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(left,103);ctx.lineTo(right,103);ctx.stroke();}
    function setFont(size,bold=false){ctx.font=`${bold?750:400} ${size}px Pretendard, "Noto Sans KR", sans-serif`;ctx.textBaseline='alphabetic';}
    function ensure(h){if(y+h>bottom)page();}
    function drawWrapped(s,options={}){
      const size=options.size||28,lineHeight=options.lineHeight||46,bold=!!options.bold,indent=options.indent||0,color=options.color||col.ink;
      setFont(size,bold);let line='',lines=[];const maxWidth=right-left-indent;
      for(const char of String(s||' ')){
        if(char==='\n'){lines.push(line);line='';continue;}
        if(ctx.measureText(line+char).width>maxWidth && line){lines.push(line);line=char;}else line+=char;
      }lines.push(line);ctx.fillStyle=color;
      for(const part of lines){ensure(lineHeight);setFont(size,bold);ctx.fillStyle=color;ctx.fillText(part,left+indent,y+lineHeight*.78);y+=lineHeight;}
    }
    page();drawWrapped(dateText(entry.date),{size:25,bold:true,color:col.purple,lineHeight:48});y+=13;
    drawWrapped(entry.title.trim()||'제목 없는 기록',{size:54,bold:true,lineHeight:76});y+=23;
    ensure(20);ctx.strokeStyle=col.light;ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(right,y);ctx.stroke();y+=36;
    for(const b of parseBlocks(entry.body)){
      if(b.kind==='heading'){y+=b.level===1?18:8;drawWrapped(stripMd(b.text),{size:b.level===1?40:b.level===2?35:31,bold:true,lineHeight:b.level===1?62:55});y+=15;}
      else if(b.kind==='paragraph'){drawWrapped(stripMd(b.text),{lineHeight:47});y+=24;}
      else if(b.kind==='quote'){ensure(70);ctx.fillStyle='#a9a1dd';ctx.fillRect(left,y,5,40);drawWrapped(stripMd(b.text),{indent:24,color:'#686883',lineHeight:45});y+=20;}
      else if(b.kind==='code'){for(const line of b.text.split('\n'))drawWrapped(line,{size:23,color:'#646481',indent:14,lineHeight:39});y+=21;}
      else if(b.kind==='rule'){ensure(40);ctx.strokeStyle=col.light;ctx.beginPath();ctx.moveTo(left,y+15);ctx.lineTo(right,y+15);ctx.stroke();y+=44;}
      else if(b.kind==='list'){for(let i=0;i<b.items.length;i++){const item=b.items[i];const prefix=b.ordered?`${i+1}.  `:item.check===null?'•  ':item.check?'☑  ':'☐  ';drawWrapped(prefix+stripMd(item.text),{indent:14,lineHeight:44});}y+=20;}
    }
    if(attached.length){y+=15;ensure(100);drawWrapped('첨부 파일',{size:37,bold:true,lineHeight:64});y+=10;
      for(const a of attached){if(a.type.startsWith('image/')){
          let image=null,url='';try{url=URL.createObjectURL(a.blob);image=await new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=url;});}catch(e){}finally{if(url)URL.revokeObjectURL(url);}
          if(image){const width=Math.min(right-left,Math.round(image.naturalWidth * Math.min(1,(right-left)/image.naturalWidth,560/image.naturalHeight)));const height=Math.round(image.naturalHeight*width/image.naturalWidth);ensure(height+70);ctx.drawImage(image,left,y,width,height);y+=height+9;drawWrapped(a.name,{size:21,color:col.muted,lineHeight:36});y+=19;}
          else{drawWrapped(`사진: ${a.name}`,{size:23,lineHeight:42});y+=10;}
        }else{drawWrapped(`📎 ${a.name}  (원본 파일은 ZIP 내보내기에서 확인)`,{size:22,color:col.muted,lineHeight:39});y+=8;}}
    }
    for(let i=0;i<pages.length;i++){const c=pages[i],cctx=c.getContext('2d');cctx.fillStyle=col.muted;cctx.font='19px Pretendard, sans-serif';cctx.fillText(`일상 기록  ·  ${i+1} / ${pages.length}`,left,1685);}
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
    $('myPageBackup').addEventListener('click',()=>$('backupBtn').click());
    $('myPageArchive').addEventListener('click',()=>{openSidebar();$('archiveMonth').scrollIntoView({block:'center'});});
    $('myPageLogout').addEventListener('click',()=>$('cloudLogout').click());
    $('returnEditor').addEventListener('click',showEditor);
    $('miniPrev').addEventListener('click',()=>shiftCalendar(-1));
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
      if(file.size>FILE_LIMITS.image){toast('사진은 5MB 이하만 선택할 수 있어요.');return;}
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
    document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
    document.querySelectorAll('[data-format]').forEach(b=>b.addEventListener('click',()=>formatText(b.dataset.format)));
    document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveCurrent(true);}if((e.ctrlKey||e.metaKey)&&['b','i'].includes(e.key.toLowerCase())&&document.activeElement===el.body){e.preventDefault();formatText(e.key.toLowerCase()==='b'?'bold':'italic');}});
    $('photoPreviewClose').addEventListener('click',()=>$('photoPreviewDialog').close());
    $('photoPreviewDialog').addEventListener('click',e=>{if(e.target===$('photoPreviewDialog'))$('photoPreviewDialog').close();});
    $('photoPreviewDialog').addEventListener('close',()=>{$('photoPreviewImage').removeAttribute('src');});
    $('uploadBtn').addEventListener('click',()=>el.file.click());el.file.addEventListener('change',()=>{addFiles(el.file.files);el.file.value='';});el.record.addEventListener('click',toggleRecording);
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
    $('archiveMonth').value=dayString().slice(0,7);
    $('archiveMonth').addEventListener('change',()=>{archivedMonth=null;});
    $('archiveMonthBtn').addEventListener('click',monthlyBackup);
    $('deleteMonthBtn').addEventListener('click',monthlyDelete);
    $('backupBtn').addEventListener('click',async()=>{try{if(isDraft && (el.title.value.trim() || el.body.value.trim() || attachments.length))toast('저장하지 않은 새 기록은 백업에 포함되지 않아요.');await flushSave();await buildBackup([...entries],`일상기록_전체백업_${dayString()}`);toast('전체 기록과 첨부 파일 백업을 저장했어요.');}catch(e){toast(`백업 실패: ${e.message}`);}});
    $('restoreBtn').addEventListener('click',()=>el.restoreInput.click());el.restoreInput.addEventListener('change',async()=>{const file=el.restoreInput.files[0];if(file)await restoreBackup(file);el.restoreInput.value='';});
    window.addEventListener('beforeunload',e=>{
      if(!hasUnsavedChanges())return;
      stagePending();
      e.preventDefault();e.returnValue='';
    });
    window.addEventListener('pagehide',()=>{if(hasUnsavedChanges())stagePending();});
    document.addEventListener('visibilitychange',()=>{
      if(document.visibilityState==='hidden'&&hasUnsavedChanges())stagePending();
    });
  }
  bindEvents();
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