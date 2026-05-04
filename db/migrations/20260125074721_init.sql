-- migrate:up
create schema if not exists extensions;
create extension if not exists "uuid-ossp" schema extensions;

-- Users table
create table users (
    id uuid primary key default extensions.uuid_generate_v4(),
    username varchar(32) unique not null,
    password text not null,
    created_at timestamptz default current_timestamp,
    updated_at timestamptz default current_timestamp,
    active boolean default true
);

-- migrate:down
drop table if exists users;
drop schema if exists extensions cascade;
