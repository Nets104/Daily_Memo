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
  const WEEK_KR = ['일','월','화','수','목','금','토'];
  const WEEK_JP = ['日','月','火','水','木','金','土'];
  const MONTH_EN = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
  const WEEK_EN = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
  let db, entries = [], current = null, attachments = [], mediaUrls = [];
  let saveTimer = null, savePromise = Promise.resolve(), toastTimer = null, view = 'edit';
  let recorder = null, recordStream = null, recordChunks = [], recordingEntryId = null;
  let isExporting = false;
  let calendarYear = new Date().getFullYear(), calendarMonth = new Date().getMonth();

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
  function toast(message) { el.toast.textContent = message; el.toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.toast.classList.remove('show'),3200); }
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
    return new Promise((resolve,reject) => {
      const tx=db.transaction(storeName,'readwrite');
      const store=tx.objectStore(storeName);
      for(const value of values) store.put(value);
      tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error || Error('저장 실패'));
    });
  }
  function getAll(storeName, indexName, value) {
    return new Promise((resolve,reject) => {
      const tx=db.transaction(storeName,'readonly');
      const request=indexName ? tx.objectStore(storeName).index(indexName).getAll(value) : tx.objectStore(storeName).getAll();
      request.onsuccess=()=>resolve(request.result || []);request.onerror=()=>reject(request.error);
    });
  }
  function deleteOne(storeName, key) {
    return new Promise((resolve,reject)=>{ const tx=db.transaction(storeName,'readwrite');tx.objectStore(storeName).delete(key);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error); });
  }
  async function deleteEntryData(id) {
    const keys=await new Promise((resolve,reject)=>{const tx=db.transaction('attachments','readonly');const q=tx.objectStore('attachments').index('entryId').getAllKeys(id);q.onsuccess=()=>resolve(q.result);q.onerror=()=>reject(q.error);});
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(['entries','attachments'],'readwrite');
      for(const key of keys)tx.objectStore('attachments').delete(key);
      tx.objectStore('entries').delete(id);
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
    });
  }
  async function init() {
    try {
      db=await openDb();entries=await getAll('entries');
      if(entries.length) await selectEntry([...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0].id);
      else await newEntry();
      renderList();
      if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('./sw.js').catch(()=>{});
    } catch(e) {
      console.error(e);setSave('error','저장소 사용 불가');toast('브라우저의 저장소를 열 수 없어요. 일반 모드에서 다시 열어 주세요.');
      current={id:makeId(),date:dayString(),title:'',body:'',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};fillEditor();
    }
  }
  function refreshCurrentFromForm() {
    if(!current) return;
    current.date=el.date.value || dayString();current.title=el.title.value;current.body=el.body.value;
  }
  function queueSave() {
    if(!current || !db) return;
    refreshCurrentFromForm();setSave('saving','저장 중…');clearTimeout(saveTimer);
    saveTimer=setTimeout(()=>{ saveTimer=null;saveCurrent(); },450);
    renderList();
  }
  async function saveCurrent() {
    clearTimeout(saveTimer);saveTimer=null;
    if(!current || !db) return;
    refreshCurrentFromForm();current.updatedAt=new Date().toISOString();
    const snapshot={...current};
    savePromise=savePromise.catch(()=>{}).then(()=>writeRecords('entries',[snapshot]));
    try { await savePromise; if(current?.id===snapshot.id){setSave('', '저장됨');el.edited.textContent='방금 수정됨';} renderList(); }
    catch(e){console.error(e);setSave('error','저장 실패');toast('기록 저장에 실패했어요. 기기 저장 공간을 확인해 주세요.');}
  }
  async function flushSave() { if(saveTimer) await saveCurrent();else await savePromise.catch(()=>{}); }
  function fillEditor() {
    el.date.value=current?.date || dayString();el.title.value=current?.title || '';el.body.value=current?.body || '';
    setCalendarMonth(el.date.value);
    el.dateDisplay.textContent=dateText(el.date.value);
    const d=new Date(`${el.date.value}T12:00:00`);$('stickerMonth').textContent=MONTH_EN[d.getMonth()];$('stickerDay').textContent=String(d.getDate());$('stickerWeek').textContent=WEEK_EN[d.getDay()];
    el.edited.textContent=current?.updatedAt ? `${new Date(current.updatedAt).toLocaleDateString('ko-KR')} 수정` : '';
    el.charCount.textContent=`${[...el.body.value].length.toLocaleString()}자`;renderPreview();
  }
  async function selectEntry(id) {
    if(current?.id===id){closeSidebar();return;}
    await flushSave();
    current=entries.find(e=>e.id===id);
    if(!current)return;
    fillEditor();attachments=db ? await getAll('attachments','entryId',id) : [];renderAttachments();renderList();closeSidebar();
  }
  async function newEntry(date = dayString()) {
    await flushSave();
    const timestamp=new Date().toISOString();
    const entry={id:makeId(),date,title:'',body:'',createdAt:timestamp,updatedAt:timestamp};
    current=entry;entries.push(entry);
    if(db){try{await writeRecords('entries',[entry]);setSave('','저장됨');}catch(e){setSave('error','저장 실패');}}
    fillEditor();attachments=[];renderAttachments();renderList();closeSidebar();el.title.focus();
  }
  function setCalendarMonth(iso) {
    const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso || '');
    if (!match) return;
    calendarYear = Number(match[1]);
    calendarMonth = Number(match[2]) - 1;
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
      const classes = ['calendar-day', count ? 'has-entry' : '', iso === current?.date ? 'active' : '', iso === dayString() ? 'today' : ''].filter(Boolean).join(' ');
      const label = `${dateText(iso, 'kr')}, ${count ? `기록 ${count}개 열기` : '새 기록 작성'}`;
      days.push(`<button type="button" class="${classes}" data-calendar-date="${iso}" aria-label="${escapeHtml(label)}" aria-pressed="${iso === current?.date}"><span>${day}</span>${count > 1 ? `<small class="calendar-multi">${count}</small>` : ''}</button>`);
    }
    el.calendarGrid.innerHTML = days.join('');
  }
  function shiftCalendar(delta) {
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
    el.list.innerHTML=shown.length ? shown.map(e=>`<button class="list-entry ${e.id===current?.id?'active':''}" data-entry-id="${escapeHtml(e.id)}"><div class="entry-list-date">${escapeHtml(dateText(e.date))}</div><div class="entry-list-title">${escapeHtml(e.title.trim()||'제목 없는 기록')}</div><div class="entry-list-excerpt">${escapeHtml(e.body.replace(/[#*`_>\[\]\n-]/g,' ').trim().slice(0,90)||'여기에 하루의 이야기를 담아보세요.')}</div></button>`).join('') : '<div class="list-empty">검색된 기록이 없어요.<br>새로운 하루를 남겨볼까요?</div>';
  }
  function updateDate() {
    const iso=el.date.value;if(!iso)return;
    setCalendarMonth(iso);
    el.dateDisplay.textContent=dateText(iso);
    const d=new Date(`${iso}T12:00:00`);$('stickerMonth').textContent=MONTH_EN[d.getMonth()];$('stickerDay').textContent=d.getDate();$('stickerWeek').textContent=WEEK_EN[d.getDay()];queueSave();
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
      ta.value=ta.value.slice(0,ls)+modified+ta.value.slice(actualEnd);ta.focus();ta.setSelectionRange(ls,ls+modified.length);queueSave();renderPreview();el.charCount.textContent=`${[...ta.value].length.toLocaleString()}자`;return;
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
    ta.value=a+edit.insert+b;ta.focus();ta.setSelectionRange(start+edit.selStart,start+edit.selEnd);queueSave();renderPreview();el.charCount.textContent=`${[...ta.value].length.toLocaleString()}자`;
  }
  function closeSidebar(){el.sidebar.classList.remove('open');el.scrim.classList.remove('visible');}
  function openSidebar(){el.sidebar.classList.add('open');el.scrim.classList.add('visible');}
  function revokeMediaUrls(){for(const u of mediaUrls)URL.revokeObjectURL(u);mediaUrls=[];}
  function renderAttachments(){
    revokeMediaUrls();el.attachCount.textContent=attachments.length;el.attachList.replaceChildren();
    for(const file of attachments){
      const outer=document.createElement('div');outer.className='attachment-item';
      const visual=document.createElement('div');visual.className='attachment-visual';
      const u=URL.createObjectURL(file.blob);mediaUrls.push(u);
      if(file.type.startsWith('image/')){const img=document.createElement('img');img.src=u;img.alt=file.name;img.loading='lazy';visual.append(img);}
      else if(file.type.startsWith('video/')){const video=document.createElement('video');video.src=u;video.controls=true;video.preload='metadata';visual.append(video);}
      else if(file.type.startsWith('audio/')){const audio=document.createElement('audio');audio.src=u;audio.controls=true;audio.preload='metadata';visual.append(audio);}
      else visual.textContent='PDF';
      const info=document.createElement('div');info.className='attachment-info';
      const name=document.createElement('span');name.className='attachment-name';name.textContent=file.name;name.title=file.name;
      const remove=document.createElement('button');remove.type='button';remove.className='attachment-remove';remove.textContent='×';remove.title=`${file.name} 삭제`;remove.setAttribute('aria-label',`${file.name} 삭제`);
      remove.addEventListener('click',async()=>{if(!confirm(`"${file.name}" 파일을 삭제할까요?`))return;try{await deleteOne('attachments',file.id);attachments=attachments.filter(x=>x.id!==file.id);renderAttachments();toast('첨부 파일을 삭제했어요.');}catch(e){toast('삭제하지 못했어요.');}});
      info.append(name,remove);
      const dl=document.createElement('a');dl.className='attachment-download';dl.textContent='원본 다운로드 ↓';dl.href=u;dl.download=file.name;
      outer.append(visual,info,dl);el.attachList.append(outer);
    }
  }
  async function addFiles(fileList, entryId=current?.id){
    if(!db){toast('저장소에 접근할 수 없어요.');return;}
    let added=0;
    for(const file of [...fileList]) {
      if(!/^(image\/|video\/|audio\/|application\/pdf$)/.test(file.type) && !/\.(jpe?g|png|gif|webp|heic|heif|avif|mp4|mov|webm|m4v|mp3|wav|m4a|ogg|flac|aac|pdf)$/i.test(file.name)){toast(`${file.name}: 지원하지 않는 형식이에요.`);continue;}
      if(file.size>200*1024*1024){toast(`${file.name}: 200MB 초과 파일은 첨부할 수 없어요.`);continue;}
      const ext=file.name.split('.').pop().toLowerCase();
      const inferred={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp',heic:'image/heic',heif:'image/heif',avif:'image/avif',mp4:'video/mp4',mov:'video/quicktime',m4v:'video/mp4',webm:'video/webm',mp3:'audio/mpeg',wav:'audio/wav',m4a:'audio/mp4',ogg:'audio/ogg',flac:'audio/flac',aac:'audio/aac',pdf:'application/pdf'};
      const type=file.type || inferred[ext] || 'application/octet-stream';
      const record={id:makeId(),entryId,name:file.name,type,size:file.size,blob:file,createdAt:new Date().toISOString()};
      try{await writeRecords('attachments',[record]);if(current?.id===entryId)attachments.push(record);added++;}
      catch(e){console.error(e);toast('저장 공간이 부족할 수 있어요. 첨부 파일을 저장하지 못했어요.');break;}
    }
    if(current?.id===entryId)renderAttachments();if(added)toast(`${added}개 파일을 기록에 첨부했어요.`);
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
  function currentExportName(){return safeFileName(el.exportFilename.value || current?.title || `${current?.date}_기록`);}
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
      if(method!==0)throw Error('하루결에서 만든 압축되지 않은 ZIP 백업만 불러올 수 있어요.');
      if(start+30>bytes.length||v.getUint32(start,true)!==0x04034b50)throw Error('ZIP 항목이 손상되었어요.');
      const nameSize=v.getUint16(start+26,true),extraSize=v.getUint16(start+28,true),begin=start+30+nameSize+extraSize;
      if(begin+size>bytes.length)throw Error('ZIP 파일의 길이가 올바르지 않아요.');
      const data=bytes.slice(begin,begin+size);if(crc32(data)!==crc)throw Error(`파일 무결성 확인 실패: ${name}`);files.set(name,data);
    }return files;
  }
  async function buildBackup(selectedEntries,filename){
    const selectedIds=new Set(selectedEntries.map(e=>e.id));const allAttachments=await getAll('attachments');
    const chosen=allAttachments.filter(a=>selectedIds.has(a.entryId));
    const manifest={app:'harugyeol',version:1,exportedAt:new Date().toISOString(),entries:selectedEntries,attachments:chosen.map(({blob,...info})=>({...info,path:`files/${info.id}`}))};
    const items=[{name:'manifest.json',data:encode(JSON.stringify(manifest,null,2))}];
    for(const entry of selectedEntries) {
      const entryFiles=chosen.filter(a=>a.entryId===entry.id);
      items.push({name:`notes/${safeFileName(entry.date+'_'+(entry.title||'제목 없는 기록'))}_${entry.id.slice(0,8)}.md`,data:encode('\uFEFF'+mdOfEntry(entry,entryFiles))});
    }
    for(const file of chosen)items.push({name:`files/${file.id}`,data:new Uint8Array(await file.blob.arrayBuffer())});
    downloadBlob(makeZip(items),`${filename}.zip`);
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
      entries=await getAll('entries');const last=[...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];current=null;await selectEntry(last.id);
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
    for(let i=0;i<pages.length;i++){const c=pages[i],cctx=c.getContext('2d');cctx.fillStyle=col.muted;cctx.font='19px Pretendard, sans-serif';cctx.fillText(`하루결  ·  ${i+1} / ${pages.length}`,left,1685);}
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
  function bindEvents(){
    $('newEntrySidebar').addEventListener('click',()=>newEntry());$('newEntryTop').addEventListener('click',()=>newEntry());
    $('openSidebar').addEventListener('click',openSidebar);$('closeSidebar').addEventListener('click',closeSidebar);el.scrim.addEventListener('click',closeSidebar);
    el.search.addEventListener('input',renderList);
    $('calendarPrev').addEventListener('click',()=>shiftCalendar(-1));
    $('calendarNext').addEventListener('click',()=>shiftCalendar(1));
    $('calendarToday').addEventListener('click',()=>{setCalendarMonth(dayString());renderCalendar();});
    el.calendarGrid.addEventListener('click',async e=>{
      const button=e.target.closest('[data-calendar-date]');
      if(!button)return;
      const date=button.dataset.calendarDate;
      const existing=entries.filter(entry=>entry.date===date).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0];
      if(existing)await selectEntry(existing.id);
      else await newEntry(date);
    });
    el.list.addEventListener('click',e=>{const b=e.target.closest('[data-entry-id]');if(b)selectEntry(b.dataset.entryId);});
    el.date.addEventListener('change',updateDate);el.title.addEventListener('input',queueSave);
    el.body.addEventListener('input',()=>{queueSave();renderPreview();el.charCount.textContent=`${[...el.body.value].length.toLocaleString()}자`;});
    document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>setView(b.dataset.view)));
    document.querySelectorAll('[data-format]').forEach(b=>b.addEventListener('click',()=>formatText(b.dataset.format)));
    document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='s'){e.preventDefault();saveCurrent();toast('기록을 저장했어요.');}if((e.ctrlKey||e.metaKey)&&['b','i'].includes(e.key.toLowerCase())&&document.activeElement===el.body){e.preventDefault();formatText(e.key.toLowerCase()==='b'?'bold':'italic');}});
    $('uploadBtn').addEventListener('click',()=>el.file.click());el.file.addEventListener('change',()=>{addFiles(el.file.files);el.file.value='';});el.record.addEventListener('click',toggleRecording);
    $('deleteEntryBtn').addEventListener('click',async()=>{if(!current||!confirm(`"${current.title||dateText(current.date)}" 기록과 모든 첨부 파일을 삭제할까요?\n삭제한 내용은 복구할 수 없어요.`))return;
      const id=current.id;clearTimeout(saveTimer);saveTimer=null;await savePromise.catch(()=>{});try{await deleteEntryData(id);entries=entries.filter(x=>x.id!==id);current=null;attachments=[];if(entries.length)await selectEntry([...entries].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt))[0].id);else await newEntry();renderList();toast('기록을 삭제했어요.');}catch(e){toast('기록 삭제에 실패했어요.');}});
    $('openExportBtn').addEventListener('click',async()=>{await flushSave();el.exportFilename.value=current?.title.trim()||`${current?.date}_기록`;el.exportProgress.textContent='';el.dialog.showModal();});
    $('closeExportBtn').addEventListener('click',()=>el.dialog.close());el.dialog.addEventListener('click',e=>{if(e.target===el.dialog)el.dialog.close();});
    document.querySelectorAll('[data-export]').forEach(b=>b.addEventListener('click',()=>exportRecord(b.dataset.export)));
    $('backupBtn').addEventListener('click',async()=>{try{await flushSave();await buildBackup([...entries],`일상기록_전체백업_${dayString()}`);toast('전체 기록과 첨부 파일 백업을 저장했어요.');}catch(e){toast(`백업 실패: ${e.message}`);}});
    $('restoreBtn').addEventListener('click',()=>el.restoreInput.click());el.restoreInput.addEventListener('change',async()=>{const file=el.restoreInput.files[0];if(file)await restoreBackup(file);el.restoreInput.value='';});
    window.addEventListener('pagehide',()=>{if(saveTimer)saveCurrent();});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'&&saveTimer)saveCurrent();});
  }
  bindEvents();init();
})();