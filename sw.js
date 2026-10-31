<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="theme-color" content="#E8D8C0" />
  <meta name="description" content="나의 하루를 글, 사진, 영상, 소리로 남기는 개인 기록장" />
  <link rel="manifest" href="./manifest.webmanifest?v=39" />
  <link rel="icon" type="image/png" sizes="192x192" href="./icons/icon-192.png?v=39" />
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css" />
  <link rel="stylesheet" href="./style.css?v=13" />
  <!-- Critical intro layout: keep the splash out of document flow even if cached CSS is stale. -->
  <style>
    #startupIntro{position:fixed;inset:0;z-index:120;display:grid;place-items:center;box-sizing:border-box;padding:22px;background:#f3e5d0;text-align:center;color:#4b3528;font-family:Pretendard,sans-serif}
    #startupIntro .intro-card{width:min(100%,410px);margin:auto;text-align:center}
    #startupIntro .intro-card h1{font-size:clamp(32px,7vw,48px);line-height:1.3;margin:12px 0}
    #startupIntro .intro-flower{position:absolute;top:-50px;left:-70px;width:350px;height:350px;background:url("./assets/vintage-flowers.svg") no-repeat center/contain;pointer-events:none}
    #startupIntro.is-finished{opacity:0;visibility:hidden;pointer-events:none}
    #startupIntro[hidden]{display:none!important}
  </style>
  <link rel="stylesheet" href="./vintage.css?v=42" />
  <title>일상 기록</title>
</head>
<body>
  <div class="startup-intro" id="startupIntro" aria-hidden="true">
    <div class="intro-flower" aria-hidden="true"></div>
    <div class="intro-card">
      <p class="intro-overline">A LITTLE MOMENT, EVERY DAY</p>
      <span class="intro-emblem" aria-hidden="true">✿</span>
      <h1>일상 기록<span>✦</span></h1>
      <p>평범한 날의 작은 조각들</p>
      <div class="intro-loading" aria-hidden="true"><span></span><span></span><span></span></div>
    </div>
  </div>
  <section id="cloudAuth" class="auth-paper" hidden aria-label="계정 로그인 및 회원가입">
    <div class="auth-decor" aria-hidden="true">✿</div>
    <div id="cloudLoginPanel">
      <p class="auth-eyebrow">MY LITTLE MEMORY BOOK</p>
      <h1>일상 기록<span>✦</span></h1>
      <p class="auth-intro">나만의 기록을 안전하게 보관하세요.</p>
      <form id="cloudAuthForm" class="auth-form">
        <label for="cloudEmail">이메일</label>
        <input id="cloudEmail" type="email" maxlength="254" required autocomplete="username" placeholder="이메일 주소">
        <label for="cloudPassword">비밀번호</label>
        <input id="cloudPassword" type="password" required minlength="6" maxlength="128" autocomplete="current-password" placeholder="비밀번호">
        <button type="submit" class="primary-button" id="cloudLogin">로그인</button>
      </form>
      <div class="auth-switch">아직 계정이 없나요?
        <button type="button" class="auth-text-button" id="cloudSignup">회원가입</button>
      </div>
      <div class="guest-entry">
        <button type="button" class="outlined-button" id="guestLogin">회원가입 없이 이용하기</button>
        <p>비회원 기록은 이 기기에만 저장되며, 서버 동기화는 지원하지 않아요.</p>
      </div>
    </div>
    <div id="cloudSignupEmailPanel" hidden>
      <p class="auth-eyebrow">SIGN UP · 1 / 2</p>
      <h2>이메일 인증</h2>
      <p class="auth-intro">Gmail 등 사용할 이메일을 입력하고, 받은 메일의 인증 링크를 눌러 주세요.</p>
      <form id="cloudSignupEmailForm" class="auth-form">
        <label for="cloudSignupEmail">인증할 이메일 주소</label>
        <input id="cloudSignupEmail" type="email" maxlength="254" required autocomplete="email" placeholder="example@gmail.com">
        <button type="submit" class="primary-button" id="cloudSignupEmailSend">인증 메일 보내기</button>
      </form>
      <p class="auth-help">이메일 인증을 완료하면 아이디와 비밀번호를 만들 수 있어요. 메일이 없다면 스팸함도 확인해 주세요.</p>
      <button type="button" class="auth-text-button" id="cloudSignupBack">로그인으로 돌아가기</button>
    </div>
    <div id="cloudSignupFinishPanel" hidden>
      <p class="auth-eyebrow">SIGN UP · 2 / 2</p>
      <h2>아이디와 비밀번호 설정</h2>
      <p class="auth-verified">✓ 인증된 이메일 <strong id="cloudVerifiedEmail"></strong></p>
      <form id="cloudSignupFinishForm" class="auth-form">
        <label for="cloudUsername">아이디</label>
        <div class="auth-username-row">
          <input id="cloudUsername" type="text" minlength="4" maxlength="12" required autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="영문·숫자 4~12자">
          <button type="button" class="outlined-button" id="cloudUsernameCheck">중복확인</button>
        </div>
        <p id="cloudUsernameStatus" class="auth-field-status" role="status"></p>
        <label for="cloudNewPassword">비밀번호</label>
        <input id="cloudNewPassword" type="password" minlength="8" maxlength="16" required autocomplete="new-password" placeholder="영문·숫자·특수문자 8~16자">
        <label for="cloudNewPasswordConfirm">비밀번호 확인</label>
        <input id="cloudNewPasswordConfirm" type="password" minlength="8" maxlength="16" required autocomplete="new-password" placeholder="비밀번호 다시 입력">
        <button type="submit" class="primary-button" id="cloudSignupComplete">회원가입 완료</button>
      </form>
      <p class="auth-help">아이디는 영문·숫자 4~12자, 비밀번호는 영문·숫자·특수문자 8~16자예요. 한글은 사용할 수 없어요.</p>
      <button type="button" class="auth-text-button" id="cloudSignupCancel">가입 취소</button>
    </div>
    <p id="cloudAuthStatus" role="status" class="auth-message" aria-live="polite"></p>
  </section>
  <div class="app-shell" id="diaryApp" hidden>
    <aside class="sidebar" id="sidebar" aria-label="기록 목록">
      <div class="sidebar-top">
        <div class="brand"><span class="brand-mark" aria-hidden="true">✦</span><span>일상 기록<span class="brand-dot">.</span></span></div>
        <button class="icon-button mobile-close" id="closeSidebar" title="메뉴 닫기" aria-label="메뉴 닫기">☰</button>
      </div>
      <p class="brand-subtitle">평범한 날의 작은 조각들</p>
      <button class="primary-button full" id="newEntrySidebar"><span>＋</span> 새로운 기록</button>
      <button type="button" class="sidebar-option" id="openCalendarPage"><span class="sidebar-calendar-icon" aria-hidden="true">▦</span><span>캘린더</span></button><div class="sidebar-search"><span aria-hidden="true">⌕</span><input type="search" id="searchInput" maxlength="50" placeholder="날짜 · 제목 · 본문 검색" aria-label="기록 검색" /></div>
      <section class="calendar-card" aria-label="월별 기록 달력">
        <div class="calendar-header">
          <button type="button" class="calendar-arrow" id="calendarPrev" aria-label="이전 달">‹</button>
          <strong id="calendarMonthLabel" aria-live="polite"></strong>
          <button type="button" class="calendar-arrow" id="calendarNext" aria-label="다음 달">›</button>
          <button type="button" class="calendar-today" id="calendarToday">오늘</button>
        </div>
        <div class="calendar-weekdays" aria-hidden="true"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div>
        <div class="calendar-grid" id="calendarGrid" role="group" aria-label="날짜 선택"></div>
        <p class="calendar-legend"><span class="calendar-legend-dot"></span> 저장된 날 · 빈 날짜는 저장 전까지 추가되지 않아요</p>
      </section>
      <div class="list-heading"><span>나의 기록</span><span class="list-count" id="entryCount">0</span></div>
      <div class="entry-list" id="entryList" aria-label="저장된 기록"></div>
      <div class="sidebar-bottom">
        <div id="cloudAccount" hidden style="padding:8px 8px 12px;font-size:11px;color:#6b6195">
          <div id="cloudUserEmail" style="overflow-wrap:anywhere"></div>
          <button id="cloudImport" class="sidebar-option" type="button">이 기기의 기존 기록 가져오기</button>
          <button id="cloudLogout" class="sidebar-option" type="button">로그아웃</button>
        </div>
        <section class="month-manage" aria-label="월별 기록 관리">
  <strong>월별 백업 · 정리</strong>
  <p class="archive-month-description">백업하거나 삭제할 달을 선택하세요.</p>
  <input type="month" id="archiveMonth" aria-label="월별 백업 및 삭제할 달 선택" />
  <button type="button" id="archiveMonthBtn" class="sidebar-option">월별 ZIP 백업</button>
  <button type="button" id="deleteMonthBtn" class="sidebar-option archive-delete-button">선택한 월 기록 삭제</button>
  <p id="archiveStatus" role="status">백업은 선택 사항이에요. 삭제한 기록은 복구할 수 없어요.</p>
</section>
        <button class="sidebar-option" id="backupBtn"><span>⇩</span> 전체 백업 ZIP</button>
        <button class="sidebar-option" id="restoreBtn"><span>↥</span> 백업 불러오기</button>
        <input id="restoreInput" type="file" accept=".zip,application/zip" hidden />
        <p>로그인한 계정의 기록은 서버에 저장됩니다. 월별 ZIP 백업을 정기적으로 보관하세요.</p>
      </div>
    </aside>
    <div class="sidebar-scrim" id="sidebarScrim"></div>
    <main class="main-panel">
      <header class="topbar">
        <div class="topbar-left">
          <button class="icon-button mobile-menu" id="openSidebar" title="달력 및 기록 목록" aria-label="달력 및 기록 목록">☰</button>
          <span class="topbar-breadcrumb">MY JOURNAL <span>/</span> <strong>오늘의 기록</strong></span>
        </div>
        <div class="topbar-right">
          <span class="save-state" id="saveState" role="status"><span class="save-dot"></span> 저장됨</span>
          <button type="button" class="outlined-button save-entry-btn" id="saveEntryBtn">저장</button>
          <button class="outlined-button top-new" id="newEntryTop">＋ 새 기록</button>
          <button class="primary-button export-main" id="openExportBtn">내보내기 <span>↗</span></button>
        </div>
      </header>
      <div class="page-wrap"><section id="homePage" class="home-dashboard" aria-label="홈">
  <div class="home-hero">
    <div class="home-hero-flower" aria-hidden="true"></div>
    <p class="eyebrow">MY LITTLE MEMORY BOOK</p>
    <span class="home-vintage-stamp" aria-hidden="true">✦ &nbsp; DAILY NOTES &nbsp; ✦</span>
    <h1>소중한 오늘을<br><em>한 장의 추억으로.</em></h1>
    <p>작은 순간도 오래도록 남을 수 있도록,<br>나만의 일상을 기록해요.</p>
    <span class="home-hero-caption" aria-hidden="true">Keep the little things ♡</span>
  </div>
  <div class="home-stats">
    <div><span>오늘</span><strong id="homeTodayLabel"></strong></div>
    <div><span>나의 기록</span><strong id="homeEntryCount">0개</strong></div>
  </div>
  <div class="home-actions">
    <button type="button" class="primary-button" id="homeWrite">✎ 일기 작성</button>
    <button type="button" class="outlined-button" id="homeCalendar">▦ 캘린더 보기</button>
  </div>
  <section class="home-recent">
    <h2>최근 기록</h2>
    <button type="button" id="homeRecent" class="home-recent-entry" hidden>
      <span id="homeRecentDate"></span><strong id="homeRecentTitle"></strong>
      <small>기록 이어서 보기 ›</small>
    </button>
    <p id="homeEmpty" class="home-empty">아직 저장된 기록이 없어요. 첫 이야기를 남겨보세요.</p>
  </section>
</section>
<section id="myPage" class="my-page" hidden aria-label="마이페이지">
  <div class="my-paper-heading"><span>✿ MY PAGE</span><h1>마이페이지</h1><p>소중한 기록을 관리해요.</p></div>
  <section class="my-info-card">
    <span>현재 계정</span><strong id="myPageEmail">기기 내 기록</strong>
    <span>저장된 일기</span><strong id="myPageCount">0개</strong>
  </section>
  <div class="my-actions">
    <button type="button" class="outlined-button" id="myPageBackup">⇩ 전체 기록 ZIP 백업</button>
    <button type="button" class="outlined-button" id="myPageArchive">▦ 월별 백업 · 정리</button>
    <button type="button" class="outlined-button" id="myPageLogout" hidden>로그아웃</button>
    <button type="button" class="outlined-button" id="myPageSignIn" hidden>로그인 · 회원가입</button>
  </div>
  <section class="account-danger" id="myPageDanger" hidden>
    <h2>계정 관리</h2>
    <p>탈퇴 시 서버에 저장된 모든 일기와 첨부파일, 계정이 영구 삭제돼요.</p>
    <button type="button" class="account-delete-button" id="myPageDelete">회원 탈퇴</button>
  </section>
  <p class="my-hint">기존 기록과 첨부 파일은 계정 또는 기기 저장소에 그대로 보관돼요.</p>
</section><section id="calendarPage" class="mini-calendar-page" hidden><header class="mini-calendar-header"><h2>캘린더</h2><button type="button" id="returnEditor" class="outlined-button">일기 작성</button></header><nav class="mini-calendar-toolbar"><button type="button" id="miniPrev">‹</button><strong id="miniYear"></strong><strong id="miniMonth"></strong><button type="button" id="miniNext">›</button><button type="button" id="miniToday">오늘</button></nav><div class="mini-calendar-weekdays"><span>일</span><span>월</span><span>화</span><span>수</span><span>목</span><span>금</span><span>토</span></div><div class="mini-calendar-grid" id="miniGrid"></div>
          <p class="mini-hint">날짜를 누르면 사진과 한마디를 추가할 수 있어요.</p></section><div id="editorPage" hidden>
        <section class="page-intro">
          <div><p class="eyebrow">A LITTLE MOMENT, EVERY DAY</p><h1>오늘을 <em>기록</em>하다<span class="sparkle">✳</span></h1><p class="intro-desc">매일의 장면과 마음을 나만의 방식으로 남겨요.</p></div>
          <div class="date-sticker" aria-hidden="true"><span id="stickerMonth">OCT</span><strong id="stickerDay">31</strong><small id="stickerWeek">SATURDAY</small></div>
        </section>
        <section class="editor-card" aria-label="일기 편집기">
          <div class="entry-meta-area">
            <button type="button" class="entry-meta-card" id="openMetaDialog" aria-label="날짜, 날씨, 오늘의 한마디 함께 수정">
              <span class="entry-meta-top">
                <strong class="entry-meta-date" id="dateDisplay">날짜 선택</strong>
                <strong class="entry-meta-weather" id="metaWeatherText">선택하지 않음</strong>
                <span class="entry-meta-arrow" aria-hidden="true">›</span>
              </span>
              <span class="entry-meta-note">
                <span class="entry-meta-label">오늘의 한마디</span>
                <strong class="entry-meta-value" id="metaNoteText">오늘의 한마디를 남겨주세요</strong>
              </span>
            </button>
            <span class="edited-at" id="editedAt"></span>
          </div>
          <div class="title-row"><input type="text" id="entryTitle" maxlength="30" placeholder="오늘의 제목을 적어주세요" aria-label="기록 제목" /></div><div class="title-count" id="titleCount" aria-live="off">0 / 30자</div>
          <div class="editor-divider"></div>
          <div class="editor-controls">
            <div class="view-tabs" role="group" aria-label="보기 모드"><button data-view="edit" class="active">작성</button><button data-view="preview">미리보기</button><button data-view="split">나란히</button></div>
            <span class="editor-hint">Markdown 지원 <span class="kbd-hint">Ctrl + S</span></span>
          </div>
          <div class="format-toolbar" role="toolbar" aria-label="마크다운 서식">
            <button data-format="h1" title="큰 제목">H1</button><button data-format="h2" title="작은 제목">H2</button><span class="toolbar-divider"></span>
            <button data-format="bold" class="bold-format" title="굵게 (Ctrl+B)">B</button><button data-format="italic" class="italic-format" title="기울임 (Ctrl+I)">I</button><button data-format="underline" class="underline-format" title="밑줄">U</button><button data-format="strike" class="strike-format" title="취소선">S</button><span class="toolbar-divider"></span>
            <button data-format="bullet" title="글머리 목록">≡</button><button data-format="number" title="번호 목록">1.</button><button data-format="check" title="체크 목록">☑</button><button data-format="quote" title="인용">❝</button><button data-format="rule" title="구분선">―</button><button data-format="link" title="링크">↗</button><button data-format="code" title="인라인 코드">&lt;/&gt;</button>
          </div>
          <div class="writing-area view-edit" id="writingArea">
            <div class="editing-pane"><label class="sr-only" for="entryBody">마크다운 본문</label><textarea id="entryBody" maxlength="1500" spellcheck="true" placeholder="오늘은 어떤 하루였나요?\n\n작은 일 하나, 문득 든 생각 하나도 좋아요.\n\n- 오늘 있었던 일\n- 기억하고 싶은 순간\n- 내일의 나에게"></textarea></div>
            <div class="preview-pane" id="previewPane"><div class="md-preview" id="mdPreview"><p class="preview-placeholder">여기에 기록한 내용이 보여요 ✨</p></div></div>
          </div>
          <div class="word-info"><span id="charCount">0 / 1,500자</span><span>글과 사진이 모두 오늘의 기록이 돼요.</span></div>
          <div class="attachments-section">
            <div class="section-label"><div><span class="section-glyph">✿</span> 첨부 파일 <span class="attachment-count" id="attachmentCount">0</span></div><span>사진 · 영상 · 오디오 · PDF</span></div>
            <div class="upload-actions"><button class="attach-button" id="uploadBtn">＋ 파일 추가</button><button class="attach-button secondary" id="recordBtn"><span aria-hidden="true">●</span> <span id="recordBtnText">음성 녹음</span></button><input type="file" id="fileInput" accept="image/*,video/*,audio/*,.pdf,application/pdf" multiple hidden /></div>
            <div id="attachmentList" class="scrapbook-attachments"></div>
            <p class="upload-tip">로그인 시 파일은 계정별 비공개 서버에 저장됩니다. 사진 최대 10장(각 5MB) · 영상 30MB · 음성/PDF 10MB 이하로 첨부할 수 있어요. 캘린더 썸네일은 사진 개수에서 제외돼요.</p>
          </div>
          <div class="record-delete-area"><span>이 기록과 첨부파일 전체를 삭제합니다.</span><button type="button" class="delete-button record-delete-button" id="deleteEntryBtn" title="현재 기록 전체 삭제" aria-label="현재 기록 전체 삭제">이 일기 전체 삭제</button></div>
        </section>
        <footer class="footer-note"><span>✦</span> Keep your days, keep your story. <span>✦</span></footer></div>
      </div>
    </main>
    <nav class="bottom-tabs" id="bottomTabs" aria-label="화면 이동">
  <button type="button" data-tab="home" aria-current="page"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5V21h-6v-7H9v7H3z"/></svg><span>홈</span></button>
  <button type="button" data-tab="calendar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2M8 18h2"/></svg><span>캘린더</span></button>
  <button type="button" data-tab="diary"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h14v18H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3zM6 3v18M10 8h6M10 12h6"/></svg><span>일기</span></button>
  <button type="button" data-tab="mypage"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4.5 21c0-4 3.1-7 7.5-7s7.5 3 7.5 7"/></svg><span>마이페이지</span></button>
</nav>
  </div>
  <dialog id="exportDialog" class="export-dialog">
    <div class="dialog-heading"><div><p class="eyebrow">SAVE THIS MOMENT</p><h2>기록 내보내기</h2></div><button class="icon-button" id="closeExportBtn" aria-label="닫기">✕</button></div>
    <label class="dialog-label" for="exportFilename">파일 이름 <small>(기록 제목은 변경되지 않아요)</small></label><input class="dialog-input" type="text" id="exportFilename" maxlength="30" placeholder="파일 이름" />
    <p class="export-help">PDF·PNG는 빈티지 다이어리 디자인으로 내보내요. Markdown은 텍스트, ZIP은 원본 첨부파일 보관용이에요.</p>
    <div class="export-options">
      <button data-export="md"><span class="export-icon md-icon">MD</span><span><strong>Markdown</strong><small>.md 텍스트 파일</small></span><span class="option-arrow">↗</span></button>
      <button data-export="png"><span class="export-icon png-icon">▧</span><span><strong>빈티지 이미지</strong><small>.png · 다이어리 페이지</small></span><span class="option-arrow">↗</span></button>
      <button data-export="pdf"><span class="export-icon pdf-icon">PDF</span><span><strong>빈티지 PDF</strong><small>.pdf · A4 다이어리</small></span><span class="option-arrow">↗</span></button>
      <button data-export="zip"><span class="export-icon zip-icon">ZIP</span><span><strong>기록 + 첨부 파일</strong><small>.zip · 원본 미디어 포함</small></span><span class="option-arrow">↗</span></button>
    </div>
    <div class="export-progress" id="exportProgress" aria-live="polite"></div>
  </dialog>
  <dialog id="entryMetaDialog" class="entry-meta-dialog" aria-labelledby="entryMetaTitle" tabindex="-1">
    <div class="day-card-header">
      <h2 id="entryMetaTitle">오늘의 기록 수정</h2>
      <button type="button" class="icon-button" id="entryMetaClose" aria-label="닫기">✕</button>
    </div>
    <div class="entry-meta-form">
      <label for="entryDate">날짜 <span class="required">*</span></label>
      <input type="date" id="entryDate" required />
      <label for="entryWeather">날씨</label>
      <select id="entryWeather">
        <option value="">선택하지 않음</option>
        <option value="sunny">☀️ 맑음</option>
        <option value="partly_cloudy">🌤️ 구름 조금</option>
        <option value="cloudy">☁️ 흐림</option>
        <option value="rain">🌧️ 비</option>
        <option value="snow">❄️ 눈</option>
        <option value="wind">💨 바람</option>
        <option value="other">🌈 기타</option>
      </select>
      <label for="entryShortNote" class="entry-note-label">오늘의 한마디 (최대 20자)</label>
      <textarea id="entryShortNote" maxlength="20" rows="4" placeholder="오늘을 한 줄로 남겨요"></textarea>
      <small class="entry-note-count" id="entryMetaCount" aria-live="off">0/20</small>
      <label class="calendar-title-toggle"><input id="entryMetaShowTitle" type="checkbox" /><span>캘린더에 한마디 대신 일기 제목 표시</span></label>
      <p id="entryMetaStatus" class="day-card-status" role="status"></p>
      <div class="entry-meta-buttons">
        <button type="button" id="entryMetaCancel" class="outlined-button">취소</button>
        <button type="button" id="entryMetaSave" class="primary-button">적용</button>
      </div>
    </div>
  </dialog>
  <dialog id="dayCardDialog" class="day-card-dialog" aria-labelledby="dayCardTitle">
    <div class="day-card-header">
      <h2 id="dayCardTitle">날짜의 기록</h2>
      <button type="button" id="dayCardClose" class="icon-button" aria-label="편집창 닫기">✕</button>
    </div>
    <div class="day-card-content">
      <button id="dayPhotoBtn" type="button" class="day-photo-select">＋ 썸네일 사진 추가 / 변경</button>
      <input id="dayPhotoInput" type="file" accept="image/*" hidden />
      <div id="dayExistingPhoto" class="day-existing-photo" hidden></div>
       <button id="dayDeletePhoto" class="day-delete-photo" type="button" hidden>✕ 썸네일 삭제</button>
      <div id="dayCropSection" class="day-crop-section" hidden>
        <p class="day-card-help">사진을 드래그하고 확대·축소해 정사각형으로 맞추세요. 여백은 베이지색으로 채워져요.</p>
        <canvas id="dayCropCanvas" width="480" height="480" aria-label="캘린더와 동일한 1대1 정사각형 썸네일 미리보기"></canvas>
        <label for="dayCropZoom">사진 확대</label>
        <input id="dayCropZoom" type="range" min=".5" max="3" step=".05" value="1" />
      </div>
      <label class="day-card-label" for="dayCardNote">사진 밑에 표시할 한마디 <small>(최대 20자)</small></label>
      <input id="dayCardNote" type="text" maxlength="20" placeholder="오늘은 어떤 하루였나요?" />
      <label class="calendar-title-toggle"><input id="dayCardShowTitle" type="checkbox" /><span>한마디 대신 일기 제목 표시</span></label>
      <p id="dayCardStatus" role="status" class="day-card-status"></p>
      <div class="day-card-actions">
        <button type="button" id="dayOpenEntry" class="outlined-button">일기 보기 / 작성</button>
        <button type="button" id="dayCardSave" class="primary-button">저장</button>
      </div>
    </div>
  </dialog>
  <dialog id="accountDeleteDialog" class="account-delete-dialog" aria-labelledby="accountDeleteTitle">
    <h2 id="accountDeleteTitle">회원 탈퇴</h2>
    <div class="account-delete-warning" role="alert">
      <strong>계정과 서버의 모든 기록이 영구 삭제됩니다.</strong>
      <p>일기, 사진·영상·녹음·캘린더 썸네일, 아이디가 삭제되며 복구할 수 없어요. 필요하다면 탈퇴 전에 ZIP으로 백업하세요.</p>
    </div>
    <form id="accountDeleteForm" class="account-delete-form">
      <label for="accountDeletePassword">현재 비밀번호 확인</label>
      <input id="accountDeletePassword" type="password" autocomplete="current-password" required maxlength="128" placeholder="현재 계정 비밀번호" />
      <label for="accountDeletePhrase">확인 문구</label>
      <p>아래에 <strong>탈퇴합니다</strong>를 똑같이 입력해 주세요.</p>
      <input id="accountDeletePhrase" type="text" autocomplete="off" required maxlength="12" placeholder="탈퇴합니다" />
      <p class="account-delete-status" id="accountDeleteStatus" role="status"></p>
      <div class="account-delete-buttons">
        <button type="button" class="outlined-button" id="accountDeleteCancel">취소</button>
        <button type="submit" class="account-delete-confirm" id="accountDeleteConfirm" disabled>계정 영구 삭제</button>
      </div>
    </form>
  </dialog>
  <dialog id="monthDeleteDialog" class="month-delete-dialog" aria-labelledby="monthDeleteTitle">
    <h2 id="monthDeleteTitle">월별 기록 영구 삭제</h2>
    <p class="month-delete-warning" role="alert">
      <strong>주의! 삭제된 기록과 첨부파일은 복구할 수 없습니다.</strong>
      <span id="monthDeleteDescription"></span>
    </p>
    <p class="month-delete-hint">백업 여부와 관계없이 삭제할 수 있습니다. 확인을 위해 아래에 삭제할 연월을 직접 입력하세요.</p>
    <label for="monthDeleteVerification">삭제할 연월 입력 (예: 2026-10)</label>
    <input id="monthDeleteVerification" type="text" autocomplete="off" inputmode="numeric" placeholder="YYYY-MM" maxlength="7" />
    <div class="month-delete-actions">
      <button type="button" class="outlined-button" id="monthDeleteCancel">취소</button>
      <button type="button" class="month-delete-confirm" id="monthDeleteConfirm" disabled>영구 삭제</button>
    </div>
  </dialog>
  <dialog id="photoPreviewDialog" class="photo-preview-dialog" aria-label="첨부 원본 사진 크게 보기">
    <button id="photoPreviewClose" type="button" class="photo-preview-close" aria-label="사진 닫기">✕</button>
    <img id="photoPreviewImage" alt="확대된 첨부 사진" />
  </dialog>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <script src="./supabase-config.js" defer></script>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0" defer></script>
  <script src="./cloud.js?v=16" defer></script>
  <script src="./app.js?v=42" defer></script>
</body>
</html>