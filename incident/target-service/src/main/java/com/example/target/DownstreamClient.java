package com.example.target;

import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;

/** Calls the user-profile service. Returns null when the profile does not exist. */
@Component
public class DownstreamClient {

    private static final Logger log = LoggerFactory.getLogger(DownstreamClient.class);

    private final RestTemplate rest;
    private final String baseUrl;

    public DownstreamClient(
            RestTemplate rest,
            @Value("${app.downstream.base-url}") String baseUrl) {
        this.rest = rest;
        this.baseUrl = baseUrl;
    }

    public Map<String, Object> fetchProfile(long userId) {
        try {
            ResponseEntity<Map> res = rest.getForEntity(baseUrl + "/profiles/" + userId, Map.class);
            if (res.getStatusCode().is2xxSuccessful()) {
                return res.getBody();
            }
            log.warn("profile lookup returned status={} userId={}", res.getStatusCode(), userId);
            return null;
        } catch (Exception ex) {
            log.error("profile lookup failed userId={} cause={}", userId, ex.toString());
            return null;
        }
    }
}