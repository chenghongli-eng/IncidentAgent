package com.example.target;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private static final Logger log = LoggerFactory.getLogger(OrderService.class);

    private final JdbcTemplate jdbc;
    private final DownstreamClient downstream;

    public OrderService(JdbcTemplate jdbc, DownstreamClient downstream) {
        this.jdbc = jdbc;
        this.downstream = downstream;
    }

    public Map<String, Object> loadOrder(long orderId) {
        Map<String, Object> order = jdbc.queryForMap(
                "select id, user_id, amount, create_time from orders where id = ?", orderId);

        long userId = ((Number) order.get("USER_ID")).longValue();
        Map<String, Object> profile = downstream.fetchProfile(userId);

        if (profile == null) {
            order.put("ship_to", "UNKNOWN");
        } else {
            order.put("ship_to", profile.get("address"));
        }

        log.info("order {} loaded for user {}", orderId, userId);
        return order;
    }
}