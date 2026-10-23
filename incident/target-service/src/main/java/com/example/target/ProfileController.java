package com.example.target;

import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

/** Stands in for the user-profile service so the target has a real downstream dependency. */
@RestController
public class ProfileController {

    private final JdbcTemplate jdbc;

    public ProfileController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/profiles/{userId}")
    public ResponseEntity<Map<String, Object>> get(@PathVariable long userId) {
        Integer count = jdbc.queryForObject(
                "select count(*) from profiles where id = ?", Integer.class, userId);
        if (count == null || count == 0) {
            return ResponseEntity.notFound().build();
        }
        Map<String, Object> profile = new LinkedHashMap<>();
        profile.put("id", userId);
        profile.put("address", "Building " + userId + ", Shanghai");
        return ResponseEntity.ok(profile);
    }
}