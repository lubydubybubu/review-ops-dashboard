-- One-time bootstrap for a DEDICATED Ops database on an existing PostgreSQL cluster.
-- Run by the cluster administrator with psql (never by the app):
--
--   psql -v owner_password="$(cat owner.pw)" -v app_password="$(cat app.pw)" -f db/bootstrap/001-roles-and-database.sql
--
-- Passwords come from psql variables (files outside the repo), never from this file or shell history.
-- Afterwards: the migrate job (ops_owner) creates the schema; the app connects only as ops_app.

\set ON_ERROR_STOP on

-- Schema owner: used only by the one-shot migrate job.
create role ops_owner login password :'owner_password'
  nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 2;

-- Runtime role: DML only (granted per table by `db:migrate -- --grant ops_app`), owns nothing.
create role ops_app login password :'app_password'
  nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls connection limit 20;
alter role ops_app set statement_timeout = '15s';
alter role ops_app set idle_in_transaction_session_timeout = '30s';

create database review_ops owner ops_owner encoding 'UTF8' template template0;
revoke all on database review_ops from public;
grant connect on database review_ops to ops_owner, ops_app;

\connect review_ops
-- Nobody but the owner may create objects in public.
revoke create on schema public from public;
alter schema public owner to ops_owner;
grant usage on schema public to ops_app;
