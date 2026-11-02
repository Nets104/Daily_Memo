-- Apply with the matching save-diary-attachment Edge Function and cloud.js.
-- File sizes use decimal MB. Existing files remain readable/exportable.
create schema if not exists diary_private;
alter table public.diary_attachments add column if not exists content_hash text;
revoke all on schema diary_private from public, anon;
grant usage on schema diary_private to authenticated, service_role;

create table if not exists diary_private.storage_settings (
  id boolean primary key default true check(id),
  user_limit bigint not null default 250000000 check(user_limit>0),
  daily_limit bigint not null default 10000000 check(daily_limit>0),
  project_warning bigint not null default 800000000 check(project_warning>0),
  warning_ratio numeric not null default 0.8 check(warning_ratio>0 and warning_ratio<1)
);
insert into diary_private.storage_settings(id) values(true) on conflict do nothing;
create table if not exists diary_private.upload_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_id text not null,
  attachment_id text not null,
  entry_date date not null,
  bytes bigint not null check(bytes>0),
  storage_path text not null unique,
  expires_at timestamptz not null default now()+interval '15 minutes'
);
create index if not exists diary_upload_reservations_user_idx
  on diary_private.upload_reservations(user_id, expires_at);
alter table diary_private.storage_settings enable row level security;
alter table diary_private.upload_reservations enable row level security;
revoke all on diary_private.storage_settings, diary_private.upload_reservations from public, anon, authenticated;

create or replace function diary_private.storage_usage(p_day date)
returns jsonb language plpgsql security definer set search_path='' as $$
declare u uuid:=auth.uid(); cfg diary_private.storage_settings; used bigint; daily bigint; total bigint;
begin
  if u is null then raise exception '로그인이 필요해요.'; end if;
  select * into strict cfg from diary_private.storage_settings where id;
  select coalesce(sum((metadata->>'size')::bigint),0) into used from storage.objects
    where bucket_id='diary-media' and split_part(name,'/',1)=u::text;
  select coalesce(sum((o.metadata->>'size')::bigint),0) into daily
    from public.diary_attachments a join public.diary_entries e on e.user_id=a.user_id and e.id=a.entry_id
    join storage.objects o on o.bucket_id='diary-media' and o.name=a.storage_path
    where a.user_id=u and e.entry_date=p_day;
  select coalesce(sum((metadata->>'size')::bigint),0) into total from storage.objects;
  return jsonb_build_object('used_bytes',used,'limit_bytes',cfg.user_limit,
    'daily_used_bytes',daily,'daily_limit_bytes',cfg.daily_limit,'day',p_day,
    'near_limit',used>=cfg.user_limit*cfg.warning_ratio,
    'project_near_limit',total>=cfg.project_warning);
end $$;
revoke all on function diary_private.storage_usage(date) from public, anon;
grant execute on function diary_private.storage_usage(date) to authenticated;
create or replace function public.diary_storage_usage(p_day date)
returns jsonb language sql security invoker set search_path='' as $$
  select diary_private.storage_usage(p_day);
$$;
revoke all on function public.diary_storage_usage(date) from public, anon;
grant execute on function public.diary_storage_usage(date) to authenticated;

-- Only the authenticated Edge Function's service client can reserve/finalize uploads.
-- A per-user transaction lock prevents simultaneous uploads exceeding either limit.
create or replace function diary_private.reserve_upload(p_user uuid,p_entry text,p_attachment text,p_bytes bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg diary_private.storage_settings; d date; used bigint; daily bigint; reserved bigint; daily_reserved bigint;
  rid uuid:=gen_random_uuid(); path text;
begin
  if auth.role()<>'service_role' then raise exception '업로드 서버만 사용할 수 있어요.'; end if;
  if p_bytes<=0 or p_bytes>10000000 then raise exception '파일 하나는 최대 10MB예요.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_user::text,0));
  select entry_date into d from public.diary_entries where user_id=p_user and id=p_entry;
  if d is null then raise exception '기록을 먼저 저장해 주세요.'; end if;
  select * into strict cfg from diary_private.storage_settings where id;
  delete from diary_private.upload_reservations where user_id=p_user and expires_at<now();
  if exists(select 1 from diary_private.upload_reservations where user_id=p_user and attachment_id=p_attachment) then
    raise exception '같은 파일을 저장 중이에요. 잠시 후 다시 시도해 주세요.';
  end if;
  select coalesce(sum((metadata->>'size')::bigint),0) into used from storage.objects
    where bucket_id='diary-media' and split_part(name,'/',1)=p_user::text;
  select coalesce(sum(bytes),0),coalesce(sum(bytes) filter(where entry_date=d),0)
    into reserved,daily_reserved from diary_private.upload_reservations where user_id=p_user;
  select coalesce(sum((o.metadata->>'size')::bigint),0) into daily
    from public.diary_attachments a join public.diary_entries e on e.user_id=a.user_id and e.id=a.entry_id
    join storage.objects o on o.bucket_id='diary-media' and o.name=a.storage_path
    where a.user_id=p_user and e.entry_date=d;
  if used+reserved+p_bytes>cfg.user_limit then raise exception '개인 첨부파일 한도 250MB에 도달했어요. 백업 후 불필요한 기록을 정리해 주세요.'; end if;
  if daily+daily_reserved+p_bytes>cfg.daily_limit then raise exception '이 날짜의 첨부파일 합계는 최대 10MB예요. 같은 날짜의 다른 기록과 썸네일도 포함돼요.'; end if;
  path:=p_user::text||'/'||p_entry||'/'||p_attachment||'/'||rid::text;
  insert into diary_private.upload_reservations(id,user_id,entry_id,attachment_id,entry_date,bytes,storage_path)
    values(rid,p_user,p_entry,p_attachment,d,p_bytes,path);
  return jsonb_build_object('id',rid,'path',path);
end $$;

create or replace function diary_private.finish_upload(p_reservation uuid,p_file_name text,p_content_type text,p_created_at timestamptz,p_content_hash text)
returns text language plpgsql security definer set search_path='' as $$
declare r diary_private.upload_reservations; old_path text; actual bigint;
begin
  if auth.role()<>'service_role' then raise exception '업로드 서버만 사용할 수 있어요.'; end if;
  select * into strict r from diary_private.upload_reservations where id=p_reservation;
  perform pg_advisory_xact_lock(hashtextextended(r.user_id::text,0));
  select * into strict r from diary_private.upload_reservations where id=p_reservation for update;
  if r.expires_at<now() then raise exception '업로드 시간이 만료됐어요. 다시 시도해 주세요.'; end if;
  select (metadata->>'size')::bigint into actual from storage.objects where bucket_id='diary-media' and name=r.storage_path;
  if actual is distinct from r.bytes then raise exception '업로드 파일 용량을 확인하지 못했어요.'; end if;
  select storage_path into old_path from public.diary_attachments where user_id=r.user_id and id=r.attachment_id;
  insert into public.diary_attachments(user_id,id,entry_id,file_name,content_type,file_size,storage_path,created_at,content_hash)
    values(r.user_id,r.attachment_id,r.entry_id,p_file_name,p_content_type,r.bytes,r.storage_path,p_created_at,p_content_hash)
    on conflict(user_id,id) do update set entry_id=excluded.entry_id,file_name=excluded.file_name,
      content_type=excluded.content_type,file_size=excluded.file_size,storage_path=excluded.storage_path,content_hash=excluded.content_hash;
  delete from diary_private.upload_reservations where id=r.id;
  return old_path;
end $$;
create or replace function diary_private.release_upload(p_reservation uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.role()<>'service_role' then raise exception '업로드 서버만 사용할 수 있어요.'; end if;
  delete from diary_private.upload_reservations where id=p_reservation;
end $$;

revoke all on function diary_private.reserve_upload(uuid,text,text,bigint),
  diary_private.finish_upload(uuid,text,text,timestamptz,text),diary_private.release_upload(uuid) from public, anon, authenticated;
grant execute on function diary_private.reserve_upload(uuid,text,text,bigint),
  diary_private.finish_upload(uuid,text,text,timestamptz,text),diary_private.release_upload(uuid) to service_role;
create or replace function public.diary_reserve_upload(p_user uuid,p_entry text,p_attachment text,p_bytes bigint)
returns jsonb language sql security invoker set search_path='' as $$
  select diary_private.reserve_upload(p_user,p_entry,p_attachment,p_bytes);
$$;
create or replace function public.diary_finish_upload(p_reservation uuid,p_file_name text,p_content_type text,p_created_at timestamptz,p_content_hash text)
returns text language sql security invoker set search_path='' as $$
  select diary_private.finish_upload(p_reservation,p_file_name,p_content_type,p_created_at,p_content_hash);
$$;
create or replace function public.diary_release_upload(p_reservation uuid)
returns void language sql security invoker set search_path='' as $$select diary_private.release_upload(p_reservation);$$;
revoke all on function public.diary_reserve_upload(uuid,text,text,bigint),
  public.diary_finish_upload(uuid,text,text,timestamptz,text),public.diary_release_upload(uuid) from public, anon, authenticated;
grant execute on function public.diary_reserve_upload(uuid,text,text,bigint),
  public.diary_finish_upload(uuid,text,text,timestamptz,text),public.diary_release_upload(uuid) to service_role;

-- Moving a diary to another date must not circumvent that date's shared allowance.
create or replace function diary_private.check_entry_date_quota()
returns trigger language plpgsql security definer set search_path='' as $$
declare existing_bytes bigint; moved_bytes bigint; cfg diary_private.storage_settings;
begin
  if new.entry_date=old.entry_date then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended(new.user_id::text,0));
  select * into strict cfg from diary_private.storage_settings where id;
  select coalesce(sum((o.metadata->>'size')::bigint),0) into existing_bytes
    from public.diary_attachments a join public.diary_entries e on e.user_id=a.user_id and e.id=a.entry_id
    join storage.objects o on o.bucket_id='diary-media' and o.name=a.storage_path
    where a.user_id=new.user_id and e.entry_date=new.entry_date and e.id<>new.id;
  select coalesce(sum((o.metadata->>'size')::bigint),0) into moved_bytes
    from public.diary_attachments a join storage.objects o on o.bucket_id='diary-media' and o.name=a.storage_path
    where a.user_id=new.user_id and a.entry_id=new.id;
  select existing_bytes+coalesce(sum(bytes) filter(where entry_date=new.entry_date and entry_id<>new.id),0),
    moved_bytes+coalesce(sum(bytes) filter(where entry_id=new.id),0)
    into existing_bytes,moved_bytes from diary_private.upload_reservations
    where user_id=new.user_id and expires_at>now();
  if moved_bytes>0 and existing_bytes+moved_bytes>cfg.daily_limit then raise exception '이동할 날짜의 첨부파일 합계가 하루 10MB를 넘어요.'; end if;
  update diary_private.upload_reservations set entry_date=new.entry_date where user_id=new.user_id and entry_id=new.id;
  return new;
end $$;
revoke all on function diary_private.check_entry_date_quota() from public, anon, authenticated;
create trigger diary_entry_date_quota before update of entry_date on public.diary_entries
  for each row execute function diary_private.check_entry_date_quota();

-- Disallow unmetered client uploads/metadata writes. Reads and deletes keep existing own-user RLS.
revoke insert,update on public.diary_attachments from authenticated;
create policy diary_media_metered_insert on storage.objects as restrictive for insert to authenticated
  with check(bucket_id<>'diary-media');
create policy diary_media_metered_update on storage.objects as restrictive for update to authenticated
  using(bucket_id<>'diary-media') with check(bucket_id<>'diary-media');
