-- The whole schema /api/cron/sync writes and /api/data reads. Run in the
-- Supabase SQL editor (Dashboard -> SQL Editor -> New query -> Run).
--
-- Safe to re-run and safe on a fresh project: every statement is IF NOT
-- EXISTS, and the two tables are created before anything alters them. This
-- file used to be ALTERs only, which meant it failed outright against a
-- project where the tables had never been created -- the exact situation
-- where someone would reach for it.
--
-- Existing rows get the defaults below and are backfilled with real numbers
-- the next time /api/cron/sync runs.

-- ---------------------------------------------------------------- tables
-- One row per campaign/audience/creative per day. Only the columns the
-- original sync wrote are here; everything added later is an ALTER below,
-- so this block stays identical to what an older project already has.
create table if not exists daily_spend (
  date               date   not null,
  campaign           text,
  audience           text,
  creative           text,
  landing_page       text,
  spend              numeric not null default 0,
  clicks             bigint  not null default 0,
  landing_page_views bigint  not null default 0,
  updated_at         timestamptz not null default now()
);

-- sync upserts with onConflict 'date,campaign,audience,creative', which
-- needs a matching unique index or the write fails. NULLS NOT DISTINCT
-- matters: campaign/audience/creative are null on some rows, and by default
-- Postgres treats each null as unique, so those rows would insert a
-- duplicate on every run instead of updating. (Needs Postgres 15+; on
-- older versions drop that clause and accept the duplicates.)
create unique index if not exists daily_spend_key
  on daily_spend (date, campaign, audience, creative) nulls not distinct;

-- Opt-ins and bookings share this table, told apart by `kind` below. id is
-- built by stableId() in lib/sources.js and is what the upsert conflicts
-- on, so it has to be the primary key.
create table if not exists leads (
  id             text primary key,
  generated_date date not null,
  campaign       text,
  audience       text,
  creative       text,
  landing_page   text,
  attended       boolean not null default false,
  updated_at     timestamptz not null default now()
);

-- ------------------------------------------------------------- additions
-- Meta metrics that fetchMetaInsights has always requested but that had
-- nowhere to be stored, so only spend and clicks ever reached the dashboard.
alter table daily_spend add column if not exists impressions        bigint  not null default 0;
alter table daily_spend add column if not exists reach              bigint  not null default 0;
alter table daily_spend add column if not exists inline_link_clicks bigint  not null default 0;
alter table daily_spend add column if not exists outbound_clicks    bigint  not null default 0;

-- Video engagement. video_plays is Meta's "3-second video plays", the
-- numerator for hook rate; the quartiles show where viewers drop off.
alter table daily_spend add column if not exists video_plays        bigint  not null default 0;
alter table daily_spend add column if not exists video_p25          bigint  not null default 0;
alter table daily_spend add column if not exists video_p50          bigint  not null default 0;
alter table daily_spend add column if not exists video_p75          bigint  not null default 0;
alter table daily_spend add column if not exists video_p95          bigint  not null default 0;
alter table daily_spend add column if not exists video_thruplay     bigint  not null default 0;

-- Meta's own relative rankings against comparable advertisers. Text, not
-- numeric: 'ABOVE_AVERAGE', 'AVERAGE', 'BELOW_AVERAGE_35' and so on, or null
-- when an ad has too few impressions to be rated.
alter table daily_spend add column if not exists quality_ranking          text;
alter table daily_spend add column if not exists engagement_rate_ranking  text;
alter table daily_spend add column if not exists conversion_rate_ranking  text;

-- Which tab of the opt-in workbook a lead came from. That tab is the lead
-- magnet, and currently the only evidence of which campaign produced the
-- lead, so it is worth keeping even once a campaign has been mapped to it.
alter table leads add column if not exists source_tab text;

-- A row in `leads` is now one of two very different things: an 'optin' (a
-- guide download, top of funnel) or a 'booking' (a meeting booked, the
-- qualified lead that cost per lead is measured against). Conflating them
-- understates CPL by counting every download as a lead.
alter table leads add column if not exists kind text not null default 'optin';

-- Attribution as recorded on the booking. utm_campaign carries the numeric
-- Meta campaign ID, which is the exact join back to spend.
alter table leads add column if not exists utm_campaign text;
alter table leads add column if not exists utm_medium   text;
alter table leads add column if not exists utm_source   text;

-- Whether an attendance outcome was recorded at all, as distinct from a
-- recorded no-show. The column is blank on all but one booking, so without
-- this the dashboard would report a ~0% attendance rate as if it were real.
alter table leads add column if not exists attendance_recorded boolean not null default false;

-- How a booking arrived: 'paid-attributed' (tied to a campaign),
-- 'organic' (email, linktree, referral -- no campaign because there was no
-- ad), 'paid-unattributed' (an ad was involved but the tags did not say
-- which), or 'unknown'. Without this split, organic bookings inflate what
-- looks like an attribution failure and hide how much of the funnel is
-- unpaid.
alter table leads add column if not exists channel text;

-- What hour (0-23) a booking was created, read straight off the digits in
-- the sheet's timestamp cell -- see extractHourFromRaw in lib/sources.js.
-- Null on rows where that cell only ever held a date, with no time. Powers
-- the booking-time heatmap; nothing downstream needs this for optins.
alter table leads add column if not exists generated_hour smallint;
