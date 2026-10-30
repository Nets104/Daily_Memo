-- 일상 기록: Supabase SQL Editor에서 실행
-- 각 사용자의 기록과 파일 메타데이터를 RLS로 분리합니다.

create table if not exists public.diary_entries (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  entry_date date not null,
  title text not null default '',
  body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.diary_attachments (
  user_id uuid not null references auth.users(id) on delete cascade,
  id text not null,
  entry_id text not null,
  file_name text not null,
  content_type text not null,
  file_size bigint not null default 0 check (file_size >= 0),
  storage_path text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, entry_id) references public.diary_entries(user_id, id) on delete cascade,
  unique (user_id, storage_path),
  constraint attachments_own_path check (split_part(storage_path, '/', 1) = user_id::text)
);

create index if not exists diary_entries_user_date_idx on public.diary_entries(user_id, entry_date desc);
create index if not exists diary_attachments_entry_idx on public.diary_attachments(user_id, entry_id);

alter table public.diary_entries enable row level security;
alter table public.diary_attachments enable row level security;
revoke all on public.diary_entries, public.diary_attachments from anon;
revoke all on public.diary_entries, public.diary_attachments from authenticated;
grant select, insert, update, delete on public.diary_entries, public.diary_attachments to authenticated;

drop policy if exists "diary_entries_select_own" on public.diary_entries;
create policy "diary_entries_select_own" on public.diary_entries for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "diary_entries_insert_own" on public.diary_entries;
create policy "diary_entries_insert_own" on public.diary_entries for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "diary_entries_update_own" on public.diary_entries;
create policy "diary_entries_update_own" on public.diary_entries for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "diary_entries_delete_own" on public.diary_entries;
create policy "diary_entries_delete_own" on public.diary_entries for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "diary_attachments_select_own" on public.diary_attachments;
create policy "diary_attachments_select_own" on public.diary_attachments for select to authenticated
  using (user_id = (select auth.uid()));
drop policy if exists "diary_attachments_insert_own" on public.diary_attachments;
create policy "diary_attachments_insert_own" on public.diary_attachments for insert to authenticated
  with check (user_id = (select auth.uid()));
drop policy if exists "diary_attachments_update_own" on public.diary_attachments;
create policy "diary_attachments_update_own" on public.diary_attachments for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "diary_attachments_delete_own" on public.diary_attachments;
create policy "diary_attachments_delete_own" on public.diary_attachments for delete to authenticated
  using (user_id = (select auth.uid()));

insert into storage.buckets (id, name, public, file_size_limit)
values ('diary-media', 'diary-media', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;

drop policy if exists "diary_media_select_own" on storage.objects;
create policy "diary_media_select_own" on storage.objects for select to authenticated
  using (bucket_id = 'diary-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "diary_media_insert_own" on storage.objects;
create policy "diary_media_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'diary-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "diary_media_update_own" on storage.objects;
create policy "diary_media_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'diary-media' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'diary-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "diary_media_delete_own" on storage.objects;
create policy "diary_media_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'diary-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- 미니 다이어리 카드 전용 선택 항목
alter table public.diary_entries add column if not exists short_note text not null default '';
alter table public.diary_entries add column if not exists weather text not null default '';
alter table public.diary_entries add column if not exists cover_attachment_id text;
