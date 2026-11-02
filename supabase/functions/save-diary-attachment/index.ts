import { createClient } from 'npm:@supabase/supabase-js@2.118.0';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, message: string, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ message, ...extra }), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply(405, '지원하지 않는 요청이에요.');
  const token = req.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!token) return reply(401, '로그인이 필요해요.');
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth, error: authError } = await admin.auth.getUser(token);
  if (authError || !auth.user) return reply(401, '로그인 정보를 다시 확인해 주세요.');

  let reservation: { id: string; path: string } | null = null;
  let finalized = false;
  try {
    if (Number(req.headers.get('Content-Length') || 0) > 10_100_000)
      return reply(413, '파일 하나는 최대 10MB예요.');
    const form = await req.formData();
    const file = form.get('file');
    const metadata = JSON.parse(String(form.get('metadata') || '{}'));
    if (!(file instanceof File) || !file.size) return reply(400, '저장할 파일이 없어요.');
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(metadata.id || '') ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(metadata.entryId || ''))
      return reply(400, '기록 또는 파일 정보가 올바르지 않아요.');
    const type = file.type.toLowerCase();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const magic = new TextDecoder('latin1').decode(bytes.subarray(0, 16));
    const gif = /^GIF8[79]a/.test(magic);
    // Reject video MIME types/extensions and common MP4/QuickTime/WebM containers.
    if (type.startsWith('video/') || /\.(mp4|mov|m4v|mkv|avi|3gp|webm)$/i.test(file.name) && !type.startsWith('audio/') ||
        magic.startsWith('RIFF') && magic.slice(8, 12) === 'AVI ')
      return reply(400, '영상 업로드는 지원하지 않아요. 사진·GIF·음성·PDF를 선택해 주세요.');
    const image = type.startsWith('image/');
    const audio = type.startsWith('audio/');
    if (!image && !audio && type !== 'application/pdf')
      return reply(400, '사진·GIF·음성·PDF만 저장할 수 있어요.');
    if (image && !gif && !((bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
        (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) ||
        magic.startsWith('RIFF') && magic.slice(8, 12) === 'WEBP'))
      return reply(400, '사진은 JPG·PNG·WebP 또는 GIF 형식으로 선택해 주세요.');
    if (gif && !image) return reply(400, 'GIF 파일 형식을 확인해 주세요.');
    const limit = gif ? 2_000_000 : image ? 1_000_000 : 10_000_000;
    if (file.size > limit) return reply(413, gif ? 'GIF는 원본 2MB까지 올릴 수 있어요.' : image ?
      '사진은 압축 후 1MB까지 저장할 수 있어요.' : '음성·PDF는 최대 10MB예요.');
    const createdAt = new Date(metadata.createdAt || Date.now());
    if (!Number.isFinite(createdAt.getTime())) return reply(400, '파일 날짜 정보가 올바르지 않아요.');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const hash = [...digest].map(n => n.toString(16).padStart(2, '0')).join('');
    const existing = await admin.from('diary_attachments').select('content_hash,entry_id,file_name,content_type')
      .eq('user_id', auth.user.id).eq('id', metadata.id).maybeSingle();
    if (existing.error) throw Error('기존 파일을 확인하지 못했어요.');
    if (existing.data?.content_hash === hash && existing.data.entry_id === metadata.entryId &&
        existing.data.file_name === String(metadata.name || file.name).slice(0, 500) &&
        existing.data.content_type === (gif ? 'image/gif' : type))
      return reply(200, '이미 저장된 첨부파일이에요.', { success: true });
    const reserved = await admin.rpc('diary_reserve_upload', {
      p_user: auth.user.id, p_entry: metadata.entryId, p_attachment: metadata.id, p_bytes: file.size,
    });
    if (reserved.error) return reply(409, reserved.error.message);
    reservation = reserved.data;
    if (!reservation?.id || !reservation.path) throw Error('업로드 공간을 준비하지 못했어요.');
    const uploaded = await admin.storage.from('diary-media').upload(reservation.path, bytes, {
      contentType: gif ? 'image/gif' : type, upsert: false,
    });
    if (uploaded.error) throw Error('파일 업로드에 실패했어요. 다시 시도해 주세요.');
    const finished = await admin.rpc('diary_finish_upload', {
      p_reservation: reservation.id, p_file_name: String(metadata.name || file.name).slice(0, 500),
      p_content_type: gif ? 'image/gif' : type, p_created_at: createdAt.toISOString(),
      p_content_hash: hash,
    });
    if (finished.error) throw Error(finished.error.message);
    finalized = true;
    if (finished.data && finished.data !== reservation.path) {
      const cleanup = await admin.storage.from('diary-media').remove([finished.data]);
      if (cleanup.error) console.error('Previous attachment cleanup failed', cleanup.error.message);
    }
    return reply(200, '첨부파일을 저장했어요.', { success: true });
  } catch (error) {
    return reply(400, error instanceof Error ? error.message : '파일을 저장하지 못했어요.');
  } finally {
    if (reservation && !finalized) {
      const cleanup = await admin.storage.from('diary-media').remove([reservation.path]);
      // Keep the reservation until expiry if storage cleanup failed, to avoid undercounting.
      if (!cleanup.error) await admin.rpc('diary_release_upload', { p_reservation: reservation.id });
      else console.error('Incomplete attachment cleanup failed', cleanup.error.message);
    }
  }
});
