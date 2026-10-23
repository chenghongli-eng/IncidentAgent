create table if not exists profiles (
    id      bigint primary key,
    address varchar(255)
);

create table if not exists orders (
    id          bigint primary key,
    user_id     bigint not null,
    amount      decimal(12, 2),
    create_time timestamp not null
);

-- Fault F1 removes this index to produce a slow-query regression.
create index if not exists idx_orders_create_time on orders (create_time);