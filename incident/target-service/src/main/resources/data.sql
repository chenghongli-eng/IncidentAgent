-- Seed data. Order 2 references user 9999, which has no profile row.
insert into profiles (id, address) values (1, 'Building 1, Shanghai');
insert into profiles (id, address) values (3, 'Building 3, Shanghai');
insert into profiles (id, address) values (4, 'Building 4, Shanghai');
insert into profiles (id, address) values (5, 'Building 5, Shanghai');

insert into orders (id, user_id, amount, create_time) values (1, 1, 99.00, timestamp '2026-10-20 14:00:00');
insert into orders (id, user_id, amount, create_time) values (2, 9999, 128.00, timestamp '2026-10-20 14:00:00');
insert into orders (id, user_id, amount, create_time) values (3, 3, 45.00, timestamp '2026-10-20 14:00:00');
insert into orders (id, user_id, amount, create_time) values (4, 4, 210.00, timestamp '2026-10-20 14:00:00');
insert into orders (id, user_id, amount, create_time) values (5, 5, 76.50, timestamp '2026-10-20 14:00:00');